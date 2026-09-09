#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import os from "node:os";
import path from "node:path";
import { OrgStore, OrgError } from "./store.js";

const ORG_DIR = process.env.ORG_MCP_DIR
  ? path.resolve(process.env.ORG_MCP_DIR)
  : path.join(os.homedir(), "org-mcp-data");
const DEFAULT_FILE = process.env.ORG_MCP_DEFAULT_FILE || "inbox.org";

const store = new OrgStore(ORG_DIR);

const server = new McpServer({
  name: "org-mcp",
  version: "0.1.0",
});

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

// A factory, not a shared instance: reusing one Zod object across fields makes the
// generated JSON Schema emit $refs between them, which some MCP clients handle poorly.
const dateField = () =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?$/, "Expected YYYY-MM-DD or 'YYYY-MM-DD HH:MM'");

const TODO_ENUM = ["TODO", "NEXT", "IN-PROGRESS", "WAITING"] as const;
const STATE_ENUM = ["TODO", "NEXT", "IN-PROGRESS", "WAITING", "DONE", "CANCELLED"] as const;

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
    description: "List the org files currently tracked in the org data directory.",
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

async function main() {
  await store.init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`org-mcp: serving org files from ${ORG_DIR}`);
}

main().catch((err) => {
  console.error("org-mcp failed to start:", err);
  process.exit(1);
});
