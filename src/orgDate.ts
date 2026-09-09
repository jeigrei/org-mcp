const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface OrgTimestamp {
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM
  active: boolean;
}

/** Parses a user-supplied date string ("YYYY-MM-DD" or "YYYY-MM-DD HH:MM") into parts. */
export function parseInputDate(input: string): { date: string; time: string | null } {
  const m = input.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?$/);
  if (!m) {
    throw new Error(`Invalid date "${input}". Expected YYYY-MM-DD or "YYYY-MM-DD HH:MM".`);
  }
  return { date: m[1], time: m[2] ?? null };
}

function weekdayFor(dateStr: string): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  // Construct in UTC to avoid local-timezone day shifting.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return WEEKDAYS[dt.getUTCDay()];
}

/** Formats an org timestamp string, e.g. "<2026-08-20 Thu>" or "[2026-08-19 Wed 10:00]". */
export function formatOrgTimestamp(date: string, time: string | null, active: boolean): string {
  const wd = weekdayFor(date);
  const open = active ? "<" : "[";
  const close = active ? ">" : "]";
  return time ? `${open}${date} ${wd} ${time}${close}` : `${open}${date} ${wd}${close}`;
}

/**
 * Parses an org timestamp found in file text, e.g. "<2026-08-20 Thu>",
 * "[2026-08-19 Wed 10:00]", "<2026-08-20 Thu +1w>", or "<2026-08-20 Thu 10:00-11:00>".
 * Only the leading date/weekday/time are extracted; trailing repeater cookies or
 * time ranges are ignored (but the raw text should be preserved verbatim elsewhere).
 */
export function parseOrgTimestamp(text: string): OrgTimestamp | null {
  const m = text.match(/([<[])(\d{4}-\d{2}-\d{2})(?:\s+\w+)?(?:\s+(\d{2}:\d{2})(?:-\d{2}:\d{2})?)?/);
  if (!m) return null;
  return { date: m[2], time: m[3] ?? null, active: m[1] === "<" };
}

export function todayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

export function nowStamp(): { date: string; time: string } {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return { date: `${y}-${mo}-${d}`, time: `${hh}:${mm}` };
}

/** Compares two YYYY-MM-DD date strings. */
export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addDays(dateStr: string, days: number): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const y2 = dt.getUTCFullYear();
  const mo2 = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d2 = String(dt.getUTCDate()).padStart(2, "0");
  return `${y2}-${mo2}-${d2}`;
}
