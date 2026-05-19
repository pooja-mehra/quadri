import type { DashboardState, PlanItem } from "./types";

export type LiveStatus = "pending" | "committed" | "done" | "cancelled" | "unknown";

export function liveStatus(item: PlanItem, state: DashboardState | null): LiveStatus {
  if (!state || !item.source_ref_id) return "unknown";
  if (item.source === "pending_action" || item.source === "committed_action") {
    if (state.pending_actions.some((a) => a.action_id === item.source_ref_id)) return "pending";
    const committed = state.committed_actions.find(
      (a) => a.action_id === item.source_ref_id,
    );
    if (committed) {
      if (committed.cancelled) return "cancelled";
      return committed.done ? "done" : "committed";
    }
    return "done";  // dropped from both lists (week-filtered, etc.)
  }
  return "unknown";
}

// Calendar event shape returned from /api/calendar/today (Fivetran-synced
// → classifier → quadrant_signals). Per-event in user-local minutes.
export type CalendarEvent = {
  id: string;
  start_min: number;
  duration_min: number;
  title: string;
  quadrant?: string | null;
  calendar?: string | null;
};

export function calendarEventAt(
  startMin: number,
  events: CalendarEvent[],
): CalendarEvent | null {
  for (const e of events) {
    if (startMin >= e.start_min && startMin < e.start_min + e.duration_min) {
      return e;
    }
  }
  return null;
}

// Round the current local time down to the nearest slot boundary.
export function nowSlotMin(slotMin: number): number {
  const now = new Date();
  const m = now.getHours() * 60 + now.getMinutes();
  return Math.floor(m / slotMin) * slotMin;
}
