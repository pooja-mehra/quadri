// Parse a free-text deep_work_hours string ("9am-noon", "9:30am-6pm",
// "9-17") into a {start, end} pair in minutes-from-midnight.
//
// Robust to a few common formats; falls back to 9am-6pm on parse failure
// so the time bar always renders something usable.

const FALLBACK = { start: 9 * 60, end: 18 * 60 } as const;

export type WorkHours = { start: number; end: number };

export function parseWorkHours(input: string | null | undefined): WorkHours {
  if (!input) return { ...FALLBACK };
  const cleaned = input.toLowerCase().replace(/\s+/g, "");

  // Tolerate dashes, en-dashes, "to".
  const parts = cleaned.split(/-|–|—|to/);
  if (parts.length < 2) return { ...FALLBACK };

  const start = parseTimeToken(parts[0]);
  const end = parseTimeToken(parts[1]);
  if (start == null || end == null || end <= start) return { ...FALLBACK };
  return { start, end };
}

function parseTimeToken(token: string): number | null {
  const t = token.trim();
  if (!t) return null;
  if (t === "noon") return 12 * 60;
  if (t === "midnight") return 0;

  // "9am" "9:30am" "12pm" "9" "9:30" "17" "17:00"
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3];
  if (Number.isNaN(h) || Number.isNaN(min)) return null;

  if (meridiem === "am") {
    if (h === 12) h = 0;
  } else if (meridiem === "pm") {
    if (h !== 12) h += 12;
  }
  // No meridiem: assume 24h if h > 12, otherwise leave as-is.

  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function formatMinutes(mins: number): string {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const meridiem = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12}${meridiem}` : `${h12}:${String(m).padStart(2, "0")}${meridiem}`;
}
