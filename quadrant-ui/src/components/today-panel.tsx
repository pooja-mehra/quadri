"use client";

import { useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  FileText,
  Goal,
  GripVertical,
  Mail,
  X,
} from "lucide-react";
import { useDraggable } from "@dnd-kit/core";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { LiveStatus } from "@/lib/today-helpers";
import type { PlanItem } from "@/lib/types";

const MAX_VISIBLE = 3;

const STATUS_TONE: Record<LiveStatus, string> = {
  pending: "border-sky-400 bg-sky-100 text-sky-900",
  committed: "border-amber-400 bg-amber-100 text-amber-900",
  done: "border-emerald-400 bg-emerald-100 text-emerald-900",
  cancelled: "border-rose-400 bg-rose-100 text-rose-900",
  unknown: "border-foreground/20 bg-muted text-foreground/55",
};

const STATUS_LABEL: Record<LiveStatus, string> = {
  pending: "pending",
  committed: "committed",
  done: "done",
  cancelled: "cancelled",
  unknown: "—",
};

export type PanelItem = { item: PlanItem; status: LiveStatus };

// Infer which upstream source (email / drive / goal / etc.) a plan
// item is grounded in. We prefer cited_signal_ids — it directly names
// the signals the LLM used — and fall back to the source field for
// items that have no citations.
type SourceKind = "email" | "drive" | "goal" | "calendar" | null;
function inferSource(item: PlanItem): SourceKind {
  const citations = item.cited_signal_ids ?? [];
  if (citations.some((s) => s.startsWith("gmail:"))) return "email";
  if (citations.some((s) => s.startsWith("drive_doc:"))) return "drive";
  if (citations.some((s) => s.startsWith("cal:"))) return "calendar";
  if (item.source === "goal") return "goal";
  // pending_action without citations: fall back to inspecting source_ref_id.
  const ref = item.source_ref_id ?? "";
  if (ref.startsWith("gmail:")) return "email";
  if (ref.startsWith("drive_doc:")) return "drive";
  if (ref.startsWith("cal:")) return "calendar";
  return null;
}
const SOURCE_META: Record<
  Exclude<SourceKind, null>,
  { icon: typeof Mail; label: string; cls: string }
> = {
  email: { icon: Mail, label: "Email", cls: "bg-sky-50 text-sky-800 border-sky-200" },
  drive: { icon: FileText, label: "Drive", cls: "bg-violet-50 text-violet-800 border-violet-200" },
  goal: { icon: Goal, label: "Goal", cls: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  calendar: { icon: CalendarClock, label: "Calendar", cls: "bg-amber-50 text-amber-800 border-amber-200" },
};

export function TodayPanel({
  items,
  onDelete,
}: {
  items: PanelItem[];
  onDelete: (item: PlanItem) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  if (items.length === 0) {
    return (
      <div className="px-4 py-4 text-center text-sm italic text-foreground/50">
        Nothing left to slot — drag from here whenever new priorities appear.
      </div>
    );
  }

  const visible = showAll ? items : items.slice(0, MAX_VISIBLE);
  const hidden = items.length - visible.length;

  // Renumber ranked items from 1 based on display position, so the user
  // doesn't see "2, 3, 4" when item #1 happens to be slotted/done. Calendar
  // synths (rank === 0) keep the calendar-clock icon — they don't count
  // toward the visible numbering.
  let visibleRank = 0;
  return (
    <div className="px-4 py-3">
      <ol className="space-y-2">
        {visible.map(({ item, status }) => {
          const isRanked = item.rank > 0;
          if (isRanked) visibleRank += 1;
          return (
            <PlanItemRow
              key={item.source_ref_id ?? `rank:${item.rank}`}
              item={item}
              displayRank={isRanked ? visibleRank : 0}
              status={status}
              onDelete={() => onDelete(item)}
            />
          );
        })}
      </ol>

      {items.length > MAX_VISIBLE ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-foreground/60 hover:text-foreground"
        >
          {showAll ? (
            <>
              <ChevronUp className="size-3" aria-hidden /> Show less
            </>
          ) : (
            <>
              <ChevronDown className="size-3" aria-hidden /> Show {hidden} more
            </>
          )}
        </button>
      ) : null}
    </div>
  );
}

function PlanItemRow({
  item,
  displayRank,
  status,
  onDelete,
}: {
  item: PlanItem;
  displayRank: number;
  status: LiveStatus;
  onDelete: () => void;
}) {
  const draggable = status !== "done";
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `today:${item.rank}`,
    data: { kind: "todayItem", item },
    disabled: !draggable,
  });

  return (
    <li
      ref={setNodeRef}
      className={cn(
        "flex items-start gap-3 rounded-lg border bg-background/80 px-2.5 py-2 text-sm shadow-sm transition-shadow",
        draggable && "hover:shadow-md",
        isDragging && "opacity-30",
        // Today panel treats pending and committed identically — once it's
        // here it's just "to slot". Done stays visually distinct.
        status === "done"
          ? "border-emerald-300 bg-emerald-50"
          : "border-foreground/10",
      )}
    >
      {draggable ? (
        <button
          type="button"
          {...listeners}
          {...attributes}
          className="mt-0.5 cursor-grab touch-none text-foreground/40 hover:text-foreground/70 active:cursor-grabbing"
          aria-label={`Drag ${item.text}`}
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
      ) : (
        <span className="mt-0.5 size-4 shrink-0" aria-hidden />
      )}
      {displayRank > 0 ? (
        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-xs font-bold tabular-nums text-foreground">
          {displayRank}
        </span>
      ) : (
        <span
          className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600"
          title="Unscheduled calendar event"
        >
          <CalendarClock className="size-3" aria-hidden />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "leading-snug",
            status === "done" ? "text-foreground/55 line-through" : "text-foreground",
          )}
        >
          {item.text}
        </div>
        {(() => {
          const kind = inferSource(item);
          if (!kind) return null;
          const meta = SOURCE_META[kind];
          const Icon = meta.icon;
          return (
            <div className="mt-1 flex items-center">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium",
                  meta.cls,
                )}
              >
                <Icon className="size-3" aria-hidden />
                {meta.label}
              </span>
            </div>
          );
        })()}
      </div>
      {status === "done" ? (
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 text-[10px] font-semibold uppercase",
            STATUS_TONE.done,
          )}
        >
          {STATUS_LABEL.done}
        </Badge>
      ) : null}
      <button
        type="button"
        onClick={onDelete}
        className="mt-0.5 shrink-0 rounded-md p-0.5 text-foreground/40 hover:bg-rose-100 hover:text-rose-700"
        aria-label="Delete item"
        title="Delete (rejects the underlying action)"
      >
        <X className="size-4" aria-hidden />
      </button>
    </li>
  );
}
