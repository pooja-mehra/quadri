// Cascade-right insertion for the time-slot bar.
//
// Drop an item at `targetStart`. If empty: just place. If occupied: existing
// item shifts to its next free non-calendar slot; if THAT slot was also
// occupied, the chain continues. Returns null when the chain runs past
// `hoursEnd` (no room).

import { calendarEventAt, type CalendarEvent } from "./today-helpers";
import { type Slot, makeSlotId } from "./slots-storage";
import type { PlanItem } from "./types";

export const SLOT_MIN_DEFAULT = 15;

export function cascadePlace(
  current: Slot[],
  payload:
    | { kind: "todayItem"; item: PlanItem }
    | { kind: "slotted"; slot: Slot },
  targetStart: number,
  hoursEnd: number,
  calendarEvents: CalendarEvent[],
  slotMin: number = SLOT_MIN_DEFAULT,
): Slot[] | null {
  if (calendarEventAt(targetStart, calendarEvents)) return null;

  // Working copy. If moving an existing slotted item, vacate its source.
  let working: Slot[] = current.map((s) => ({ ...s }));
  if (payload.kind === "slotted") {
    working = working.filter((s) => s.slot_id !== payload.slot.slot_id);
  }

  // Walk forward from targetStart, collecting consecutive blocked slots.
  // Calendar events don't count as "shiftable" — they break the chain
  // (the cascade jumps past them when finding new homes).
  const blocked: Slot[] = [];
  let cursor = targetStart;
  // Cap the walk to the working-hour end.
  while (cursor < hoursEnd) {
    const cal = calendarEventAt(cursor, calendarEvents);
    if (cal) {
      cursor = cal.start_min + cal.duration_min;
      continue;
    }
    const here = working.find((s) => s.slot_start_min === cursor);
    if (!here) break;
    blocked.push(here);
    cursor += slotMin;
  }

  // Process right-to-left so each shift opens space for the one before.
  for (let i = blocked.length - 1; i >= 0; i--) {
    const s = blocked[i];
    let newPos = s.slot_start_min + slotMin;
    while (newPos < hoursEnd) {
      const occupied = working.some(
        (w) => w.slot_id !== s.slot_id && w.slot_start_min === newPos,
      );
      if (calendarEventAt(newPos, calendarEvents) || occupied) {
        newPos += slotMin;
        continue;
      }
      break;
    }
    if (newPos >= hoursEnd) return null;
    s.slot_start_min = newPos;
  }

  // Place the dragged item at targetStart.
  if (payload.kind === "todayItem") {
    if (!payload.item.source_ref_id) return null;
    working.push({
      slot_id: makeSlotId(),
      slot_start_min: targetStart,
      item_kind: payload.item.source,
      item_ref_id: payload.item.source_ref_id,
      item_text: payload.item.text,
    });
  } else {
    working.push({ ...payload.slot, slot_start_min: targetStart });
  }
  return working;
}
