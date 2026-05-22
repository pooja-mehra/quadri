"use client";

// Today's calendar — two streams merged into one strip:
//   1. Google Calendar events (read via /api/calendar/today)
//   2. User-scheduled signals from the modal (slots written into
//      daily_slots when the user picks a time today)
//
// Each chip opens ItemDetailModal seeded with the right ref so the
// user can mark done, draft a reply, or edit the schedule. The
// "Sync to Google" button pushes everything currently in
// daily_slots (i.e. the scheduled items the user added) to the
// user's primary Google Calendar via /api/calendar/sync-today.
//
// Visual differentiation:
//   - Google Calendar events:   neutral grey background
//   - Live calendar event:      sky border + sky-50 bg
//   - User-scheduled item:      indigo border + indigo-50 bg
//   - Done (either kind):       emerald w/ strikethrough

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Calendar as CalendarIcon, RefreshCw, Loader2, Download } from "lucide-react";
import { ItemDetailModal } from "@/components/item-detail-modal";
import { cn } from "@/lib/utils";

type CalendarEvent = {
  id: string;
  title: string;
  start_min: number;
  duration_min: number;
};

type SlotRow = {
  slot_id: string;
  slot_start_min: number;
  duration_min: number | null;
  item_ref_id: string | null;
  item_text: string | null;
  source_event_id: string | null;
  done: boolean | null;
  unscheduled: boolean | null;
};

type StripChip = {
  key: string;
  signalId?: string;
  actionId?: string;
  // The raw item_ref_id that produced this chip — used by Remove
  // from calendar to delete the underlying daily_slots row.
  refId?: string;
  title: string;
  start_min: number;
  duration_min: number;
  done: boolean;
  kind: "calendar" | "scheduled";
};

// Action IDs are UUIDs; signal IDs always carry a source prefix
// (`gmail:`, `cal:`, `sheet:`, ...). Using the colon as the
// discriminator lets us route the modal to /api/actions/<id> when
// there really is a draft action, and to /api/signals/<id> when
// it's a raw signal — instead of passing the same ref into both.
function isActionUuid(ref: string | null | undefined): boolean {
  if (!ref) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    ref,
  );
}

