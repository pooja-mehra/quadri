// Slot persistence — write-through cache: localStorage for instant
// synchronous reads/writes (so DnD stays smooth), BigQuery via /api/slots
// for the durable record. The BQ row is the source of truth; localStorage
// is just the fast path for "current day in this browser". Past and
// future dates fetch from BQ.

import type { PlanItem } from "./types";

export type Slot = {
  slot_id: string;
  slot_start_min: number;        // minutes from midnight
  item_kind: PlanItem["source"];
  item_ref_id: string;            // action_id, or event_id for calendar-imported
  item_text: string;              // snapshot for display
  // Auto-send fields — only meaningful for email_draft slots. Set at commit
  // time (drag-to-slot) so a background timer can fire the send at the
  // middle of the slot. User can disable via the slot modal checkbox.
  auto_send_enabled?: boolean;
  auto_send_at_iso?: string;     // ISO timestamp, slot_start + 7 min
  // Calendar-imported slot fields. Presence of `source_event_id` is the
  // discriminator. Promoted from /api/calendar/today on dashboard load
  // (idempotent — re-fetches skip already-promoted events).
  source_event_id?: string;      // Google Calendar event id
  duration_min?: number;         // event duration; drives multi-cell span
  done?: boolean;                // local mark-done flag (calendar-imported only)
  original_slot_start_min?: number;  // for "moved · original 7 AM" indicator
  // When user × out of a calendar-imported slot, we don't delete it — we
  // park it in the today list. From there they can drag back to a new time
  // or × from the panel to delete entirely.
  unscheduled?: boolean;
};

const KEY = (planDate: string) => `quadri:slots:${planDate}`;

export function readSlots(planDate: string): Slot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY(planDate));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr as Slot[];
  } catch {
    return [];
  }
}

export function writeSlots(planDate: string, slots: Slot[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY(planDate), JSON.stringify(slots));
  } catch {
    // ignore
  }
  // Fire-and-forget POST to persist into BigQuery so past/future days are
  // queryable and survive browser clear. Errors are swallowed — local
  // cache stays correct, sync will reconcile on next page load.
  void persistSlotsRemote(planDate, slots).catch((e) => {
    console.warn("slot remote persist failed:", e);
  });
}

async function persistSlotsRemote(
  planDate: string,
  slots: Slot[],
): Promise<void> {
  await fetch("/api/slots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan_date: planDate, slots }),
  });
}

// Fetch the canonical slot set for a date from BigQuery. Use this on
// mount to reconcile localStorage with the durable store (covers
// cross-device, browser-clear, and past/future date views).
export async function fetchSlotsRemote(planDate: string): Promise<Slot[] | null> {
  try {
    const r = await fetch(
      `/api/slots?plan_date=${encodeURIComponent(planDate)}`,
      { cache: "no-store" },
    );
    if (!r.ok) return null;
    const data = (await r.json()) as { slots?: Slot[] };
    return data.slots ?? [];
  } catch {
    return null;
  }
}

export function makeSlotId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `slot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
