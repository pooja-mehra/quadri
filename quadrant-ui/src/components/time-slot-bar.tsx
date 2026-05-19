"use client";

import { useMemo, useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatMinutes } from "@/lib/work-hours";
import { type Slot } from "@/lib/slots-storage";
import {
  type CalendarEvent,
  type LiveStatus,
} from "@/lib/today-helpers";
import type { DashboardState } from "@/lib/types";

export const SLOT_MIN = 15;          // 15-min granularity (locked)
const HOUR_LABEL_EVERY = 4;          // every hour at 15-min granularity

// Always-visible window: 12 AM – 11:59 PM (full 24h). Split into 4
// rows of 6 hours each (24 cells per row at 15-min granularity).
// Replaced the prior sliding-window+expand-buttons UI 2026-05-16.
export const DAY_START_MIN = 0;             // 12 AM
export const DAY_END_MIN = 24 * 60;         // 11:59 PM
const HOURS_PER_ROW = 6;
const CELLS_PER_ROW = (HOURS_PER_ROW * 60) / SLOT_MIN;  // 24

// Status-driven coloring for slotted items. Vibrant tones per state.
const STATUS_BG: Record<LiveStatus, string> = {
  pending: "border-sky-500 bg-gradient-to-br from-sky-100 to-sky-200 text-sky-900",
  committed: "border-amber-500 bg-gradient-to-br from-amber-100 to-amber-200 text-amber-900",
  done: "border-emerald-500 bg-gradient-to-br from-emerald-100 to-emerald-200 text-emerald-900",
  cancelled: "border-rose-500 bg-gradient-to-br from-rose-100 to-rose-200 text-rose-900",
  unknown: "border-foreground/30 bg-muted text-foreground/70",
};

