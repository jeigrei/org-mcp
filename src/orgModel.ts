export const OPEN_KEYWORDS = ["TODO", "NEXT", "IN-PROGRESS", "WAITING"] as const;
export const DONE_KEYWORDS = ["DONE", "CANCELLED"] as const;
export const ALL_KEYWORDS = [...OPEN_KEYWORDS, ...DONE_KEYWORDS] as const;

export type TodoKeyword = (typeof ALL_KEYWORDS)[number];

export function isDoneKeyword(kw: string | null): boolean {
  return kw !== null && (DONE_KEYWORDS as readonly string[]).includes(kw);
}

export interface OrgEntry {
  id: string | null;
  file: string; // filename relative to org dir
  level: number;
  todo: string | null;
  priority: "A" | "B" | "C" | null;
  headline: string; // title text only, no stars/todo/priority/tags
  tags: string[];
  scheduled: { date: string; time: string | null } | null;
  deadline: { date: string; time: string | null } | null;
  closed: { date: string; time: string | null } | null;
  properties: Record<string, string>;
  body: string; // free-text body, excluding the properties drawer and planning line
}