function fmtClock(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  if (m === 0) return `${h12} ${ampm}`;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function CalendarStrip({
  planDate,
  externalRefreshKey = 0,
}: {
  planDate: string;
  // Bumped by the parent on any state refresh (modal Done/Send,
  // saveSchedule onChanged, etc.). Combined with the strip's own
  // refreshKey so changes made from *any* surface — focus card
  // modal, chat dock, our own chip modal — surface here without a
  // page reload.
  externalRefreshKey?: number;
}) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [slots, setSlots] = useState<SlotRow[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const [openChip, setOpenChip] = useState<StripChip | null>(null);

  // Refetch both feeds whenever anything could have changed: planDate
  // change, modal close (internal refreshKey), or parent-driven event
  // (externalRefreshKey). Removing a Google-source event needs the
  // events feed to redraw, so internal refreshKey has to drive it too.
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let cancelled = false;
    fetch(
      `/api/calendar/today?plan_date=${encodeURIComponent(planDate)}&tz=${encodeURIComponent(tz)}`,
      { cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((data: { events: CalendarEvent[] }) => {
        if (!cancelled) {
          setEvents(
            (data.events ?? []).slice().sort((a, b) => a.start_min - b.start_min),
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [planDate, refreshKey, externalRefreshKey]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/slots?plan_date=${encodeURIComponent(planDate)}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : { slots: [] }))
      .then((data: { slots?: SlotRow[] }) => {
        if (!cancelled) setSlots(data.slots ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [planDate, refreshKey, externalRefreshKey]);

  // Index calendar-event done state from slots.
  const doneEventIds = new Set<string>();
  for (const s of slots) {
    if (s.done && s.source_event_id) doneEventIds.add(s.source_event_id);
  }

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // Keep chips on the strip for 2 hours after they end so the user has
  // a chance to mark them done / reflect / capture a note before the
  // chip falls off the bar. Done chips stay until midnight regardless.
  const KEEP_AFTER_END_MIN = 120;

  // Build the merged chip list. Calendar events first; then scheduled
  // user items (slots with item_text, slot_start_min > 0, no source
  // event linkage — i.e. NOT auto-imported from Google Calendar).
  const chips: StripChip[] = [];

  for (const e of events) {
    const endedLongAgo =
      e.start_min + e.duration_min + KEEP_AFTER_END_MIN <= nowMin;
    const isDone = doneEventIds.has(e.id);
    if (endedLongAgo && !isDone) continue;
    // Calendar events get promoted into daily_slots with id
    // `cal_<event_id>` (deterministic). Find that slot if it exists
    // so the Remove button can DELETE it; otherwise use the synthetic
    // form so the modal's Remove path still has something to send.
    const calSlot = slots.find(
      (s) => s.source_event_id === e.id && (s.item_ref_id || s.slot_id),
    );
    const refForRemove =
      calSlot?.item_ref_id ?? `cal_${e.id}`;
    chips.push({
      key: `cal-${e.id}`,
      signalId: `cal:${e.id}`,
      refId: refForRemove,
      title: e.title,
      start_min: e.start_min,
      duration_min: e.duration_min,
      done: isDone,
      kind: "calendar",
    });
  }

  const SCHED_STRIDE_MIN = 1; // anything with a real (non-zero) start
  for (const s of slots) {
    if (!s.item_text) continue;
    if (s.unscheduled) continue;
    if (s.source_event_id) continue; // already covered as a calendar event above
    if (!s.slot_start_min || s.slot_start_min < SCHED_STRIDE_MIN) continue;
    const dur = s.duration_min ?? 15;
    const endedLongAgo = s.slot_start_min + dur + KEEP_AFTER_END_MIN <= nowMin;
    if (endedLongAgo && !s.done) continue;
    const refIsAction = isActionUuid(s.item_ref_id);
    chips.push({
      key: `sched-${s.slot_id}`,
      // Route action-shaped refs to /api/actions/<id> so the modal
      // renders the editable draft. Signal-shaped refs (gmail:,
      // sheet:, cal:) go to /api/signals/<id> for read-only context.
      actionId: refIsAction ? s.item_ref_id ?? undefined : undefined,
      signalId: refIsAction ? undefined : s.item_ref_id ?? undefined,
      refId: s.item_ref_id ?? undefined,
      title: s.item_text,
      start_min: s.slot_start_min,
      duration_min: dur,
      done: !!s.done,
      kind: "scheduled",
    });
  }

  chips.sort((a, b) => a.start_min - b.start_min);

  // The Sync button is meaningful only when there's at least one
  // user-scheduled item (calendar events are already on Google).
  const hasScheduledItems = chips.some((c) => c.kind === "scheduled");

  async function syncToGoogle() {
    if (syncing) return;
    setSyncing(true);
    try {
      const r = await fetch("/api/calendar/sync-today", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_date: planDate }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        toast.error(data.error ?? "Sync failed");
        return;
      }
      const data = await r.json().catch(() => ({}));
      const n =
        typeof data.synced === "number"
          ? data.synced
          : typeof data.count === "number"
            ? data.count
            : null;
      toast.success(
        n !== null
          ? `Synced ${n} item${n === 1 ? "" : "s"} to Google Calendar`
          : "Synced to Google Calendar",
      );
      // Refetch slots — sync writes google_event_id into rows so
      // re-runs are idempotent; refreshing lets the UI reflect the
      // post-sync state.
      setRefreshKey((k) => k + 1);
    } finally {
      setSyncing(false);
    }
  }

  if (chips.length === 0) return null;

  return (
    <>
      <div className="rounded-md border border-neutral-200 bg-white px-3 py-2">
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
          <CalendarIcon className="size-3" aria-hidden />
          Today on your calendar
          <div className="ml-auto flex items-center gap-1.5">
            {hasScheduledItems ? (
              <button
                type="button"
                onClick={() => void syncToGoogle()}
                disabled={syncing}
                title="Push scheduled items to Google Calendar"
                className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-[10px] normal-case font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
              >
                {syncing ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="size-3" aria-hidden />
                )}
                {syncing ? "Syncing…" : "Sync with Google Calendar"}
              </button>
            ) : null}
            <a
              href="/api/notes/export"
              download
              title="Download your notes CSV"
              className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-[10px] normal-case font-medium text-neutral-700 hover:bg-neutral-50"
            >
              <Download className="size-3" aria-hidden />
              Export notes
            </a>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => {
            const isLive =
              nowMin >= c.start_min && nowMin < c.start_min + c.duration_min;
            const classes = c.done
              ? "border-emerald-200 bg-emerald-50 text-emerald-700 line-through decoration-emerald-400"
              : c.kind === "scheduled"
                ? isLive
                  ? "border-indigo-300 bg-indigo-50 text-indigo-900 hover:bg-indigo-100"
                  : "border-indigo-200 bg-indigo-50/60 text-indigo-800 hover:bg-indigo-100"
                : isLive
                  ? "border-sky-300 bg-sky-50 text-sky-900 hover:bg-sky-100"
                  : "border-neutral-200 bg-neutral-50 text-neutral-800 hover:bg-neutral-100";
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setOpenChip(c)}
                className={cn(
                  "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors",
                  classes,
                )}
                title={c.title}
              >
                <span className="font-medium tabular-nums">
                  {fmtClock(c.start_min)}
                </span>
                <span className="line-clamp-1 max-w-[180px]">{c.title}</span>
              </button>
            );
          })}
        </div>
      </div>

      <ItemDetailModal
        open={openChip !== null}
        onClose={() => {
          setOpenChip(null);
          setRefreshKey((k) => k + 1);
        }}
        signalId={openChip?.signalId}
        actionId={openChip?.actionId}
        title={openChip?.title ?? ""}
        alreadyInToday={true}
        onChanged={() => setRefreshKey((k) => k + 1)}
        planDate={planDate}
        // The strip lets the user click any chip → modal → Remove
        // from calendar. removableRefId is the daily_slots
        // item_ref_id we delete on click; the endpoint also tears
        // down the Google Calendar event if the slot was previously
        // synced.
        removableRefId={openChip?.refId}
      />
    </>
  );
}
