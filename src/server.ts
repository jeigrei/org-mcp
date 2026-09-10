#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { OrgStore, OrgError } from "./store.js";
import { createAccessVerifier, sanitizeUserId, type AccessIdentity } from "./cfAccess.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      orgUser?: AccessIdentity;
    }
  }
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const HOST = process.env.HOST || "127.0.0.1";
const BASE_DIR = process.env.ORG_MCP_DIR
  ? path.resolve(process.env.ORG_MCP_DIR)
  : path.join(os.homedir(), "org-mcp-data");
const DEFAULT_FILE = process.env.ORG_MCP_DEFAULT_FILE || "inbox.org";
const CF_ACCESS_TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN;
const CF_ACCESS_AUD = process.env.CF_ACCESS_AUD;

if ((CF_ACCESS_TEAM_DOMAIN && !CF_ACCESS_AUD) || (!CF_ACCESS_TEAM_DOMAIN && CF_ACCESS_AUD)) {
  console.error(
    "org-mcp: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set together. " +
      "Set both to enable Cloudflare Access auth, or neither to run in local dev mode."
  );
  process.exit(1);
}

const accessVerifier =
  CF_ACCESS_TEAM_DOMAIN && CF_ACCESS_AUD
    ? createAccessVerifier(CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD)
    : null;

if (!accessVerifier) {
  console.warn(
    "org-mcp: CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD not set — running WITHOUT Cloudflare Access " +
      'verification. Identity is taken from the unauthenticated "X-Org-User" header (default ' +
      '"default"). This is fine for local development but must never be reachable from outside ' +
      "this machine."
  );
  if (HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1") {
    console.warn(
      `org-mcp: WARNING — binding to ${HOST} with no Cloudflare Access auth configured. ` +
        "Anyone who can reach this host can read and write anyone's org data."
    );
  }
}

// --- Auth middleware: resolves req.orgUser from Cloudflare Access, or a dev-mode header. ---