export function TimeSlotBar({
  slots,
  statusByRefId,
  calendarEvents,
  onRemoveSlot,
  onSlotClick,
  planDate,
}: {
  state: DashboardState | null;  // kept for future per-user pref wiring
  slots: Slot[];
  statusByRefId: Map<string, LiveStatus>;
  calendarEvents: CalendarEvent[];
  onRemoveSlot: (slotId: string) => void;
  onSlotClick?: (slotId: string) => void;
  // Which date the bar is showing — defaults to today. Drives the
  // "is this slot in the past?" lock so future-date views don't grey
  // out 9 AM just because it's 2 PM right now.
  planDate?: string;
}) {
  // "now" reference. Only meaningful when planDate = today (or omitted).
  // For past dates: every slot is past. For future dates: every slot is
  // future. We compute a comparable minute-of-day relative to the bar's
  // planDate: -Infinity (future bar) or +Infinity (past bar) collapses
  // the isPast check cleanly.
  const todayPT = (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  })();
  const nowMin = (() => {
    if (!planDate || planDate === todayPT) {
      const d = new Date();
      return d.getHours() * 60 + d.getMinutes();
    }
    if (planDate < todayPT) {
      // Bar is showing a past day — all slots are past.
      return Number.POSITIVE_INFINITY;
    }
    // Bar is showing a future day — nothing is past.
    return Number.NEGATIVE_INFINITY;
  })();

  // Compute cells "consumed" by multi-cell slots so we skip rendering
  // them as their own droppable cells (the parent slot already covers
  // them).
  const consumedCells = useMemo(() => {
    const out = new Set<number>();
    for (const s of slots) {
      const dur = s.duration_min ?? SLOT_MIN;
      if (dur <= SLOT_MIN) continue;
      const span = Math.ceil(dur / SLOT_MIN);
      for (let i = 1; i < span; i++) {
        out.add(s.slot_start_min + i * SLOT_MIN);
      }
    }
    return out;
  }, [slots]);

  // Build the per-row slot lists. Window is always DAY_START_MIN to
  // DAY_END_MIN now (no more sliding window).
  const rows = useMemo(() => {
    const out: number[][] = [];
    for (let rowStart = DAY_START_MIN; rowStart < DAY_END_MIN; rowStart += HOURS_PER_ROW * 60) {
      const row: number[] = [];
      for (let m = rowStart; m < rowStart + HOURS_PER_ROW * 60 && m < DAY_END_MIN; m += SLOT_MIN) {
        row.push(m);
      }
      out.push(row);
    }
    return out;
  }, []);

  // Native HTML5 drop handler shared by every cell. Reads the
  // application/x-quadri-action payload from FocusCard's title drag.
  // Optimistic: fires quadri:slot-added IMMEDIATELY so the focus card
  // advances and the bar shows the slot; POSTs to /api/slots/add in
  // the background. On failure dispatches quadri:slot-failed so
  // listeners can revert. dnd-kit's pointer-based DnD doesn't see
  // HTML5 drag events, so the two systems coexist cleanly.
  function onDropFromFocusCard(startMin: number, e: React.DragEvent) {
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/x-quadri-action");
    if (!raw) return;
    let payload: { ref_id?: string; text?: string; kind?: string } = {};
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (!payload.ref_id) return;

    const refId = payload.ref_id;
    const itemText = payload.text ?? "(no title)";
    const itemKind = payload.kind ?? "committed_action";
    const duration = SLOT_MIN;

    // Optimistic announce — focus card removes from queue, TodaySection
    // appends to its slots state.
    window.dispatchEvent(
      new CustomEvent("quadri:slot-added", {
        detail: {
          ref_id: refId,
          slot_start_min: startMin,
          duration_min: duration,
          item_text: itemText,
          item_kind: itemKind,
        },
      }),
    );

    // Background POST.
    void fetch("/api/slots/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan_date: planDate,
        slot_start_min: startMin,
        duration_min: duration,
        item_ref_id: refId,
        item_kind: itemKind,
        item_text: itemText,
      }),
    })
      .then(async (r) => {
        if (r.ok) {
          toast.success("Scheduled");
          window.dispatchEvent(
            new CustomEvent("quadri:slot-confirmed", {
              detail: { ref_id: refId, slot_start_min: startMin },
            }),
          );
          return;
        }
        const body = await r.json().catch(() => ({}));
        toast.error(body.error ?? "Couldn't schedule");
        window.dispatchEvent(
          new CustomEvent("quadri:slot-failed", {
            detail: {
              ref_id: refId,
              slot_start_min: startMin,
              duration_min: duration,
            },
          }),
        );
      })
      .catch(() => {
        toast.error("Network error scheduling");
        window.dispatchEvent(
          new CustomEvent("quadri:slot-failed", {
            detail: {
              ref_id: refId,
              slot_start_min: startMin,
              duration_min: duration,
            },
          }),
        );
      });
  }

  // Compute the default visible row range:
  //   • Start from the row that contains "now". For past-day views
  //     where nowMin is +Infinity, fall back to the last row.
  //   • Extend forward to include up to the next 2 filled, future
  //     slots. If they're in the same row as "now", we still show
  //     just that row.
  //   • If "now" is before DAY_START_MIN (nowMin = -Infinity for
  //     future-date views — though those are gated upstream), start
  //     at row 0.
  // The user can also click ↑ / ↓ chevrons to manually reveal more.
  const totalRows = rows.length;
  const defaultRange = useMemo(() => {
    const rowOfMin = (m: number): number => {
      if (!Number.isFinite(m)) {
        return m > 0 ? totalRows - 1 : 0;
      }
      const idx = Math.floor((m - DAY_START_MIN) / (HOURS_PER_ROW * 60));
      return Math.max(0, Math.min(totalRows - 1, idx));
    };
    const nowRow = rowOfMin(nowMin);
    // Find the next 2 future filled slots and figure out which row
    // they're in.
    const futureFilled = slots
      .filter(
        (s) =>
          !s.unscheduled &&
          !s.done &&
          s.slot_start_min + (s.duration_min ?? SLOT_MIN) > nowMin,
      )
      .sort((a, b) => a.slot_start_min - b.slot_start_min)
      .slice(0, 2);
    let bottomRow = nowRow;
    for (const s of futureFilled) {
      const sRow = rowOfMin(s.slot_start_min);
      if (sRow > bottomRow) bottomRow = sRow;
    }
    return { top: nowRow, bottom: bottomRow };
  }, [nowMin, slots, totalRows]);

  // User overrides — chevron clicks expand or collapse the visible
  // window. Offsets are signed: positive = expand (more rows), negative
  // = collapse (fewer rows than default). The clamps below keep
  // topRow ≤ bottomRow so at least one row is always visible.
  const [topOffset, setTopOffset] = useState(0);
  const [bottomOffset, setBottomOffset] = useState(0);
  const topRow = Math.max(
    0,
    Math.min(totalRows - 1, defaultRange.top - topOffset),
  );
  const bottomRow = Math.max(
    topRow,
    Math.min(totalRows - 1, defaultRange.bottom + bottomOffset),
  );
  const canExpandUp = topRow > 0;
  const canExpandDown = bottomRow < totalRows - 1;
  const canCollapseEither = bottomRow > topRow;
  const visibleRows = rows.slice(topRow, bottomRow + 1);

  return (
    <div className="space-y-1 px-3 py-3">
      {/* Top edge controls — ↑ expands upward; ↓ collapses the top
          row away. Both render side-by-side when both apply. */}
      {canExpandUp || canCollapseEither ? (
        <div className="flex w-full items-center justify-center gap-3 py-0.5 text-foreground/40">
          {canExpandUp ? (
            <button
              type="button"
              onClick={() => setTopOffset((n) => n + 1)}
              aria-label="Show earlier hours"
              title="Show earlier hours"
              className="rounded-md px-2 transition-colors hover:bg-foreground/[0.04] hover:text-foreground/70"
            >
              <ChevronUp className="size-4" aria-hidden />
            </button>
          ) : null}
          {canCollapseEither ? (
            <button
              type="button"
              onClick={() => setTopOffset((n) => n - 1)}
              aria-label="Hide top row"
              title="Hide top row"
              className="rounded-md px-2 transition-colors hover:bg-foreground/[0.04] hover:text-foreground/70"
            >
              <ChevronDown className="size-4" aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-2">
      {visibleRows.map((rowMins, rowIdxInWindow) => (
        <div key={topRow + rowIdxInWindow} className="flex gap-0.5">
          {rowMins.map((startMin, idx) => {
            if (consumedCells.has(startMin)) return null;

            const slot = slots.find((s) => s.slot_start_min === startMin);
            const showHourLabel = idx % HOUR_LABEL_EVERY === 0;
            const duration = slot?.duration_min ?? SLOT_MIN;
            const span = Math.max(1, Math.ceil(duration / SLOT_MIN));

            const resolved = slot ? statusByRefId.get(slot.item_ref_id) : undefined;
            const status: LiveStatus = !slot
              ? "unknown"
              : slot.done
                ? "done"
                : resolved === "done" || resolved === "cancelled"
                  ? resolved
                  : "committed";
            return (
              <SlotCell
                key={startMin}
                startMin={startMin}
                span={span}
                showHourLabel={showHourLabel}
                slot={slot}
                status={status}
                isPast={startMin + SLOT_MIN <= nowMin}
                onRemove={onRemoveSlot}
                onSlotClick={onSlotClick}
                onDropFromFocusCard={onDropFromFocusCard}
              />
            );
          })}
        </div>
      ))}
      </div>

      {/* Bottom edge controls — ↓ expands downward; ↑ collapses the
          bottom row away. */}
      {canExpandDown || canCollapseEither ? (
        <div className="flex w-full items-center justify-center gap-3 py-0.5 text-foreground/40">
          {canCollapseEither ? (
            <button
              type="button"
              onClick={() => setBottomOffset((n) => n - 1)}
              aria-label="Hide bottom row"
              title="Hide bottom row"
              className="rounded-md px-2 transition-colors hover:bg-foreground/[0.04] hover:text-foreground/70"
            >
              <ChevronUp className="size-4" aria-hidden />
            </button>
          ) : null}
          {canExpandDown ? (
            <button
              type="button"
              onClick={() => setBottomOffset((n) => n + 1)}
              aria-label="Show later hours"
              title="Show later hours"
              className="rounded-md px-2 transition-colors hover:bg-foreground/[0.04] hover:text-foreground/70"
            >
              <ChevronDown className="size-4" aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SlotCell({
  startMin,
  span,
  showHourLabel,
  slot,
  status,
  isPast,
  onRemove,
  onSlotClick,
  onDropFromFocusCard,
}: {
  startMin: number;
  span: number;
  showHourLabel: boolean;
  slot: Slot | undefined;
  status: LiveStatus;
  isPast: boolean;
  onRemove: (slotId: string) => void;
  onSlotClick?: (slotId: string) => void;
  onDropFromFocusCard: (startMin: number, e: React.DragEvent) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `slot:${startMin}`,
    data: { kind: "slot", startMin, occupiedBy: slot?.slot_id ?? null },
    disabled: isPast,
  });

  const filled = !!slot;

  // HTML5 native drop handling — the FocusCard's title drag uses
  // dataTransfer (application/x-quadri-action). dnd-kit uses pointer
  // events; the two systems coexist without interfering. We accept
  // drops on EMPTY cells that aren't in the past.
  //
  // dnd-kit's `isOver` doesn't fire for HTML5 drags, so we track the
  // dragover ourselves to get a visible highlight. Counter handles
  // dragenter / dragleave bouncing when the cursor crosses child
  // boundaries inside the cell.
  const acceptNative = !filled && !isPast;
  const [isNativeOver, setIsNativeOver] = useState(false);
  const dragDepth = useRef(0);

  return (
    <div
      ref={setNodeRef}
      onDragEnter={(e) => {
        if (!acceptNative) return;
        dragDepth.current += 1;
        // Don't gate on type-check here — Chrome sometimes hides the
        // type list until drop. We commit to accepting any HTML5 drag
        // visually; the drop handler validates the payload.
        e.preventDefault();
        setIsNativeOver(true);
      }}
      onDragOver={(e) => {
        if (!acceptNative) return;
        // dragover MUST preventDefault to allow drop. We do it for any
        // drag in flight; the drop handler validates.
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragLeave={() => {
        if (!acceptNative) return;
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setIsNativeOver(false);
        }
      }}
      onDrop={(e) => {
        dragDepth.current = 0;
        setIsNativeOver(false);
        if (!acceptNative) return;
        // Only complete schedule if the payload is ours.
        const raw = e.dataTransfer.getData("application/x-quadri-action");
        if (!raw) return;
        onDropFromFocusCard(startMin, e);
      }}
      className={cn(
        "relative flex-1 min-w-0 border-r border-foreground/10 last:border-r-0",
        isPast && "bg-foreground/[0.03]",
      )}
      aria-disabled={isPast || undefined}
      style={{ flexGrow: span }}
    >
      <HourLabel show={showHourLabel} startMin={startMin} />
      <div
        className={cn(
          "h-12 rounded-md border-2 transition-colors",
          filled
            ? cn(
                "shadow-sm",
                STATUS_BG[status],
                isPast && "opacity-55",
                isOver && !isPast && "ring-2 ring-indigo-500 ring-offset-1",
              )
            : isPast
              ? "border-dashed border-foreground/10 bg-foreground/[0.02]"
              : isOver || isNativeOver
                ? "border-solid border-indigo-500 bg-indigo-100 ring-2 ring-indigo-300"
                : "border-dashed border-foreground/15 bg-background/40",
        )}
      >
        {slot ? (
          <SlottedItem
            slot={slot}
            status={status}
            isPast={isPast}
            onRemove={onRemove}
            onSlotClick={onSlotClick}
          />
        ) : null}
      </div>
    </div>
  );
}

function HourLabel({ show, startMin }: { show: boolean; startMin: number }) {
  return show ? (
    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-foreground/55">
      {formatMinutes(startMin)}
    </div>
  ) : (
    <div className="mb-1 h-[14px]" aria-hidden />
  );
}

function SlottedItem({
  slot,
  status,
  isPast,
  onRemove,
  onSlotClick,
}: {
  slot: Slot;
  status: LiveStatus;
  isPast: boolean;
  onRemove: (slotId: string) => void;
  onSlotClick?: (slotId: string) => void;
}) {
  // Drag is locked once an item is terminal (done or cancelled) — "you
  // can't move what's already finished/dropped". Past, NOT-YET-terminal
  // items stay draggable so the user can push them forward.
  const isLocked = status === "done" || status === "cancelled";

  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `slotted:${slot.slot_id}`,
    data: { kind: "slotted", slot },
    disabled: isLocked,
  });

  // Compact clock label for the slot's actual start time. The
  // outer HourLabel only renders on hour boundaries, so anything at
  // e.g. 6:45 has no visible time anywhere — fix is to show it
  // inside the slot block itself.
  const startClock = formatMinutes(slot.slot_start_min);

  return (
    <div
      ref={setNodeRef}
      {...(isLocked ? {} : listeners)}
      {...(isLocked ? {} : attributes)}
      onClick={() => onSlotClick?.(slot.slot_id)}
      className={cn(
        "group relative flex h-full flex-col items-start justify-center gap-0.5 px-1.5 py-0.5",
        isLocked ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-30",
      )}
    >
      <span
        className={cn(
          "text-[9px] font-semibold uppercase leading-none tracking-wide opacity-75",
          status === "done" && "line-through",
          status === "cancelled" && "line-through decoration-rose-600",
        )}
      >
        {startClock}
      </span>
      <span
        className={cn(
          "line-clamp-2 text-[11px] font-semibold leading-tight",
          status === "done" && "line-through opacity-80",
          status === "cancelled" && "line-through decoration-rose-600 opacity-80",
        )}
      >
        {slot.item_text}
      </span>
      {isLocked ? null : (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(slot.slot_id);
          }}
          className="absolute right-1 top-1 hidden rounded-full bg-background/90 p-0.5 text-foreground/60 hover:bg-background hover:text-foreground group-hover:block"
          aria-label="Unslot"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
