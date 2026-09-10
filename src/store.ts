import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseOrgFile,
  buildHeadlineLine,
  buildPlanningLine,
  buildPropertiesDrawer,
  type ParsedEntry,
} from "./orgFile.js";
import { isDoneKeyword, OPEN_KEYWORDS } from "./orgModel.js";
import type { OrgEntry } from "./orgModel.js";
import {
  parseInputDate,
  formatOrgTimestamp,
  nowStamp,
  todayStr,
  compareDates,
} from "./orgDate.js";

export class OrgError extends Error {}

const FILENAME_RE = /^[\w.-]+\.org$/;

function priorityRank(p: "A" | "B" | "C" | null): number {
  if (p === "A") return 0;
  if (p === "B") return 1;
  if (p === "C") return 2;
  return 3;
}

export interface CaptureParams {
  file?: string;
  headline: string;
  todo?: string | null;
  priority?: "A" | "B" | "C" | null;
  tags?: string[];
  scheduled?: string | null;
  deadline?: string | null;
  body?: string | null;
  parentId?: string | null;
}

export interface AgendaItem {
  reason: "scheduled" | "deadline" | "scheduled-overdue" | "deadline-overdue";
  date: string;
  entry: CleanEntry;
}

export type CleanEntry = OrgEntry;

function cleanEntry(e: ParsedEntry): CleanEntry {
  const {
    startLine,
    endLine,
    headlineLine,
    planningLine,
    propertiesStart,
    propertiesEnd,
    bodyStart,
    bodyEnd,
    scheduledRaw,
    deadlineRaw,
    closedRaw,
    ...rest
  } = e;
  return rest;
}