async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!accessVerifier) {
    const devUser = (req.header("x-org-user") || "default").toString();
    try {
      req.orgUser = { id: sanitizeUserId(devUser), label: devUser };
      next();
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  const token = req.header("cf-access-jwt-assertion");
  if (!token) {
    res.status(401).json({ error: "Missing Cf-Access-Jwt-Assertion header (request did not come through Cloudflare Access)." });
    return;
  }
  try {
    req.orgUser = await accessVerifier(token);
    next();
  } catch (err) {
    res.status(401).json({ error: `Invalid Cloudflare Access token: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// --- Per-user OrgStore cache. Every session for the same user shares one instance, so its
// in-memory per-file write locks actually serialize concurrent sessions correctly. ---

const storesByUser = new Map<string, OrgStore>();

async function getStoreForUser(userId: string): Promise<OrgStore> {
  let store = storesByUser.get(userId);
  if (!store) {
    store = new OrgStore(path.join(BASE_DIR, userId));
    await store.init();
    storesByUser.set(userId, store);
  }
  return store;
}

// --- MCP server factory: builds a fresh McpServer with all org-mcp tools bound to one
// user's OrgStore. Called once per session (see the /mcp handlers below). ---

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

const dateField = () =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?$/, "Expected YYYY-MM-DD or 'YYYY-MM-DD HH:MM'");

const TODO_ENUM = ["TODO", "NEXT", "IN-PROGRESS", "WAITING"] as const;
const STATE_ENUM = ["TODO", "NEXT", "IN-PROGRESS", "WAITING", "DONE", "CANCELLED"] as const;

function buildServer(store: OrgStore): McpServer {
  const server = new McpServer({ name: "org-mcp", version: "0.2.0" });

  server.registerTool(
    "org_capture",
    {
      title: "Capture a new org entry",
      description:
        `Append a new entry (headline) to a local org file, org-capture style. ` +
        `Use this to jot down tasks, notes, or events. Defaults to file "${DEFAULT_FILE}" if none given. ` +
        `Pass parent_id to nest the new entry under an existing entry instead of appending at top level.`,
      inputSchema: {
        headline: z.string().describe("The entry title (no stars, state, or tags)."),
        file: z
          .string()
          .optional()
          .describe(`Target org filename within the org directory, e.g. "inbox.org" or "projects.org". Defaults to "${DEFAULT_FILE}".`),
        todo: z
          .enum(TODO_ENUM)
          .nullish()
          .describe("TODO keyword, omit for a plain note/heading."),
        priority: z.enum(["A", "B", "C"]).nullish().describe("Priority cookie."),
        tags: z.array(z.string()).optional().describe("Org tags, without colons."),
        scheduled: dateField().nullish().describe("SCHEDULED date/time for the entry."),
        deadline: dateField().nullish().describe("DEADLINE date/time for the entry."),
        body: z.string().optional().describe("Free-text notes/body under the headline."),
        parent_id: z.string().optional().describe("ID of an existing entry to nest this one under."),
      },
    },
    async (args) => {
      try {
        const entry = await store.capture({
          file: args.file,
          headline: args.headline,
          todo: args.todo ?? null,
          priority: args.priority ?? null,
          tags: args.tags,
          scheduled: args.scheduled ?? null,
          deadline: args.deadline ?? null,
          body: args.body ?? null,
          parentId: args.parent_id ?? null,
        });
        return ok(entry);
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "org_agenda",
    {
      title: "Agenda view",
      description:
        "Get an org-agenda style view: entries scheduled or due within a date range, plus overdue " +
        "open items when the range covers today. Defaults to today only. Entries with neither " +
        "SCHEDULED nor DEADLINE never appear here — use org_list_todos for unscheduled open work.",
      inputSchema: {
        start: dateField().optional().describe("Range start date (YYYY-MM-DD). Defaults to today."),
        end: dateField().optional().describe("Range end date (YYYY-MM-DD). Defaults to start."),
        include_done: z.boolean().optional().describe("Include DONE/CANCELLED entries. Default false."),
      },
    },
    async (args) => {
      try {
        const items = await store.agenda(args.start, args.end, args.include_done ?? false);
        return ok(items);
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "org_list_todos",
    {
      title: "List TODO entries",
      description:
        "List open TODO-like entries across all org files (excludes DONE/CANCELLED by default), " +
        "sorted by priority then due date. Optionally filter by exact state, tag, or priority.",
      inputSchema: {
        state: z.enum(STATE_ENUM).optional().describe("Filter to an exact TODO keyword."),
        tag: z.string().optional().describe("Filter to entries carrying this tag."),
        priority: z.enum(["A", "B", "C"]).optional().describe("Filter to this priority."),
      },
    },
    async (args) => {
      try {
        const items = await store.listTodos(args);
        return ok(items);
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "org_search",
    {
      title: "Search entries",
      description: "Full-text search across headlines, body text, and tags in all org files.",
      inputSchema: {
        query: z.string().describe("Case-insensitive substring to search for."),
        tag: z.string().optional().describe("Also require this tag."),
        include_archive: z.boolean().optional().describe("Also search archived entries. Default false."),
      },
    },
    async (args) => {
      try {
        const items = await store.search(args.query, {
          tag: args.tag,
          includeArchive: args.include_archive ?? false,
        });
        return ok(items);
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "org_get_entry",
    {
      title: "Get a single entry",
      description: "Fetch full details of one entry by its id, including its body text.",
      inputSchema: {
        id: z.string().describe("The entry's id (returned by capture/agenda/search/etc.)."),
      },
    },
    async (args) => {
      try {
        const entry = await store.getEntry(args.id);
        if (!entry) return fail(new OrgError(`No entry found with id "${args.id}".`));
        return ok(entry);
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "org_update_state",
    {
      title: "Change an entry's TODO state",
      description:
        "Change the TODO keyword of an entry, e.g. mark it DONE, TODO, NEXT, WAITING, or CANCELLED. " +
        "Moving into DONE/CANCELLED stamps a CLOSED timestamp; moving out of one clears it.",
      inputSchema: {
        id: z.string().describe("The entry's id."),
        state: z.enum(STATE_ENUM).nullable().describe("New TODO keyword, or null to remove the keyword entirely."),
      },
    },
    async (args) => {
      try {
        const entry = await store.updateState(args.id, args.state);
        return ok(entry);
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "org_schedule",
    {
      title: "Set SCHEDULED/DEADLINE",
      description:
        "Set, change, or clear the SCHEDULED and/or DEADLINE timestamps on an entry. " +
        "Omit a field to leave it unchanged; pass null to clear it.",
      inputSchema: {
        id: z.string().describe("The entry's id."),
        scheduled: dateField().nullish().describe("New SCHEDULED date/time, or null to clear."),
        deadline: dateField().nullish().describe("New DEADLINE date/time, or null to clear."),
      },
    },
    async (args) => {
      try {
        const entry = await store.schedule(args.id, {
          scheduled: args.scheduled,
          deadline: args.deadline,
        });
        return ok(entry);
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "org_add_note",
    {
      title: "Add a timestamped note",
      description: "Append a timestamped note/log line to an existing entry's body.",
      inputSchema: {
        id: z.string().describe("The entry's id."),
        note: z.string().describe("Note text to append."),
      },
    },
    async (args) => {
      try {
        const entry = await store.addNote(args.id, args.note);
        return ok(entry);
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "org_archive_entry",
    {
      title: "Archive an entry",
      description:
        "Move an entry (and its subtree) out of its source file into a companion `<file>_archive.org` file. " +
        "Use this to clean up completed or stale items while keeping a record.",
      inputSchema: {
        id: z.string().describe("The entry's id."),
      },
    },
    async (args) => {
      try {
        const result = await store.archiveEntry(args.id);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "org_read_file",
    {
      title: "Read a raw org file",
      description:
        "Read the raw text of one tracked org file, exactly as it is on disk. Useful for showing " +
        "the user their actual file, including any hand-edited content the structured tools don't surface.",
      inputSchema: {
        file: z.string().describe(`Filename to read, e.g. "inbox.org". See org_list_files for available files.`),
      },
    },
    async (args) => {
      try {
        const content = await store.readFile(args.file);
        return ok({ file: args.file, content });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "org_list_files",
    {
      title: "List org files",
      description: "List the org files currently tracked in this user's org data directory.",
      inputSchema: {
        include_archive: z.boolean().optional().describe("Also list archive files. Default false."),
      },
    },
    async (args) => {
      try {
        const files = await store.listFiles(args.include_archive ?? false);
        return ok({ directory: store.directory, files });
      } catch (err) {
        return fail(err);
      }
    }
  );

  return server;
}

// --- HTTP wiring: one Streamable HTTP session per MCP client connection, each bound at
// creation time to the requesting user's OrgStore. ---

interface Session {
  transport: StreamableHTTPServerTransport;
  userId: string;
}

const sessions = new Map<string, Session>();

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use("/mcp", authenticate);

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.header("mcp-session-id");
  const user = req.orgUser!;

  try {
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        });
        return;
      }
      if (session.userId !== user.id) {
        res.status(403).json({
          jsonrpc: "2.0",
          error: { code: -32002, message: "Session belongs to a different identity" },
          id: null,
        });
        return;
      }
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    const store = await getStoreForUser(user.id);
    const server = buildServer(store);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, userId: user.id });
        console.error(`org-mcp: session ${sid} started for user "${user.label}" (${user.id})`);
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("org-mcp: error handling POST /mcp:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.header("mcp-session-id");
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  if (session.userId !== req.orgUser!.id) {
    res.status(403).send("Session belongs to a different identity");
    return;
  }
  await session.transport.handleRequest(req, res);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

const httpServer = app.listen(PORT, HOST, () => {
  console.error(`org-mcp: listening on http://${HOST}:${PORT}/mcp`);
  console.error(`org-mcp: org data root is ${BASE_DIR} (one subdirectory per user)`);
  console.error(
    accessVerifier
      ? `org-mcp: Cloudflare Access verification enabled for team "${CF_ACCESS_TEAM_DOMAIN}"`
      : `org-mcp: Cloudflare Access verification DISABLED (dev mode)`
  );
});

async function shutdown() {
  console.error("org-mcp: shutting down, closing active sessions...");
  for (const [sid, session] of sessions) {
    try {
      await session.transport.close();
    } catch (err) {
      console.error(`org-mcp: error closing session ${sid}:`, err);
    }
  }
  sessions.clear();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
