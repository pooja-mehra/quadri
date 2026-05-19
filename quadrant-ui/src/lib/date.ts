// User-local ISO date (YYYY-MM-DD) for the plan-today loop.
// Plans are partitioned by user-local date so "today" matches what the user
// sees on their wall clock, not UTC.
export function todayLocalISO(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
