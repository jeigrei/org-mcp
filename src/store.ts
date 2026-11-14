import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
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

/** Strips characters org can't carry in a tag, and drops anything left empty. */
function sanitizeTags(tags: readonly string[] | undefined): string[] {
  return (tags ?? []).map((t) => t.replace(/[^\w@%#]/g, "")).filter(Boolean);
}

/**
 * Removes lines [start, end) and collapses the blank line the removal would otherwise
 * strand between two entries.
 */
function spliceSubtree(lines: string[], start: number, end: number): string[] {
  const removed = lines.slice(start, end);
  lines.splice(start, end - start);
  if (start === 0) {
    while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  } else {
    while (
      start < lines.length &&
      lines[start]?.trim() === "" &&
      lines[start - 1]?.trim() === ""
    ) {
      lines.splice(start, 1);
    }
  }
  return removed;
}

/** Rewrites the leading stars of every headline in `subtree` by `delta` levels. */
function shiftSubtreeLevels(subtree: string[], delta: number): string[] {
  if (delta === 0) return subtree;
  return subtree.map((line) => {
    const m = line.match(/^(\*+)(\s.*)$/);
    if (!m) return line;
    return "*".repeat(m[1].length + delta) + m[2];
  });
}

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

export interface EntryFilter {
  state?: string;
  tag?: string;
  priority?: "A" | "B" | "C";
  file?: string;
  parentId?: string;
}

export function filterEntries<T extends OrgEntry>(entries: T[], filter: EntryFilter = {}): T[] {
  const targetFile = filter.file
    ? filter.file.endsWith(".org")
      ? filter.file
      : `${filter.file}.org`
    : undefined;

  return entries.filter((e) => {
    if (filter.state !== undefined && e.todo !== filter.state) return false;
    if (filter.tag !== undefined && !e.tags.includes(filter.tag)) return false;
    if (filter.priority !== undefined && e.priority !== filter.priority) return false;
    if (targetFile !== undefined && e.file !== targetFile) return false;
    if (filter.parentId !== undefined && !e.path.some((seg) => seg.id === filter.parentId)) {
      return false;
    }
    return true;
  });
}

export interface AgendaItem {
  reason: "scheduled" | "deadline" | "scheduled-overdue" | "deadline-overdue";
  date: string;
  entry: CleanEntry;
}

export interface OutlineParams {
  file?: string;
  rootId?: string;
  level?: number;
  maxDepth?: number;
}

export interface OutlineNode {
  id: string | null;
  headline: string;
  file: string;
  level: number;
  todo: string | null;
  tags: string[];
  descendantCounts: Record<string, number>;
  children: OutlineNode[];
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

export interface OrgStoreOptions {
  /** Optional hook invoked after temp file write/fsync and .bak copy, immediately before rename. */
  beforeRename?: (tmpPath: string, targetPath: string) => Promise<void> | void;
}

export interface AtomicWriteOptions extends OrgStoreOptions {
  /**
   * If provided, verify `targetPath`'s current SHA-256 hash (or `null` if absent)
   * matches immediately before `fs.rename`; on mismatch, abort, clean up the temp
   * file, and return `false`.
   */
  expectedHash?: string | null;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const TMP_HANDLE_RE = /^tmp:([\w.-]+\.org):(\d+):([0-9a-f]{12})$/;

function hashTmpHandle(fileHash: string, line: number, headline: string): string {
  return createHash("sha256")
    .update(`${fileHash}\0${line}\0${headline}`, "utf8")
    .digest("hex")
    .slice(0, 12);
}

function parseTmpHandle(
  id: string
): { filename: string; line: number; hash: string } | null {
  const m = id.match(TMP_HANDLE_RE);
  if (!m) return null;
  const line = Number.parseInt(m[2], 10);
  if (!Number.isSafeInteger(line) || line < 1) return null;
  return { filename: m[1], line, hash: m[3] };
}

function withTemporaryHandles(entries: ParsedEntry[], fileHash: string): ParsedEntry[] {
  const openHeadings: { level: number; id: string; headline: string }[] = [];
  return entries.map((e) => {
    while (openHeadings.length > 0 && openHeadings[openHeadings.length - 1].level >= e.level) {
      openHeadings.pop();
    }
    const tmpHandle = `tmp:${e.file}:${e.headlineLine + 1}:${hashTmpHandle(
      fileHash,
      e.headlineLine + 1,
      e.headline
    )}`;
    const id = e.id ?? tmpHandle;
    const parentId =
      openHeadings.length > 0 ? openHeadings[openHeadings.length - 1].id : null;
    const path = openHeadings.map(({ id: segId, headline }) => ({ id: segId, headline }));
    openHeadings.push({ level: e.level, id, headline: e.headline });
    return { ...e, id, parentId, path };
  });
}

function resolveTmpHandleInLines(
  lines: string[],
  tmp: { filename: string; line: number; hash: string },
  fileHash: string
): ParsedEntry | null {
  const parsed = parseOrgFile(lines.join("\n"), tmp.filename);
  const idx = parsed.findIndex((e) => e.headlineLine === tmp.line - 1);
  if (idx === -1) return null;
  const entry = parsed[idx];
  if (entry.id !== null) return null;
  if (hashTmpHandle(fileHash, tmp.line, entry.headline) !== tmp.hash) return null;
  return withTemporaryHandles(parsed, fileHash)[idx];
}

async function readFileHash(targetPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(targetPath, "utf8");
    return hashContent(content);
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Writes `content` to `targetPath` atomically: resolves symlinks so the write
 * updates the real target, writes to a temporary file in the real target's
 * directory, preserves existing file permissions, fsyncs, copies any existing
 * target to `<realTarget>.bak`, verifies `options.expectedHash` (if given)
 * directly before renaming, and renames the temporary file over the target.
 * Returns `false` if `expectedHash` did not match.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string,
  options?: AtomicWriteOptions
): Promise<boolean> {
  let resolvedTarget = targetPath;
  let existingMode: number | null = null;
  try {
    resolvedTarget = await fs.realpath(targetPath);
    const st = await fs.stat(resolvedTarget);
    existingMode = st.mode & 0o7777;
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    try {
      const lst = await fs.lstat(targetPath);
      if (lst.isSymbolicLink()) {
        throw new OrgError(
          `Cannot write "${targetPath}": symlink target is missing.`
        );
      }
    } catch (lstatErr: any) {
      if (lstatErr instanceof OrgError) throw lstatErr;
      if (lstatErr?.code !== "ENOENT") throw lstatErr;
    }
  }

  const dir = path.dirname(resolvedTarget);
  const base = path.basename(resolvedTarget);
  const tmpPath = path.join(dir, `.${base}.${randomUUID()}.tmp`);
  const bakPath = `${resolvedTarget}.bak`;

  const fh = await fs.open(tmpPath, "w");
  try {
    await fh.writeFile(content, "utf8");
    if (existingMode !== null) {
      await fh.chmod(existingMode);
    }
    await fh.sync();
    await fh.close();
  } catch (err) {
    await fh.close().catch(() => {});
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }

  try {
    try {
      await fs.copyFile(resolvedTarget, bakPath);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
    await options?.beforeRename?.(tmpPath, resolvedTarget);
    if (options?.expectedHash !== undefined) {
      const currentHash = await readFileHash(resolvedTarget);
      if (currentHash !== options.expectedHash) {
        await fs.unlink(tmpPath).catch(() => {});
        return false;
      }
    }
    await fs.rename(tmpPath, resolvedTarget);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }

  // Fsync the directory so the rename itself is durable across power loss.
  let dirFh: fs.FileHandle | undefined;
  try {
    dirFh = await fs.open(dir, "r");
    await dirFh.sync();
  } catch (err: any) {
    if (err?.code !== "EINVAL" && err?.code !== "EPERM" && err?.code !== "ENOTSUP") {
      throw err;
    }
  } finally {
    await dirFh?.close().catch(() => {});
  }
  return true;
}

export class OrgStore {
  constructor(private dir: string, private options?: OrgStoreOptions) {}

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
  private materializedTmpHandles = new Map<string, string>();

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

  /**
   * Locks several files at once. Always acquires in sorted order so that two operations
   * moving entries in opposite directions (a.org→b.org and b.org→a.org) can't deadlock.
   */
  private async withFileLocks<T>(filenames: string[], fn: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(filenames)].sort();
    const acquire = (i: number): Promise<T> =>
      i >= ordered.length ? fn() : this.withFileLock(ordered[i], () => acquire(i + 1));
    return acquire(0);
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

  private async readLinesWithHash(
    filename: string
  ): Promise<{ lines: string[]; hash: string | null }> {
    const p = this.resolvePath(filename);
    try {
      const content = await fs.readFile(p, "utf8");
      return { lines: content.split("\n"), hash: hashContent(content) };
    } catch (err: any) {
      if (err.code === "ENOENT") return { lines: [], hash: null };
      throw err;
    }
  }

  private async writeLines(
    filename: string,
    lines: string[],
    expectedHash?: string | null
  ): Promise<boolean> {
    const p = this.resolvePath(filename);
    let content = lines.join("\n");
    if (!content.endsWith("\n")) content += "\n";
    return atomicWriteFile(p, content, { ...this.options, expectedHash });
  }

  /** Hook for tests to simulate an external editor save immediately before the pre-write check. */
  protected async beforeWriteCheck(_filename: string): Promise<void> {}

  private async writeLinesIfUnchanged(
    filename: string,
    lines: string[],
    expectedHash: string | null
  ): Promise<boolean> {
    await this.beforeWriteCheck(filename);
    return this.writeLines(filename, lines, expectedHash);
  }

  /**
   * Runs a single-file mutation under the per-file lock with optimistic external-change
   * detection: if the file changes on disk between read and write, re-reads and re-applies
   * once; if it changes again, throws OrgError instead of overwriting the external edit.
   */
  private async mutateFile<T>(
    filename: string,
    apply: (lines: string[]) => T | Promise<T>
  ): Promise<T> {
    return this.withFileLock(filename, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { lines, hash } = await this.readLinesWithHash(filename);
        const result = await apply(lines);
        if (await this.writeLinesIfUnchanged(filename, lines, hash)) {
          return result;
        }
      }
      throw new OrgError(
        `File "${filename}" was modified externally during write; re-read and retry.`
      );
    });
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

    const scheduled = params.scheduled ? parseInputDate(params.scheduled) : null;
    const deadline = params.deadline ? parseInputDate(params.deadline) : null;
    const tags = sanitizeTags(params.tags);

    let parentId = params.parentId ?? null;
    if (parentId) {
      parentId = await this.materializeTmpId(parentId);
      const found = await this.findEntryById(parentId);
      if (!found) throw new OrgError(`No entry found with id "${parentId}".`);
      filename = found.filename;
    }

    return this.mutateFile(filename, (lines) => {
      const entries = parseOrgFile(lines.join("\n"), filename);

      let level = 1;
      let insertAt = lines.length;
      let needsLeadingBlank: boolean;

      if (parentId) {
        const parent = entries.find((e) => e.id === parentId);
        if (!parent) throw new OrgError(`No entry found with id "${parentId}".`);
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

      const created = parseOrgFile(lines.join("\n"), filename).find((e) => e.id === id);
      if (!created) throw new OrgError(`Entry "${id}" went missing after capture.`);
      return cleanEntry(created);
    });
  }

  async findEntryById(
    id: string,
    opts: { includeArchive?: boolean } = {}
  ): Promise<{ entry: ParsedEntry; filename: string } | null> {
    const tmp = parseTmpHandle(id);
    if (tmp) {
      const mappedRealId = this.materializedTmpHandles.get(id);
      if (mappedRealId !== undefined) {
        return this.findEntryById(mappedRealId, opts);
      }
      if (!(opts.includeArchive ?? false) && tmp.filename.endsWith("_archive.org")) {
        return null;
      }
      const files = await this.listFiles(opts.includeArchive ?? false);
      if (!files.includes(tmp.filename)) return null;
      const { lines, hash } = await this.readLinesWithHash(tmp.filename);
      if (hash === null) return null;
      const resolved = resolveTmpHandleInLines(lines, tmp, hash);
      if (!resolved) return null;
      return { entry: resolved, filename: tmp.filename };
    }

    const files = await this.listFiles(true);
    const matches: { entry: ParsedEntry; filename: string }[] = [];
    for (const filename of files) {
      const lines = await this.readLines(filename);
      const entries = parseOrgFile(lines.join("\n"), filename);
      for (const entry of entries) {
        if (entry.id === id) {
          matches.push({ entry, filename });
        }
      }
    }
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      const locations = matches
        .map((m) => `${m.filename}:${m.entry.headlineLine + 1}`)
        .join(", ");
      throw new OrgError(
        `Duplicate id "${id}" found in multiple locations: ${locations}. Resolve the duplicate in the org file(s) before proceeding.`
      );
    }
    const match = matches[0];
    if (!(opts.includeArchive ?? false) && match.filename.endsWith("_archive.org")) {
      return null;
    }
    return match;
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
    const realId = await this.materializeTmpId(id);
    const found = await this.findEntryById(realId);
    if (!found) throw new OrgError(`No entry found with id "${realId}".`);
    const { filename } = found;

    return this.mutateFile(filename, (lines) => {
      const entries = parseOrgFile(lines.join("\n"), filename);
      const entry = entries.find((e) => e.id === realId);
      if (!entry) throw new OrgError(`No entry found with id "${realId}".`);

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

      const updated = parseOrgFile(lines.join("\n"), filename).find((e) => e.id === realId)!;
      return cleanEntry(updated);
    });
  }

  async schedule(
    id: string,
    updates: { scheduled?: string | null; deadline?: string | null }
  ): Promise<CleanEntry> {
    const parsedScheduled =
      typeof updates.scheduled === "string" ? parseInputDate(updates.scheduled) : updates.scheduled;
    const parsedDeadline =
      typeof updates.deadline === "string" ? parseInputDate(updates.deadline) : updates.deadline;

    const realId = await this.materializeTmpId(id);
    const found = await this.findEntryById(realId);
    if (!found) throw new OrgError(`No entry found with id "${realId}".`);
    const { filename } = found;

    return this.mutateFile(filename, (lines) => {
      const entries = parseOrgFile(lines.join("\n"), filename);
      const entry = entries.find((e) => e.id === realId);
      if (!entry) throw new OrgError(`No entry found with id "${realId}".`);

      // Leaving a field unchanged (undefined) preserves its raw text verbatim (repeaters,
      // time ranges, etc.); only fields explicitly passed get reformatted from scratch.
      function resolve(
        parsed: { date: string; time: string | null } | null | undefined,
        raw: string | null
      ): string | null {
        if (parsed === undefined) return raw;
        if (parsed === null) return null;
        return formatOrgTimestamp(parsed.date, parsed.time, true);
      }
      const scheduledText = resolve(parsedScheduled, entry.scheduledRaw);
      const deadlineText = resolve(parsedDeadline, entry.deadlineRaw);
      const planning = buildPlanningLine(scheduledText, deadlineText, entry.closedRaw);
      this.setPlanningLine(lines, entry, planning);

      const updated = parseOrgFile(lines.join("\n"), filename).find((e) => e.id === realId)!;
      return cleanEntry(updated);
    });
  }

  async addNote(id: string, note: string): Promise<CleanEntry> {
    const trimmed = note.trim();
    if (!trimmed) throw new OrgError("note cannot be empty.");
    const realId = await this.materializeTmpId(id);
    const found = await this.findEntryById(realId);
    if (!found) throw new OrgError(`No entry found with id "${realId}".`);
    const { filename } = found;

    return this.mutateFile(filename, (lines) => {
      const entries = parseOrgFile(lines.join("\n"), filename);
      const entry = entries.find((e) => e.id === realId);
      if (!entry) throw new OrgError(`No entry found with id "${realId}".`);

      const now = nowStamp();
      const ts = formatOrgTimestamp(now.date, now.time, false);
      const noteLines = trimmed.split("\n");
      const rendered = [`  - Note taken on ${ts} :: ${noteLines[0]}`, ...noteLines.slice(1).map((l) => `    ${l}`)];
      lines.splice(entry.bodyEnd, 0, ...rendered);

      const updated = parseOrgFile(lines.join("\n"), filename).find((e) => e.id === realId)!;
      return cleanEntry(updated);
    });
  }

  async archiveEntry(id: string): Promise<{ id: string; archivedTo: string }> {
    const realId = await this.materializeTmpId(id);
    const found = await this.findEntryById(realId);
    if (!found) throw new OrgError(`No entry found with id "${realId}".`);
    const { filename } = found;
    const archiveFile = this.archiveFileFor(filename);

    return this.withFileLocks([filename, archiveFile], async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { lines, hash: sourceHash } = await this.readLinesWithHash(filename);
        const entries = parseOrgFile(lines.join("\n"), filename);
        const entry = entries.find((e) => e.id === realId);
        if (!entry) throw new OrgError(`No entry found with id "${realId}".`);

        const subtreeLines = spliceSubtree(lines, entry.startLine, entry.endLine);

        // Write the archive first: if the second write fails the subtree exists twice,
        // which is visible and recoverable, rather than not at all.
        const { lines: archiveLines, hash: archiveHash } =
          await this.readLinesWithHash(archiveFile);
        const needsBlank = archiveLines.some((l) => l.trim() !== "");
        archiveLines.push(...(needsBlank ? ["", ...subtreeLines] : subtreeLines));

        if (!(await this.writeLinesIfUnchanged(archiveFile, archiveLines, archiveHash))) {
          continue;
        }
        if (!(await this.writeLinesIfUnchanged(filename, lines, sourceHash))) {
          throw new OrgError(
            `File "${filename}" was modified externally during write; entry was copied to "${archiveFile}" and still exists in "${filename}". Resolve the duplicate copy before retrying.`
          );
        }

        return { id: realId, archivedTo: archiveFile };
      }

      throw new OrgError(
        `File "${archiveFile}" was modified externally during write; re-read and retry.`
      );
    });
  }

  /**
   * Moves an entry and its subtree under a new parent and/or into another file —
   * the "organize the inbox later" half of capture-fast-file-later.
   */
  async refile(
    id: string,
    target: { parentId?: string | null; file?: string | null }
  ): Promise<CleanEntry> {
    const rawParentId = target.parentId ?? null;
    let destFile = target.file ?? null;
    if (!rawParentId && !destFile) {
      throw new OrgError("refile needs a parent_id, a file, or both.");
    }
    if (destFile && !destFile.endsWith(".org")) destFile += ".org";
    if (rawParentId && rawParentId === id) {
      throw new OrgError("Cannot refile an entry into its own subtree.");
    }

    const tmpId = parseTmpHandle(id);
    const tmpParent = rawParentId ? parseTmpHandle(rawParentId) : null;

    // Validate entry and parent (read-only) before materializing any temporary handles so
    // failing calls (missing parent, file mismatch, own subtree) never write an :ID:.
    const preFound = await this.findEntryById(id);
    if (!preFound) {
      if (tmpId) {
        throw new OrgError(
          `Temporary handle "${id}" is stale: heading at ${tmpId.filename}:${tmpId.line} no longer matches. Re-read to get a current handle.`
        );
      }
      throw new OrgError(`No entry found with id "${id}".`);
    }
    if (rawParentId) {
      const preParentFound = await this.findEntryById(rawParentId);
      if (!preParentFound) {
        if (tmpParent) {
          throw new OrgError(
            `Temporary handle "${rawParentId}" is stale: heading at ${tmpParent.filename}:${tmpParent.line} no longer matches. Re-read to get a current handle.`
          );
        }
        throw new OrgError(`No entry found with id "${rawParentId}".`);
      }
      if (destFile && destFile !== preParentFound.filename) {
        throw new OrgError(
          `Parent "${rawParentId}" lives in ${preParentFound.filename}, not ${destFile}. ` +
            "Omit file to refile into the parent's own file."
        );
      }
      if (
        preFound.filename === preParentFound.filename &&
        preParentFound.entry.headlineLine >= preFound.entry.startLine &&
        preParentFound.entry.headlineLine < preFound.entry.endLine
      ) {
        throw new OrgError("Cannot refile an entry into its own subtree.");
      }
    }

    // Materialize temporary handles atomically when both live in the same file and neither
    // has been materialized yet, so materializing one does not invalidate the other's file hash.
    let realId: string;
    let parentId: string | null;
    if (
      tmpId &&
      tmpParent &&
      tmpId.filename === tmpParent.filename &&
      !this.materializedTmpHandles.has(id) &&
      !this.materializedTmpHandles.has(rawParentId!)
    ) {
      if (tmpId.line === tmpParent.line) {
        throw new OrgError("Cannot refile an entry into its own subtree.");
      }
      [realId, parentId] = await this.materializeTwoTmpIdsInSameFile(
        tmpId.filename,
        id,
        rawParentId!
      );
    } else {
      realId = await this.materializeTmpId(id);
      parentId = rawParentId ? await this.materializeTmpId(rawParentId) : null;
    }

    const found = await this.findEntryById(realId);
    if (!found) throw new OrgError(`No entry found with id "${realId}".`);
    const sourceFile = found.filename;

    if (parentId) {
      const parentFound = await this.findEntryById(parentId);
      if (!parentFound) throw new OrgError(`No entry found with id "${parentId}".`);
      if (destFile && destFile !== parentFound.filename) {
        throw new OrgError(
          `Parent "${parentId}" lives in ${parentFound.filename}, not ${destFile}. ` +
            "Omit file to refile into the parent's own file."
        );
      }
      destFile = parentFound.filename;
    }
    const destinationFile = destFile!;

    const applyRefile = (sourceLines: string[], destLines: string[]): CleanEntry => {
      const entry = parseOrgFile(sourceLines.join("\n"), sourceFile).find((e) => e.id === realId);
      if (!entry) throw new OrgError(`No entry found with id "${realId}".`);

      if (parentId) {
        const parentBefore = parseOrgFile(sourceLines.join("\n"), sourceFile).find(
          (e) => e.id === parentId
        );
        if (
          sourceFile === destinationFile &&
          parentBefore &&
          parentBefore.headlineLine >= entry.startLine &&
          parentBefore.headlineLine < entry.endLine
        ) {
          throw new OrgError("Cannot refile an entry into its own subtree.");
        }
      }

      const subtree = spliceSubtree(sourceLines, entry.startLine, entry.endLine);

      // Re-parse after the removal so destination offsets reflect the shifted file.
      const destEntries = parseOrgFile(destLines.join("\n"), destinationFile);

      let newLevel = 1;
      let insertAt = destLines.length;
      let needsLeadingBlank: boolean;

      if (parentId) {
        const parent = destEntries.find((e) => e.id === parentId);
        if (!parent) throw new OrgError(`No entry found with id "${parentId}".`);
        newLevel = parent.level + 1;
        insertAt = parent.endLine;
        needsLeadingBlank = false;
      } else {
        while (insertAt > 0 && destLines[insertAt - 1].trim() === "") insertAt--;
        needsLeadingBlank = insertAt > 0;
      }

      // Guard on the shallowest headline in the subtree, not just its root: a malformed
      // file can leave a shallower headline inside the span parseOrgFile returns.
      const levels = subtree
        .map((l) => l.match(/^(\*+)\s/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => m[1].length);
      const shallowest = Math.min(...levels);
      const delta = newLevel - entry.level;
      if (shallowest + delta < 1) {
        throw new OrgError("Refiling there would push part of the subtree above level 1.");
      }

      const shifted = shiftSubtreeLevels(subtree, delta);
      destLines.splice(insertAt, 0, ...(needsLeadingBlank ? ["", ...shifted] : shifted));

      const moved = parseOrgFile(destLines.join("\n"), destinationFile).find((e) => e.id === realId);
      if (!moved) throw new OrgError(`Entry "${realId}" went missing during refile.`);
      return cleanEntry(moved);
    };

    if (sourceFile === destinationFile) {
      return this.mutateFile(sourceFile, (lines) => applyRefile(lines, lines));
    }

    return this.withFileLocks([sourceFile, destinationFile], async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { lines: sourceLines, hash: sourceHash } = await this.readLinesWithHash(sourceFile);
        const { lines: destLines, hash: destHash } = await this.readLinesWithHash(destinationFile);
        const moved = applyRefile(sourceLines, destLines);

        if (!(await this.writeLinesIfUnchanged(destinationFile, destLines, destHash))) {
          continue;
        }
        if (!(await this.writeLinesIfUnchanged(sourceFile, sourceLines, sourceHash))) {
          throw new OrgError(
            `File "${sourceFile}" was modified externally during write; entry was copied to "${destinationFile}" and still exists in "${sourceFile}". Resolve the duplicate copy before retrying.`
          );
        }

        return moved;
      }

      throw new OrgError(
        `File "${destinationFile}" was modified externally during write; re-read and retry.`
      );
    });
  }

  /** Replaces an entry's tags outright. */
  async setTags(id: string, tags: string[]): Promise<CleanEntry> {
    const realId = await this.materializeTmpId(id);
    const found = await this.findEntryById(realId);
    if (!found) throw new OrgError(`No entry found with id "${realId}".`);
    const { filename } = found;

    return this.mutateFile(filename, (lines) => {
      const entry = parseOrgFile(lines.join("\n"), filename).find((e) => e.id === realId);
      if (!entry) throw new OrgError(`No entry found with id "${realId}".`);

      lines[entry.headlineLine] = buildHeadlineLine(
        entry.level,
        entry.todo,
        entry.priority,
        entry.headline,
        sanitizeTags(tags)
      );
      return cleanEntry(parseOrgFile(lines.join("\n"), filename).find((e) => e.id === realId)!);
    });
  }

  /** Sets, updates, or removes keys in an entry's :PROPERTIES: drawer. */
  async setProperties(
    id: string,
    properties: Record<string, string | null>
  ): Promise<CleanEntry> {
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      throw new OrgError("properties must be an object.");
    }

    const updates = new Map<string, { key: string; value: string | null }>();
    for (const [key, value] of Object.entries(properties)) {
      if (key.length === 0) {
        throw new OrgError("Property key cannot be empty.");
      }
      if (/\s/.test(key)) {
        throw new OrgError(`Invalid property key "${key}": whitespace is not allowed.`);
      }
      if (key.includes(":")) {
        throw new OrgError(`Invalid property key "${key}": colons are not allowed.`);
      }
      const upper = key.toUpperCase();
      if (upper === "ID" || upper === "CREATED") {
        throw new OrgError(`Property "${upper}" is managed by the server and cannot be modified.`);
      }
      if (upper === "END" || upper === "PROPERTIES") {
        throw new OrgError(`Property key "${key}" is reserved for drawer delimiters.`);
      }
      if (updates.has(upper)) {
        throw new OrgError(`Duplicate property key "${key}" (case-insensitive).`);
      }
      if (value !== null && typeof value !== "string") {
        throw new OrgError(`Invalid value for property "${key}": expected string or null.`);
      }
      if (typeof value === "string" && /[\r\n\u2028\u2029]/.test(value)) {
        throw new OrgError(`Invalid value for property "${key}": newlines are not allowed.`);
      }
      if (typeof value === "string" && /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) {
        throw new OrgError(
          `Invalid value for property "${key}": control characters are not allowed.`
        );
      }
      updates.set(upper, { key, value });
    }

    const realId = await this.materializeTmpId(id);
    const found = await this.findEntryById(realId);
    if (!found) throw new OrgError(`No entry found with id "${realId}".`);
    const { filename } = found;

    return this.mutateFile(filename, (lines) => {
      const entry = parseOrgFile(lines.join("\n"), filename).find((e) => e.id === realId);
      if (!entry) throw new OrgError(`No entry found with id "${realId}".`);

      if (entry.propertiesStart !== null && entry.propertiesEnd !== null) {
        if (lines[entry.propertiesEnd]?.trim() !== ":END:") {
          throw new OrgError(
            `Entry "${realId}" has an unterminated :PROPERTIES: drawer (missing :END:); fix it in the file first.`
          );
        }
        for (let k = entry.propertiesStart + 1; k < entry.propertiesEnd; k++) {
          if (/^\*+\s/.test(lines[k])) {
            throw new OrgError(
              `Entry "${realId}" has an unterminated :PROPERTIES: drawer (headline found before :END:); fix it in the file first.`
            );
          }
        }
        const drawerIndent = lines[entry.propertiesStart].match(/^(\s*)/)?.[1] ?? "  ";
        const contentStart = entry.propertiesStart + 1;
        const contentEnd = entry.propertiesEnd;

        const handled = new Set<string>();
        const newDrawerBody: string[] = [];

        for (let k = contentStart; k < contentEnd; k++) {
          const line = lines[k];
          const pm = line.match(/^(\s*):([^:]+):(.*)$/);
          if (!pm) {
            newDrawerBody.push(line);
            continue;
          }
          const lineIndent = pm[1];
          const existingKey = pm[2];
          const upper = existingKey.toUpperCase();
          if (!updates.has(upper)) {
            newDrawerBody.push(line);
            continue;
          }
          handled.add(upper);
          const { value } = updates.get(upper)!;
          if (value !== null) {
            newDrawerBody.push(`${lineIndent}:${existingKey}: ${value}`);
          }
        }

        for (const [upper, { key, value }] of updates) {
          if (!handled.has(upper) && value !== null) {
            newDrawerBody.push(`${drawerIndent}:${key}: ${value}`);
          }
        }

        lines.splice(contentStart, contentEnd - contentStart, ...newDrawerBody);
      } else {
        const toCreate: Record<string, string> = {};
        for (const [, { key, value }] of updates) {
          if (value !== null) toCreate[key] = value;
        }
        if (Object.keys(toCreate).length > 0) {
          const insertAt =
            entry.planningLine !== null ? entry.planningLine + 1 : entry.headlineLine + 1;
          lines.splice(insertAt, 0, ...buildPropertiesDrawer(toCreate));
        }
      }

      const updated = parseOrgFile(lines.join("\n"), filename).find((e) => e.id === realId);
      if (!updated) throw new OrgError(`Entry "${realId}" went missing after setProperties.`);
      return cleanEntry(updated);
    });
  }

  /** Every tag in use, with how many entries carry it. */
  async listTags(): Promise<{ tag: string; count: number }[]> {
    const counts = new Map<string, number>();
    for (const entry of await this.allEntries()) {
      for (const tag of entry.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /**
   * Reworks an entry's text. Omitting a field leaves it unchanged; passing null clears
   * it (where clearing makes sense).
   */
  async editEntry(
    id: string,
    updates: { headline?: string; body?: string | null; priority?: "A" | "B" | "C" | null }
  ): Promise<CleanEntry> {
    if (updates.headline === undefined && updates.body === undefined && updates.priority === undefined) {
      throw new OrgError("editEntry needs at least one of headline, body, or priority.");
    }
    if (updates.headline !== undefined && !updates.headline.trim()) {
      throw new OrgError("headline cannot be empty.");
    }

    const realId = await this.materializeTmpId(id);
    const found = await this.findEntryById(realId);
    if (!found) throw new OrgError(`No entry found with id "${realId}".`);
    const { filename } = found;

    return this.mutateFile(filename, (lines) => {
      const entry = parseOrgFile(lines.join("\n"), filename).find((e) => e.id === realId);
      if (!entry) throw new OrgError(`No entry found with id "${realId}".`);

      if (updates.headline !== undefined || updates.priority !== undefined) {
        lines[entry.headlineLine] = buildHeadlineLine(
          entry.level,
          entry.todo,
          updates.priority === undefined ? entry.priority : updates.priority,
          updates.headline === undefined ? entry.headline : updates.headline.trim(),
          entry.tags
        );
      }

      if (updates.body !== undefined) {
        // bodyEnd stops before the first child headline, so a parent keeps its children.
        const replacement =
          updates.body && updates.body.trim()
            ? updates.body.replace(/\r\n/g, "\n").split("\n")
            : [];
        lines.splice(entry.bodyStart, entry.bodyEnd - entry.bodyStart, ...replacement);
      }

      return cleanEntry(parseOrgFile(lines.join("\n"), filename).find((e) => e.id === realId)!);
    });
  }

  /**
   * If `id` is a temporary handle (`tmp:<file>:<line>:<hash>`), confirms the heading at
   * that file and line still matches, writes a real `:ID:` into its `:PROPERTIES:` drawer
   * under the per-file lock with external-change protection, and returns the real UUID.
   * Non-temporary IDs are returned unchanged.
   */
  private async materializeTmpId(id: string): Promise<string> {
    const tmp = parseTmpHandle(id);
    if (!tmp) return id;
    const mappedRealId = this.materializedTmpHandles.get(id);
    if (mappedRealId !== undefined) return mappedRealId;
    if (tmp.filename.endsWith("_archive.org")) {
      throw new OrgError(`No entry found with id "${id}".`);
    }
    const files = await this.listFiles(false);
    if (!files.includes(tmp.filename)) {
      throw new OrgError(`No entry found with id "${id}".`);
    }

    return this.withFileLock(tmp.filename, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { lines, hash } = await this.readLinesWithHash(tmp.filename);
        if (lines.length === 0 || hash === null) {
          throw new OrgError(
            `Temporary handle "${id}" is stale: "${tmp.filename}" is empty or missing.`
          );
        }
        const entry = resolveTmpHandleInLines(lines, tmp, hash);
        if (!entry) {
          throw new OrgError(
            `Temporary handle "${id}" is stale: "${tmp.filename}" changed since the handle was issued. Re-read to get a current handle.`
          );
        }

        const realId = randomUUID();
        if (entry.propertiesStart !== null) {
          lines.splice(entry.propertiesStart + 1, 0, `  :ID: ${realId}`);
        } else {
          const insertAt =
            entry.planningLine !== null ? entry.planningLine + 1 : entry.headlineLine + 1;
          lines.splice(insertAt, 0, ...buildPropertiesDrawer({ ID: realId }));
        }

        if (await this.writeLinesIfUnchanged(tmp.filename, lines, hash)) {
          this.materializedTmpHandles.set(id, realId);
          return realId;
        }
      }
      throw new OrgError(
        `File "${tmp.filename}" was modified externally during write; re-read and retry.`
      );
    });
  }

  private async materializeTwoTmpIdsInSameFile(
    filename: string,
    idA: string,
    idB: string
  ): Promise<[string, string]> {
    const tmpA = parseTmpHandle(idA)!;
    const tmpB = parseTmpHandle(idB)!;
    if (filename.endsWith("_archive.org")) {
      throw new OrgError(`No entry found with id "${idA}".`);
    }
    const files = await this.listFiles(false);
    if (!files.includes(filename)) {
      throw new OrgError(`No entry found with id "${idA}".`);
    }

    return this.withFileLock(filename, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { lines, hash } = await this.readLinesWithHash(filename);
        if (lines.length === 0 || hash === null) {
          throw new OrgError(
            `Temporary handle "${idA}" is stale: "${filename}" is empty or missing.`
          );
        }
        const entryA = resolveTmpHandleInLines(lines, tmpA, hash);
        if (!entryA) {
          throw new OrgError(
            `Temporary handle "${idA}" is stale: "${filename}" changed since the handle was issued. Re-read to get a current handle.`
          );
        }
        const entryB = resolveTmpHandleInLines(lines, tmpB, hash);
        if (!entryB) {
          throw new OrgError(
            `Temporary handle "${idB}" is stale: "${filename}" changed since the handle was issued. Re-read to get a current handle.`
          );
        }
        if (entryA.headlineLine === entryB.headlineLine) {
          throw new OrgError("Cannot refile an entry into its own subtree.");
        }

        const realIdA = randomUUID();
        const realIdB = randomUUID();
        const targets = [
          { entry: entryA, realId: realIdA },
          { entry: entryB, realId: realIdB },
        ].sort((x, y) => y.entry.headlineLine - x.entry.headlineLine);

        for (const { entry, realId } of targets) {
          if (entry.propertiesStart !== null) {
            lines.splice(entry.propertiesStart + 1, 0, `  :ID: ${realId}`);
          } else {
            const insertAt =
              entry.planningLine !== null ? entry.planningLine + 1 : entry.headlineLine + 1;
            lines.splice(insertAt, 0, ...buildPropertiesDrawer({ ID: realId }));
          }
        }

        if (await this.writeLinesIfUnchanged(filename, lines, hash)) {
          this.materializedTmpHandles.set(idA, realIdA);
          this.materializedTmpHandles.set(idB, realIdB);
          return [realIdA, realIdB];
        }
      }
      throw new OrgError(
        `File "${filename}" was modified externally during write; re-read and retry.`
      );
    });
  }

  private async allEntries(includeArchive = false): Promise<ParsedEntry[]> {
    const files = await this.listFiles(includeArchive);
    const out: ParsedEntry[] = [];
    for (const filename of files) {
      const { lines, hash } = await this.readLinesWithHash(filename);
      if (hash === null) continue;
      out.push(...withTemporaryHandles(parseOrgFile(lines.join("\n"), filename), hash));
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

  async listTodos(filter: EntryFilter = {}): Promise<CleanEntry[]> {
    const entries = await this.allEntries();
    let result = entries.filter((e) => e.todo !== null);
    if (!filter.state) {
      result = result.filter((e) => (OPEN_KEYWORDS as readonly string[]).includes(e.todo!));
    }
    result = filterEntries(result, filter);

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

  async search(
    query: string,
    opts: EntryFilter & { includeArchive?: boolean } = {}
  ): Promise<CleanEntry[]> {
    const q = query.trim().toLowerCase();
    if (!q) throw new OrgError("query cannot be empty.");
    const entries = await this.allEntries(opts.includeArchive ?? false);
    const matched = entries.filter(
      (e) =>
        e.headline.toLowerCase().includes(q) ||
        e.body.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q))
    );
    return filterEntries(matched, opts).map(cleanEntry);
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

  async outline(params: OutlineParams = {}): Promise<OutlineNode[]> {
    if (params.level !== undefined && (!Number.isInteger(params.level) || params.level < 1)) {
      throw new OrgError("level must be a positive integer.");
    }
    if (params.maxDepth !== undefined && (!Number.isInteger(params.maxDepth) || params.maxDepth < 0)) {
      throw new OrgError("maxDepth must be a non-negative integer.");
    }

    let targetFiles: string[];
    let requestedFile: string | undefined;
    if (params.file !== undefined) {
      let filename = params.file;
      if (!filename.endsWith(".org")) filename += ".org";
      this.resolvePath(filename);
      const tracked = await this.listFiles(true);
      if (!tracked.includes(filename)) {
        throw new OrgError(
          `No such org file "${filename}". Tracked files: ${tracked.join(", ") || "(none)"}.`
        );
      }
      requestedFile = filename;
    }

    let resolvedRootId: string | undefined;
    if (params.rootId !== undefined) {
      const found = await this.findEntryById(params.rootId, { includeArchive: true });
      if (!found) {
        throw new OrgError(
          requestedFile !== undefined
            ? `No entry found with id "${params.rootId}" in "${requestedFile}".`
            : `No entry found with id "${params.rootId}".`
        );
      }
      if (requestedFile !== undefined && found.filename !== requestedFile) {
        throw new OrgError(`No entry found with id "${params.rootId}" in "${requestedFile}".`);
      }
      resolvedRootId = found.entry.id ?? params.rootId;
      targetFiles = [found.filename];
    } else if (requestedFile !== undefined) {
      targetFiles = [requestedFile];
    } else {
      targetFiles = await this.listFiles(false);
    }

    let roots: OutlineNode[] = [];
    for (const filename of targetFiles) {
      const { lines, hash } = await this.readLinesWithHash(filename);
      if (hash === null) continue;
      const entries = withTemporaryHandles(parseOrgFile(lines.join("\n"), filename), hash);
      roots.push(...buildOutlineTree(entries));
    }

    if (resolvedRootId !== undefined) {
      const rootNode = findNodeById(roots, resolvedRootId);
      if (!rootNode) {
        throw new OrgError(
          params.file !== undefined
            ? `No entry found with id "${params.rootId}" in "${targetFiles[0]}".`
            : `No entry found with id "${params.rootId}".`
        );
      }
      roots = [rootNode];
    }

    if (params.level !== undefined) {
      roots = collectAtLevel(roots, params.level);
    }

    return roots.map((node) => truncateDepth(node, params.maxDepth));
  }
}

function buildOutlineTree(entries: ParsedEntry[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];

  for (const e of entries) {
    const node: OutlineNode = {
      id: e.id,
      headline: e.headline,
      file: e.file,
      level: e.level,
      todo: e.todo,
      tags: e.tags,
      descendantCounts: {},
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }

  const populateCounts = (node: OutlineNode): void => {
    const counts: Record<string, number> = {};
    for (const child of node.children) {
      populateCounts(child);
      if (child.todo) {
        counts[child.todo] = (counts[child.todo] ?? 0) + 1;
      }
      for (const [state, count] of Object.entries(child.descendantCounts)) {
        counts[state] = (counts[state] ?? 0) + count;
      }
    }
    node.descendantCounts = counts;
  };

  for (const root of roots) {
    populateCounts(root);
  }

  return roots;
}

function findNodeById(nodes: OutlineNode[], id: string): OutlineNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNodeById(node.children, id);
    if (found) return found;
  }
  return null;
}

function collectAtLevel(
  nodes: OutlineNode[],
  level: number,
  out: OutlineNode[] = []
): OutlineNode[] {
  for (const node of nodes) {
    if (node.level === level) {
      out.push(node);
    } else if (node.level < level) {
      collectAtLevel(node.children, level, out);
    }
  }
  return out;
}

function truncateDepth(node: OutlineNode, maxDepth: number | undefined): OutlineNode {
  return {
    ...node,
    children:
      maxDepth === undefined || maxDepth > 0
        ? node.children.map((c) =>
            truncateDepth(c, maxDepth === undefined ? undefined : maxDepth - 1)
          )
        : [],
  };
}
