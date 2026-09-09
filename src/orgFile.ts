import { ALL_KEYWORDS } from "./orgModel.js";
import type { OrgEntry } from "./orgModel.js";
import { parseOrgTimestamp } from "./orgDate.js";

export interface ParsedEntry extends OrgEntry {
  // Line range within the file (0-indexed, [start, end)) covering headline..end of subtree.
  startLine: number;
  endLine: number;
  headlineLine: number;
  planningLine: number | null;
  propertiesStart: number | null; // index of ":PROPERTIES:" line
  propertiesEnd: number | null; // index of ":END:" line
  bodyStart: number;
  bodyEnd: number; // exclusive, before first child headline (or === subtree end)
  // Raw bracketed timestamp text as found in the file (e.g. "<2026-08-20 Thu +1w>"),
  // preserved verbatim so repeaters/time-ranges survive rewrites of unrelated fields.
  scheduledRaw: string | null;
  deadlineRaw: string | null;
  closedRaw: string | null;
}

const HEADLINE_RE = /^(\*+)\s+(.*)$/;

function parseHeadlineText(rest: string): {
  todo: string | null;
  priority: "A" | "B" | "C" | null;
  headline: string;
  tags: string[];
} {
  let text = rest.trim();
  let todo: string | null = null;
  let priority: "A" | "B" | "C" | null = null;

  const todoMatch = text.match(/^([A-Z][A-Z-]*)(\s+.*)?$/);
  if (todoMatch && (ALL_KEYWORDS as readonly string[]).includes(todoMatch[1])) {
    todo = todoMatch[1];
    text = (todoMatch[2] ?? "").trim();
  }

  const prioMatch = text.match(/^\[#([ABC])\]\s*(.*)$/);
  if (prioMatch) {
    priority = prioMatch[1] as "A" | "B" | "C";
    text = prioMatch[2].trim();
  }

  let tags: string[] = [];
  const tagMatch = text.match(/^(.*?)\s+:([\w@%#:]+):\s*$/);
  if (tagMatch) {
    text = tagMatch[1].trim();
    tags = tagMatch[2].split(":").filter(Boolean);
  }

  return { todo, priority, headline: text, tags };
}

function isPlanningLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const stripped = trimmed
    .replace(/SCHEDULED:\s*<[^>]+>/g, "")
    .replace(/DEADLINE:\s*<[^>]+>/g, "")
    .replace(/CLOSED:\s*\[[^\]]+\]/g, "")
    .trim();
  return stripped === "" && trimmed !== "";
}

export function parseOrgFile(content: string, filename: string): ParsedEntry[] {
  const lines = content.split("\n");
  const headlineIdx: { line: number; level: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADLINE_RE);
    if (m) headlineIdx.push({ line: i, level: m[1].length });
  }

  const entries: ParsedEntry[] = [];

  for (let hi = 0; hi < headlineIdx.length; hi++) {
    const { line: headlineLine, level } = headlineIdx[hi];
    const m = lines[headlineLine].match(HEADLINE_RE)!;
    const { todo, priority, headline, tags } = parseHeadlineText(m[2]);

    // Subtree end: next headline at level <= this level, or EOF.
    let subtreeEnd = lines.length;
    for (let j = hi + 1; j < headlineIdx.length; j++) {
      if (headlineIdx[j].level <= level) {
        subtreeEnd = headlineIdx[j].line;
        break;
      }
    }

    let cursor = headlineLine + 1;
    let planningLine: number | null = null;
    let scheduled: OrgEntry["scheduled"] = null;
    let deadline: OrgEntry["deadline"] = null;
    let closed: OrgEntry["closed"] = null;
    let scheduledRaw: string | null = null;
    let deadlineRaw: string | null = null;
    let closedRaw: string | null = null;

    if (cursor < subtreeEnd && isPlanningLine(lines[cursor])) {
      planningLine = cursor;
      const l = lines[cursor];
      const sm = l.match(/SCHEDULED:\s*(<[^>]+>)/);
      const dm = l.match(/DEADLINE:\s*(<[^>]+>)/);
      const cm = l.match(/CLOSED:\s*(\[[^\]]+\])/);
      if (sm) {
        scheduledRaw = sm[1];
        const ts = parseOrgTimestamp(sm[1]);
        if (ts) scheduled = { date: ts.date, time: ts.time };
      }
      if (dm) {
        deadlineRaw = dm[1];
        const ts = parseOrgTimestamp(dm[1]);
        if (ts) deadline = { date: ts.date, time: ts.time };
      }
      if (cm) {
        closedRaw = cm[1];
        const ts = parseOrgTimestamp(cm[1]);
        if (ts) closed = { date: ts.date, time: ts.time };
      }
      cursor++;
    }

    let propertiesStart: number | null = null;
    let propertiesEnd: number | null = null;
    const properties: Record<string, string> = {};

    if (cursor < subtreeEnd && lines[cursor].trim() === ":PROPERTIES:") {
      propertiesStart = cursor;
      let k = cursor + 1;
      while (k < subtreeEnd && lines[k].trim() !== ":END:") {
        const pm = lines[k].match(/^\s*:([^:]+):\s*(.*)$/);
        if (pm) properties[pm[1].toUpperCase()] = pm[2].trim();
        k++;
      }
      propertiesEnd = k < subtreeEnd ? k : k - 1;
      cursor = propertiesEnd + 1;
    }

    const bodyStart = cursor;
    // Body ends at the first child headline (any headline strictly inside the subtree).
    let bodyEnd = subtreeEnd;
    for (let j = hi + 1; j < headlineIdx.length; j++) {
      if (headlineIdx[j].line >= subtreeEnd) break;
      bodyEnd = headlineIdx[j].line;
      break;
    }

    const body = lines
      .slice(bodyStart, bodyEnd)
      .join("\n")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");

    entries.push({
      id: properties.ID ?? null,
      file: filename,
      level,
      todo,
      priority,
      headline,
      tags,
      scheduled,
      deadline,
      closed,
      properties,
      body,
      startLine: headlineLine,
      endLine: subtreeEnd,
      headlineLine,
      planningLine,
      propertiesStart,
      propertiesEnd,
      bodyStart,
      bodyEnd,
      scheduledRaw,
      deadlineRaw,
      closedRaw,
    });
  }

  return entries;
}

export function buildHeadlineLine(
  level: number,
  todo: string | null,
  priority: "A" | "B" | "C" | null,
  headline: string,
  tags: string[]
): string {
  const stars = "*".repeat(level);
  const parts = [stars];
  if (todo) parts.push(todo);
  if (priority) parts.push(`[#${priority}]`);
  parts.push(headline);
  let line = parts.join(" ");
  if (tags.length > 0) {
    line += `  :${tags.join(":")}:`;
  }
  return line;
}

export function buildPlanningLine(
  scheduled: string | null,
  deadline: string | null,
  closed: string | null = null
): string | null {
  const parts: string[] = [];
  if (scheduled) parts.push(`SCHEDULED: ${scheduled}`);
  if (deadline) parts.push(`DEADLINE: ${deadline}`);
  if (closed) parts.push(`CLOSED: ${closed}`);
  if (parts.length === 0) return null;
  return "  " + parts.join(" ");
}

export function buildPropertiesDrawer(properties: Record<string, string>): string[] {
  const keys = Object.keys(properties);
  if (keys.length === 0) return [];
  const lines = ["  :PROPERTIES:"];
  for (const k of keys) {
    lines.push(`  :${k}: ${properties[k]}`);
  }
  lines.push("  :END:");
  return lines;
}