export class OrgStore {
  constructor(private dir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  get directory(): string {
    return this.dir;
  }

  private resolvePath(filename: string): string {
    if (!FILENAME_RE.test(filename)) {
      throw new OrgError(
        `Invalid filename "${filename}". Filenames must match [\\w.-]+.org (no path separators).`
      );
    }
    return path.join(this.dir, filename);
  }

  private locks = new Map<string, Promise<unknown>>();

  private async withFileLock<T>(filename: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(filename) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.locks.set(
      filename,
      prev.then(() => next)
    );
    await prev;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  private async readLines(filename: string): Promise<string[]> {
    const p = this.resolvePath(filename);
    try {
      const content = await fs.readFile(p, "utf8");
      return content.split("\n");
    } catch (err: any) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }

  private async writeLines(filename: string, lines: string[]): Promise<void> {
    const p = this.resolvePath(filename);
    let content = lines.join("\n");
    if (!content.endsWith("\n")) content += "\n";
    await fs.writeFile(p, content, "utf8");
  }

  /** Lists tracked org files. Archive files (ending in _archive.org) are excluded unless requested. */
  async listFiles(includeArchive = false): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".org"))
      .filter((n) => includeArchive || !n.endsWith("_archive.org"))
      .sort();
  }

  private archiveFileFor(filename: string): string {
    return filename.replace(/\.org$/, "_archive.org");
  }

  async capture(params: CaptureParams): Promise<CleanEntry> {
    const headline = params.headline?.trim();
    if (!headline) throw new OrgError("headline is required and cannot be empty.");
    if (params.todo && !(OPEN_KEYWORDS as readonly string[]).includes(params.todo)) {
      throw new OrgError(
        `Invalid todo keyword "${params.todo}". Use one of: ${OPEN_KEYWORDS.join(", ")}.`
      );
    }

    let filename = params.file ?? "inbox.org";
    if (!filename.endsWith(".org")) filename += ".org";

    if (params.parentId) {
      const found = await this.findEntryById(params.parentId);
      if (!found) throw new OrgError(`No entry found with id "${params.parentId}".`);
      filename = found.filename;
    }

    return this.withFileLock(filename, async () => {
      const lines = await this.readLines(filename);
      const entries = parseOrgFile(lines.join("\n"), filename);

      let level = 1;
      let insertAt = lines.length;
      let needsLeadingBlank: boolean;

      if (params.parentId) {
        const parent = entries.find((e) => e.id === params.parentId);
        if (!parent) throw new OrgError(`No entry found with id "${params.parentId}".`);
        level = parent.level + 1;
        insertAt = parent.endLine;
        needsLeadingBlank = false;
      } else {
        // Append at end of file: trim trailing blank lines, then re-add exactly one separator.
        while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
        needsLeadingBlank = insertAt > 0;
      }

      const id = randomUUID();
      const now = nowStamp();
      const scheduled = params.scheduled ? parseInputDate(params.scheduled) : null;
      const deadline = params.deadline ? parseInputDate(params.deadline) : null;
      const tags = (params.tags ?? [])
        .map((t) => t.replace(/[^\w@%#]/g, ""))
        .filter(Boolean);

      const entryLines: string[] = [];
      entryLines.push(
        buildHeadlineLine(level, params.todo ?? null, params.priority ?? null, headline, tags)
      );
      const planning = buildPlanningLine(
        scheduled ? formatOrgTimestamp(scheduled.date, scheduled.time, true) : null,
        deadline ? formatOrgTimestamp(deadline.date, deadline.time, true) : null
      );
      if (planning) entryLines.push(planning);
      entryLines.push(
        ...buildPropertiesDrawer({
          ID: id,
          CREATED: formatOrgTimestamp(now.date, now.time, false),
        })
      );
      if (params.body && params.body.trim()) {
        entryLines.push(...params.body.replace(/\r\n/g, "\n").split("\n"));
      }

      const toInsert = needsLeadingBlank ? ["", ...entryLines] : entryLines;
      lines.splice(insertAt, 0, ...toInsert);
      await this.writeLines(filename, lines);

      return {
        id,
        file: filename,
        level,
        todo: params.todo ?? null,
        priority: params.priority ?? null,
        headline,
        tags,
        scheduled,
        deadline,
        closed: null,
        properties: { ID: id, CREATED: formatOrgTimestamp(now.date, now.time, false) },
        body: params.body ?? "",
      };
    });
  }

  async findEntryById(
    id: string,
    opts: { includeArchive?: boolean } = {}
  ): Promise<{ entry: ParsedEntry; filename: string } | null> {
    const files = await this.listFiles(opts.includeArchive ?? false);
    for (const filename of files) {
      const lines = await this.readLines(filename);
      const entries = parseOrgFile(lines.join("\n"), filename);
      const match = entries.find((e) => e.id === id);
      if (match) return { entry: match, filename };
    }
    return null;
  }

  async getEntry(id: string): Promise<CleanEntry | null> {
    const found = await this.findEntryById(id, { includeArchive: true });
    return found ? cleanEntry(found.entry) : null;
  }

  private setPlanningLine(lines: string[], entry: ParsedEntry, newLineText: string | null): void {
    if (entry.planningLine !== null) {
      if (newLineText !== null) {
        lines[entry.planningLine] = newLineText;
      } else {
        lines.splice(entry.planningLine, 1);
      }
    } else if (newLineText !== null) {
      lines.splice(entry.headlineLine + 1, 0, newLineText);
    }
  }

  async updateState(id: string, newTodo: string | null): Promise<CleanEntry> {
    if (newTodo !== null && !(["TODO", "NEXT", "IN-PROGRESS", "WAITING", "DONE", "CANCELLED"] as string[]).includes(newTodo)) {
      throw new OrgError(`Invalid todo keyword "${newTodo}".`);
    }
    const found = await this.findEntryById(id);
    if (!found) throw new OrgError(`No entry found with id "${id}".`);
    const { filename } = found;

    return this.withFileLock(filename, async () => {
      const lines = await this.readLines(filename);
      const entries = parseOrgFile(lines.join("\n"), filename);
      const entry = entries.find((e) => e.id === id);
      if (!entry) throw new OrgError(`No entry found with id "${id}".`);

      lines[entry.headlineLine] = buildHeadlineLine(
        entry.level,
        newTodo,
        entry.priority,
        entry.headline,
        entry.tags
      );

      // Preserve SCHEDULED/DEADLINE text verbatim (repeaters, time ranges, etc.) — only
      // the CLOSED stamp is added or removed here.
      let closedText: string | null;
      if (isDoneKeyword(newTodo)) {
        const now = nowStamp();
        closedText = formatOrgTimestamp(now.date, now.time, false);
      } else {
        closedText = null;
      }
      const planning = buildPlanningLine(entry.scheduledRaw, entry.deadlineRaw, closedText);
      this.setPlanningLine(lines, entry, planning);

      await this.writeLines(filename, lines);
      const updated = parseOrgFile(lines.join("\n"), filename).find((e) => e.id === id)!;
      return cleanEntry(updated);
    });
  }

  async schedule(
    id: string,
    updates: { scheduled?: string | null; deadline?: string | null }
  ): Promise<CleanEntry> {
    const found = await this.findEntryById(id);
    if (!found) throw new OrgError(`No entry found with id "${id}".`);
    const { filename } = found;

    return this.withFileLock(filename, async () => {
      const lines = await this.readLines(filename);
      const entries = parseOrgFile(lines.join("\n"), filename);
      const entry = entries.find((e) => e.id === id);
      if (!entry) throw new OrgError(`No entry found with id "${id}".`);

      // Leaving a field unchanged (undefined) preserves its raw text verbatim (repeaters,
      // time ranges, etc.); only fields explicitly passed get reformatted from scratch.
      function resolve(input: string | null | undefined, raw: string | null): string | null {
        if (input === undefined) return raw;
        if (input === null) return null;
        const { date, time } = parseInputDate(input);
        return formatOrgTimestamp(date, time, true);
      }
      const scheduledText = resolve(updates.scheduled, entry.scheduledRaw);
      const deadlineText = resolve(updates.deadline, entry.deadlineRaw);
      const planning = buildPlanningLine(scheduledText, deadlineText, entry.closedRaw);
      this.setPlanningLine(lines, entry, planning);

      await this.writeLines(filename, lines);
      const updated = parseOrgFile(lines.join("\n"), filename).find((e) => e.id === id)!;
      return cleanEntry(updated);
    });
  }

  async addNote(id: string, note: string): Promise<CleanEntry> {
    const trimmed = note.trim();
    if (!trimmed) throw new OrgError("note cannot be empty.");
    const found = await this.findEntryById(id);
    if (!found) throw new OrgError(`No entry found with id "${id}".`);
    const { filename } = found;

    return this.withFileLock(filename, async () => {
      const lines = await this.readLines(filename);
      const entries = parseOrgFile(lines.join("\n"), filename);
      const entry = entries.find((e) => e.id === id);
      if (!entry) throw new OrgError(`No entry found with id "${id}".`);

      const now = nowStamp();
      const ts = formatOrgTimestamp(now.date, now.time, false);
      const noteLines = trimmed.split("\n");
      const rendered = [`  - Note taken on ${ts} :: ${noteLines[0]}`, ...noteLines.slice(1).map((l) => `    ${l}`)];
      lines.splice(entry.bodyEnd, 0, ...rendered);

      await this.writeLines(filename, lines);
      const updated = parseOrgFile(lines.join("\n"), filename).find((e) => e.id === id)!;
      return cleanEntry(updated);
    });
  }

  async archiveEntry(id: string): Promise<{ id: string; archivedTo: string }> {
    const found = await this.findEntryById(id);
    if (!found) throw new OrgError(`No entry found with id "${id}".`);
    const { filename } = found;
    const archiveFile = this.archiveFileFor(filename);

    return this.withFileLock(filename, async () => {
      const lines = await this.readLines(filename);
      const entries = parseOrgFile(lines.join("\n"), filename);
      const entry = entries.find((e) => e.id === id);
      if (!entry) throw new OrgError(`No entry found with id "${id}".`);

      const subtreeLines = lines.slice(entry.startLine, entry.endLine);
      lines.splice(entry.startLine, entry.endLine - entry.startLine);
      // Clean up a stray blank line left at the removal point.
      if (entry.startLine === 0) {
        while (lines.length > 0 && lines[0].trim() === "") lines.shift();
      } else {
        while (
          entry.startLine < lines.length &&
          lines[entry.startLine]?.trim() === "" &&
          lines[entry.startLine - 1]?.trim() === ""
        ) {
          lines.splice(entry.startLine, 1);
        }
      }
      await this.writeLines(filename, lines);

      await this.withFileLock(archiveFile, async () => {
        const archiveLines = await this.readLines(archiveFile);
        const insertAt = archiveLines.length;
        const needsBlank = archiveLines.some((l) => l.trim() !== "");
        const toAppend = needsBlank ? ["", ...subtreeLines] : subtreeLines;
        archiveLines.splice(insertAt, 0, ...toAppend);
        await this.writeLines(archiveFile, archiveLines);
      });

      return { id, archivedTo: archiveFile };
    });
  }

  /**
   * Assigns a fresh :ID: to any entry in `filename` that lacks one (e.g. hand-written
   * in an editor), so it becomes addressable by later tool calls — mirroring org-id's
   * lazy id-on-first-access behavior. No-op, and no write, if every entry already has one.
   */
  private async ensureIds(filename: string): Promise<void> {
    const lines = await this.readLines(filename);
    if (lines.length === 0) return;
    const entries = parseOrgFile(lines.join("\n"), filename);
    const missing = entries.filter((e) => e.id === null);
    if (missing.length === 0) return;

    // Insert bottom-to-top so earlier entries' line offsets stay valid as we go.
    for (const entry of [...missing].sort((a, b) => b.headlineLine - a.headlineLine)) {
      const id = randomUUID();
      if (entry.propertiesStart !== null) {
        lines.splice(entry.propertiesStart + 1, 0, `  :ID: ${id}`);
      } else {
        const insertAt = entry.planningLine !== null ? entry.planningLine + 1 : entry.headlineLine + 1;
        lines.splice(insertAt, 0, ...buildPropertiesDrawer({ ID: id }));
      }
    }
    await this.writeLines(filename, lines);
  }

  private async allEntries(includeArchive = false): Promise<ParsedEntry[]> {
    const files = await this.listFiles(includeArchive);
    const out: ParsedEntry[] = [];
    for (const filename of files) {
      await this.withFileLock(filename, () => this.ensureIds(filename));
      const lines = await this.readLines(filename);
      out.push(...parseOrgFile(lines.join("\n"), filename));
    }
    return out;
  }

  /** Reads the raw text of one tracked org file, e.g. for showing the user their actual file. */
  async readFile(filename: string): Promise<string> {
    const files = await this.listFiles(true);
    if (!files.includes(filename)) {
      throw new OrgError(`No such org file "${filename}". Tracked files: ${files.join(", ") || "(none)"}.`);
    }
    return (await this.readLines(filename)).join("\n");
  }

  async listTodos(filter: { state?: string; tag?: string; priority?: "A" | "B" | "C" } = {}): Promise<CleanEntry[]> {
    const entries = await this.allEntries();
    let result = entries.filter((e) => e.todo !== null);
    if (filter.state) {
      result = result.filter((e) => e.todo === filter.state);
    } else {
      result = result.filter((e) => (OPEN_KEYWORDS as readonly string[]).includes(e.todo!));
    }
    if (filter.tag) result = result.filter((e) => e.tags.includes(filter.tag!));
    if (filter.priority) result = result.filter((e) => e.priority === filter.priority);

    result.sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      const da = a.deadline?.date ?? a.scheduled?.date ?? "9999-99-99";
      const db = b.deadline?.date ?? b.scheduled?.date ?? "9999-99-99";
      if (da !== db) return da < db ? -1 : 1;
      return a.headline.localeCompare(b.headline);
    });

    return result.map(cleanEntry);
  }

  async search(query: string, opts: { tag?: string; includeArchive?: boolean } = {}): Promise<CleanEntry[]> {
    const q = query.trim().toLowerCase();
    if (!q) throw new OrgError("query cannot be empty.");
    const entries = await this.allEntries(opts.includeArchive ?? false);
    let result = entries.filter(
      (e) =>
        e.headline.toLowerCase().includes(q) ||
        e.body.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q))
    );
    if (opts.tag) result = result.filter((e) => e.tags.includes(opts.tag!));
    return result.map(cleanEntry);
  }

  async agenda(
    start: string = todayStr(),
    end: string = start,
    includeDone = false
  ): Promise<AgendaItem[]> {
    parseInputDate(start);
    parseInputDate(end);
    if (compareDates(start, end) > 0) {
      throw new OrgError(`start date (${start}) must not be after end date (${end}).`);
    }
    const today = todayStr();
    const entries = await this.allEntries();
    const items: AgendaItem[] = [];

    for (const e of entries) {
      const done = isDoneKeyword(e.todo);
      if (e.scheduled) {
        const d = e.scheduled.date;
        if (compareDates(d, start) >= 0 && compareDates(d, end) <= 0) {
          if (!done || includeDone) items.push({ reason: "scheduled", date: d, entry: cleanEntry(e) });
        } else if (!done && compareDates(d, start) < 0 && compareDates(start, today) <= 0) {
          items.push({ reason: "scheduled-overdue", date: d, entry: cleanEntry(e) });
        }
      }
      if (e.deadline) {
        const d = e.deadline.date;
        if (compareDates(d, start) >= 0 && compareDates(d, end) <= 0) {
          if (!done || includeDone) items.push({ reason: "deadline", date: d, entry: cleanEntry(e) });
        } else if (!done && compareDates(d, start) < 0 && compareDates(start, today) <= 0) {
          items.push({ reason: "deadline-overdue", date: d, entry: cleanEntry(e) });
        }
      }
    }

    items.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const pr = priorityRank(a.entry.priority) - priorityRank(b.entry.priority);
      if (pr !== 0) return pr;
      return a.entry.headline.localeCompare(b.entry.headline);
    });

    return items;
  }
}
