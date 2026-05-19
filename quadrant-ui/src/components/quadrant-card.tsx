"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import confetti from "canvas-confetti";
import {
  Briefcase,
  Check,
  ChevronDown,
  ChevronUp,
  GraduationCap,
  GripVertical,
  Heart,
  ListPlus,
  Undo2,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useAnimatedNumber } from "@/lib/use-animated-number";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { decideAction, decideGoal, markSent, uncommit } from "@/lib/decisions";
import { ItemDetailModal } from "@/components/item-detail-modal";
import type {
  CommittedAction,
  Goal,
  PendingAction,
  QuadrantScore,
  TopSignal,
} from "@/lib/types";

type Quadrant = QuadrantScore["quadrant"];

type Meta = {
  Icon: LucideIcon;
  label: string;
  bg: string;
  border: string;
  borderStrong: string;  // used when the card is the most under-funded
  title: string;
  iconBg: string;
  chip: string;
  chipActive: string;
};

// Notion-style: cards are plain white with a thin grey border. Quadrant
// identity comes from the icon — no card-level color tint, no gradient.
const META: Record<Quadrant, Meta> = {
  health: {
    Icon: Heart,
    label: "Health",
    bg: "bg-white",
    border: "border-neutral-200",
    borderStrong: "border-neutral-400",
    title: "text-neutral-900",
    iconBg: "bg-neutral-100 text-neutral-700",
    chip: "border-neutral-200 bg-neutral-50 text-neutral-700 hover:bg-neutral-100",
    chipActive: "border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-800",
  },
  education: {
    Icon: GraduationCap,
    label: "Education",
    bg: "bg-white",
    border: "border-neutral-200",
    borderStrong: "border-neutral-400",
    title: "text-neutral-900",
    iconBg: "bg-neutral-100 text-neutral-700",
    chip: "border-neutral-200 bg-neutral-50 text-neutral-700 hover:bg-neutral-100",
    chipActive: "border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-800",
  },
  career: {
    Icon: Briefcase,
    label: "Career",
    bg: "bg-white",
    border: "border-neutral-200",
    borderStrong: "border-neutral-400",
    title: "text-neutral-900",
    iconBg: "bg-neutral-100 text-neutral-700",
    chip: "border-neutral-200 bg-neutral-50 text-neutral-700 hover:bg-neutral-100",
    chipActive: "border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-800",
  },
  relationships: {
    Icon: Users,
    label: "Relationships",
    bg: "bg-white",
    border: "border-neutral-200",
    borderStrong: "border-neutral-400",
    title: "text-neutral-900",
    iconBg: "bg-neutral-100 text-neutral-700",
    chip: "border-neutral-200 bg-neutral-50 text-neutral-700 hover:bg-neutral-100",
    chipActive: "border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-800",
  },
};

// Health-based background was a pastel gradient; we now keep cards
// neutral and let the score % carry the visual weight on its own.
function healthBg(_score: number): {
  bg: string;
  border: string;
  borderStrong: string;
} {
  return {
    bg: "bg-white",
    border: "border-neutral-200",
    borderStrong: "border-neutral-400",
  };
}

const VALENCE: Record<TopSignal["valence"], { cls: string; symbol: string }> = {
  positive: { cls: "bg-emerald-200 text-emerald-900", symbol: "+" },
  negative: { cls: "bg-rose-200 text-rose-900", symbol: "−" },
  neutral: { cls: "bg-slate-200 text-slate-700", symbol: "·" },
};

// Small colored dot prefixing each card-item line. Signals fall back to a
// valence-driven dot (existing behavior). Action-linked items get a state
// dot so the user can see at a glance what's drafted (sky) vs committed
// (amber).
function ItemStateBullet({
  state,
  valence,
}: {
  state: "signal" | "pending" | "committed" | "deferred";
  valence?: TopSignal["valence"];
}) {
  if (state === "signal") {
    return <ValenceBadge valence={valence ?? "neutral"} />;
  }
  // pending → sky, committed → amber, deferred → slate-with-ring (looks
  // "on hold" rather than active). Sized to match the other bullets.
  const color =
    state === "pending"
      ? "bg-sky-400"
      : state === "committed"
        ? "bg-amber-400"
        : "border-2 border-neutral-400 bg-white";
  return (
    <span
      className={cn("mt-1.5 inline-block size-2 shrink-0 rounded-full", color)}
      aria-hidden
    />
  );
}

function ValenceBadge({ valence }: { valence: TopSignal["valence"] }) {
  const v = VALENCE[valence];
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-sm font-bold leading-none",
        v.cls,
      )}
      aria-hidden
    >
      {v.symbol}
    </span>
  );
}

const ACTION_TYPE_LABEL: Record<PendingAction["action_type"], string> = {
  email_draft: "Email",
  text_draft: "Text",
  calendar_event: "Calendar",
};

function ageLabel(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Day-of-week + day-of-month chip for the bullet list: "Mon 11", "Sat 17".
// Server filters to current week so we never need a month-day fallback. For
// calendar-source signals we ALSO append the clock time, since the event
// title doesn't always embed it (e.g., "doc appointment"). Doc / sheet
// items keep date-only — their occurred_at is a deadline, not a clock.
function formatSignalDate(
  iso: string | null,
  source?: string | null,
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
  const base = `${weekday} ${d.getDate()}`;
  if (source === "calendar") {
    const hh = d.getHours();
    const mm = d.getMinutes();
    if (hh === 0 && mm === 0) return base; // all-day event — no clock
    const hr12 = hh % 12 === 0 ? 12 : hh % 12;
    const ampm = hh < 12 ? "a" : "p";
    const clock =
      mm === 0
        ? `${hr12}${ampm}`
        : `${hr12}:${String(mm).padStart(2, "0")}${ampm}`;
    return `${base} ${clock}`;
  }
  return base;
}

export function QuadrantCard({
  score,
  isMostUnderFunded,
  pendingActions,
  committedActions,
  activeGoals,
  proposedGoals,
  onChanged,
  inTodayRefs,
  committedTodayRefs,
  doneTodayRefs,
  doneWeekRefs,
}: {
  score: QuadrantScore;
  isMostUnderFunded: boolean;
  pendingActions: PendingAction[];
  committedActions: CommittedAction[];
  activeGoals: Goal[];
  proposedGoals: Goal[];
  onChanged: () => void;
  // action_ids and signal_ids currently represented in the Today panel.
  // Used to hide "+" on bullets that are already pinned (any form).
  inTodayRefs?: Set<string>;
  // Subset: refs of slots actually scheduled on the time bar. Drives the
  // bullet's "committed" color — unscheduled / plan-only items stay
  // pending until the user puts them on the bar.
  committedTodayRefs?: Set<string>;
  // Refs of slots locally Mark Done'd (slot.done=true). Pull these out of
  // the main list and surface in "Done This Week" so the quadrant stays
  // in sync with the time bar even when there's no BQ-backed sent action.
  doneTodayRefs?: Set<string>;
  // Refs of slots done in the rolling 7-day window from BQ (any plan_date).
  // Lets the card recognize cross-date dones — without this, marking an
  // item done on Wed and viewing on Fri would re-spawn it in the main list.
  // Items not in this window are treated as never-done; signals older than
  // a week roll off naturally (one-time events don't spill into next week).
  doneWeekRefs?: Set<string>;
}) {
  const meta = META[score.quadrant];
  const Icon = meta.Icon;

  const cardRef = useRef<HTMLDivElement>(null);
  const prevScoreRef = useRef<number>(score.score);
  const animatedScore = useAnimatedNumber(score.score);

  // Custom scroll arrows replace the native scrollbar inside the card.
  // Track scrollability so arrows disable at top/bottom and hide when
  // content fits without overflow.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollHeight - el.clientHeight;
      setCanScrollUp(el.scrollTop > 1);
      setCanScrollDown(el.scrollTop < max - 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  });
  const scrollByPx = (delta: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ top: delta, behavior: "smooth" });
  };

  // Confetti when the score crosses 5.0 from below.
  useEffect(() => {
    const prev = prevScoreRef.current;
    const curr = score.score;
    if (prev < 5.0 && curr >= 5.0) {
      const rect = cardRef.current?.getBoundingClientRect();
      if (rect) {
        const x = (rect.left + rect.right) / 2 / window.innerWidth;
        const y = (rect.top + rect.bottom) / 2 / window.innerHeight;
        void confetti({
          particleCount: 70,
          spread: 70,
          startVelocity: 35,
          origin: { x, y },
          colors: ["#34d399", "#fbbf24", "#60a5fa", "#a78bfa", "#f472b6"],
          ticks: 200,
          scalar: 0.9,
        });
      }
    }
    prevScoreRef.current = curr;
  }, [score.score]);

  // Only one section is open at a time — clicking another chip auto-closes the previous.
  const [showAllSignals, setShowAllSignals] = useState(false);
  const [showAllDone, setShowAllDone] = useState(false);

  // Bullet-click detail modal. Holds whichever item the user clicked so
  // they can preview email/drive/cal source before pinning to today.
  const [detailItem, setDetailItem] = useState<{
    action_id?: string;
    signal_id?: string;
    title: string;
    add_to_today_ref: string;
    add_to_today_text: string;
    already_in_today: boolean;
  } | null>(null);

  // Goals + Actions surfaces removed from the card — the slot modal owns
  // the action lifecycle, and per-quadrant items live in the unified
  // bullet list below. Helpers (ActionsBoard / GoalRow / NestedSection)
  // remain in this file as dormant code in case we revive them.
  const liveCommitted = committedActions.filter((a) => !a.done && !a.cancelled);
  const doneActions = committedActions.filter((a) => a.done);
  // Cancelled items split:
  //   - deferred  → cancelled with a "later"-style note AND not currently
  //                 snoozed. Stays in main list as a soft reminder so the
  //                 user can revisit; Quadri can also nudge separately.
  //   - cancelled → everything else cancelled (no note, no "later" intent,
  //                 or actively snoozed). Goes into Done This Week with
  //                 red strike, then drops off when the week rolls.
  const DEFERRED_RE = /\b(later|someday|some day|next (week|month|year)|tomorrow|remind me|come back|defer)\b/i;
  const nowIso = new Date().toISOString();
  const deferredActions = committedActions.filter((a) => {
    if (!a.cancelled) return false;
    if (!a.cancel_reason || !DEFERRED_RE.test(a.cancel_reason)) return false;
    // Snoozed → suppress from the quadrant until snooze expires.
    if (a.snoozed_until && a.snoozed_until > nowIso) return false;
    return true;
  });
  const deferredActionIds = new Set(deferredActions.map((a) => a.action_id));
  const cancelledActions = committedActions.filter(
    (a) => a.cancelled && !deferredActionIds.has(a.action_id),
  );

  // Top signals come pre-sorted earliest → latest from the view; cap at 3 with
  // a show-more disclosure for the rest (ADHD-collapse pattern).
  const SIGNAL_CAP = 3;
  const DONE_CAP = 3;

  // Strip the legacy "✓ " prefix that the old sync-today route wrote to
  // Google Calendar event titles for done slots. Two reasons:
  //  1. The merge-by-title dedupe of recurring events compares lowercased
  //     titles. "Running" and "✓ Running" hash differently → recurring
  //     events with a done past instance split into two bullets, one of
  //     which lands in "Done This Week" while the other re-spawns in the
  //     main list with the checkmark prefix.
  //  2. Done state lives in daily_slots, not the title. Even if the
  //     prefix didn't break dedupe, displaying it would suggest the AI
  //     marked something done on the user's behalf.
  // The sync route no longer writes the prefix, but legacy calendar events
  // still have it until the user (or a backfill) clears them.
  const stripDonePrefix = (s: string) =>
    s.replace(/^\s*✓\s+/, "");

  // Unified card-item view: signals + pending/committed actions in one list.
  // If an action references a signal already in top_signals, the action
  // replaces it (more concrete title + state coloring). Orphan actions
  // (whose signal got filtered by the week window) surface on their own.
  type ItemState = "signal" | "pending" | "committed" | "deferred";
  type CardItem = {
    key: string;
    // action_id when an action backs this row. "+ to today" must dispatch
    // this — `key` is the signal_id for signal-hit rows, and SlotDetailModal
    // does GET /api/actions/{ref_id}, which 404s on a signal id.
    action_id?: string;
    title: string;
    deadline_iso: string | null;
    // Extra dates from recurring calendar events with the same title.
    // When present, the bullet renders one row with multiple day chips.
    extra_dates?: string[];
    source: string | null;       // for date-chip formatting (e.g., 'calendar' adds clock)
    state: ItemState;
    valence?: "positive" | "neutral" | "negative";
    // For deferred items: surface the user's own "later" note so they
    // remember why it's on hold. Shown under the bullet in italic.
    note?: string;
  };

  type ActionHit = {
    a: PendingAction | CommittedAction;
    state: ItemState;  // "pending" | "committed" | "deferred"
  };
  const actionsBySignalId = new Map<string, ActionHit>();
  for (const a of pendingActions) {
    for (const sid of a.related_signal_ids ?? [])
      actionsBySignalId.set(sid, { a, state: "pending" });
  }
  for (const a of liveCommitted) {
    for (const sid of a.related_signal_ids ?? [])
      if (!actionsBySignalId.has(sid))
        actionsBySignalId.set(sid, { a, state: "committed" });
  }
  // Deferred goes in last so live items take precedence: if the user
  // cancelled X with "later" but then drafted a new X, the new draft
  // is what shows.
  for (const a of deferredActions) {
    for (const sid of a.related_signal_ids ?? [])
      if (!actionsBySignalId.has(sid))
        actionsBySignalId.set(sid, { a, state: "deferred" });
  }
  // Signals whose only related actions are done OR cancelled — these
  // belong in the "Done/Cancelled This Week" section, NOT in the main
  // bullet list (otherwise they'd fall through to default 'pending' for
  // drive_doc sources and look like there's still work to do).
  const signalsFullyDone = new Set<string>();
  for (const a of [...doneActions, ...cancelledActions]) {
    for (const sid of a.related_signal_ids ?? []) {
      if (!actionsBySignalId.has(sid)) signalsFullyDone.add(sid);
    }
  }
  const accountedActionIds = new Set<string>();
  const cardItems: CardItem[] = [];

  // For signals with no action drafted yet, derive state from source:
  //   - calendar         → 'committed' (event is scheduled = time is committed)
  //   - google_drive_*   → 'pending'   (waiting on agent action / user nudge)
  //   - anything else    → 'signal'    (neutral)
  const defaultStateForSource = (source: string | null): ItemState => {
    if (source === "calendar") return "committed";
    if (source && source.startsWith("google_drive_")) return "pending";
    return "signal";
  };

  for (const s of score.top_signals) {
    const hit = actionsBySignalId.get(s.signal_id);
    if (hit) {
      accountedActionIds.add(hit.a.action_id);
      // Pull the cancel_reason for deferred items so we can show the
      // user's own "later" note under the bullet.
      const note =
        hit.state === "deferred"
          ? ((hit.a as CommittedAction).cancel_reason ?? undefined)
          : undefined;
      cardItems.push({
        key: s.signal_id,
        action_id: hit.a.action_id,
        title: stripDonePrefix(hit.a.subject ?? hit.a.body ?? s.title),
        // Calendar-event actions carry their own scheduled time; emails
        // anchor on the signal's deadline.
        deadline_iso: hit.a.event_start ?? s.occurred_at,
        source: hit.a.event_start ? "calendar" : s.source,
        state: hit.state,
        note,
      });
    } else if (signalsFullyDone.has(s.signal_id)) {
      // Signal's only action(s) already done — Done This Week handles it.
      continue;
    } else {
      const state = defaultStateForSource(s.source);
      cardItems.push({
        key: s.signal_id,
        title: stripDonePrefix(s.title),
        deadline_iso: s.occurred_at,
        source: s.source,
        state,
        valence: state === "signal" ? s.valence : undefined,
      });
    }
  }

  // Orphan actions: signal got filtered out by the week window but the
  // action still belongs here.
  for (const a of pendingActions) {
    if (accountedActionIds.has(a.action_id)) continue;
    cardItems.push({
      key: a.action_id,
      action_id: a.action_id,
      title: stripDonePrefix(a.subject ?? a.body ?? "(no title)"),
      deadline_iso: a.event_start ?? a.drafted_at,
      source: a.event_start ? "calendar" : null,
      state: "pending",
    });
  }
  for (const a of liveCommitted) {
    if (accountedActionIds.has(a.action_id)) continue;
    cardItems.push({
      key: a.action_id,
      action_id: a.action_id,
      title: stripDonePrefix(a.subject ?? a.body ?? "(no title)"),
      deadline_iso: a.event_start ?? a.drafted_at,
      source: a.event_start ? "calendar" : null,
      state: "committed",
    });
  }

  // No merge-by-title: per the project model, there are no recurring
  // events. Calendar events come through as distinct signals, and
  // AI-derived items from docs/emails are pre-split into discrete
  // actions. Each cardItem is its own bullet. If duplicates ever
  // appear, that's a source-data issue, not something the render
  // layer should paper over.
  cardItems.sort((x, y) => {
    if (!x.deadline_iso && !y.deadline_iso) return 0;
    if (!x.deadline_iso) return 1;
    if (!y.deadline_iso) return -1;
    return (
      new Date(x.deadline_iso).getTime() - new Date(y.deadline_iso).getTime()
    );
  });

  // Split cardItems: anything Mark Done'd in any of the past 7 days moves
  // out of the main list and into the Done This Week section (rendered
  // alongside BQ-backed sent actions). Match by action_id OR by key
  // (signal_id for signal-hit rows). doneTodayRefs covers today's session;
  // doneWeekRefs covers prior days within the rolling window — without
  // the latter, a Mark Done'd item from Wed would re-spawn on Fri.
  const isInRefSet = (item: CardItem, refs?: Set<string>) =>
    refs != null &&
    ((item.action_id != null && refs.has(item.action_id)) || refs.has(item.key));
  const isLocalDone = (item: CardItem) =>
    isInRefSet(item, doneTodayRefs) || isInRefSet(item, doneWeekRefs);
  const liveCardItems = cardItems.filter((i) => !isLocalDone(i));
  const localDoneItems = cardItems.filter(isLocalDone);

  const visibleItems = showAllSignals ? liveCardItems : liveCardItems.slice(0, SIGNAL_CAP);
  const hiddenItemCount = Math.max(0, liveCardItems.length - SIGNAL_CAP);
  const totalDoneCount =
    doneActions.length + cancelledActions.length + localDoneItems.length;
  const visibleDone = showAllDone ? doneActions : doneActions.slice(0, DONE_CAP);
  const visibleCancelled = showAllDone
    ? cancelledActions
    : cancelledActions.slice(0, Math.max(0, DONE_CAP - visibleDone.length));
  const visibleLocalDone = showAllDone
    ? localDoneItems
    : localDoneItems.slice(
        0,
        Math.max(0, DONE_CAP - visibleDone.length - visibleCancelled.length),
      );
  const hiddenDoneCount = Math.max(
    0,
    totalDoneCount -
      visibleDone.length -
      visibleCancelled.length -
      visibleLocalDone.length,
  );

  const health = healthBg(score.score);

  return (
    <Card
      ref={cardRef}
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden border",
        health.bg,
        isMostUnderFunded ? health.borderStrong : health.border,
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2 px-3 pb-1.5 pt-2.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-md",
              meta.iconBg,
            )}
            aria-hidden
          >
            <Icon className="size-3.5" />
          </span>
          <span className={cn("text-xs font-semibold uppercase tracking-wide", meta.title)}>
            {meta.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xl font-semibold leading-none tabular-nums text-neutral-900">
            {Math.round(animatedScore * 10)}
            <span className="ml-0.5 text-[11px] font-medium text-neutral-400">%</span>
          </div>
        </div>
      </CardHeader>

      {/* Card body fills its grid-cell allotment; the items list scrolls
          inside, the "Show more/less" toggle stays pinned at the bottom
          of the scroll area, and the impact badge + scroll arrows sit
          outside so they're always visible. Native scrollbar hidden —
          arrows below drive the scroll. */}
      <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pt-0 pb-2.5">
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto pr-1 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
        >
        {cardItems.length === 0 ? (
          <EmptyQuadrantSuggestion
            quadrant={score.quadrant}
            proposedGoals={proposedGoals}
            onChanged={onChanged}
          />
        ) : (
          <>
            <ul className="space-y-1">
              {visibleItems.map((item) => {
                const day = formatSignalDate(item.deadline_iso, item.source);
                // For deduped recurring calendar events, compute compact
                // weekday-only chips for the additional dates (the primary
                // gets full "Wed 13 5:15a" treatment; the rest are just
                // "Thu Fri Sat"-style).
                const extraDayLabels =
                  item.extra_dates && item.extra_dates.length > 0
                    ? item.extra_dates
                        .slice()
                        .sort()
                        .map((iso) => {
                          const d = new Date(iso);
                          if (Number.isNaN(d.getTime())) return null;
                          return d.toLocaleDateString("en-US", {
                            weekday: "short",
                          });
                        })
                        .filter((v): v is string => !!v)
                    : [];
                const addToToday = () => {
                  window.dispatchEvent(
                    new CustomEvent("quadri:add-to-today", {
                      detail: {
                        ref_id: item.action_id ?? item.key,
                        text: item.title,
                      },
                    }),
                  );
                };
                // Hide "+" when this bullet is already in Today — either by
                // action_id (manual pin / plan top_item) or by signal_id
                // (a different action drafted from the same signal).
                const alreadyInToday =
                  inTodayRefs != null &&
                  ((item.action_id != null && inTodayRefs.has(item.action_id)) ||
                    inTodayRefs.has(item.key));
                // Stronger signal: this bullet is actively scheduled on the
                // time bar right now. Drives the amber "committed" color.
                const slottedInToday =
                  committedTodayRefs != null &&
                  ((item.action_id != null &&
                    committedTodayRefs.has(item.action_id)) ||
                    committedTodayRefs.has(item.key));
                return (
                  <li
                    key={item.key}
                    className="group flex items-start gap-2 text-sm"
                  >
                    <ItemStateBullet
                      // Only "committed" amber when the bullet is actually
                      // SCHEDULED on the time bar (slot, not unscheduled,
                      // not plan-only). Moving the slot off the bar reverts
                      // the bullet to its underlying state.
                      state={slottedInToday ? "committed" : item.state}
                      valence={item.valence}
                    />
                    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-1.5">
                      {day ? (
                        <span className="shrink-0 rounded bg-foreground/5 px-1 text-[10px] font-medium tabular-nums text-foreground/60">
                          {day}
                        </span>
                      ) : null}
                      {/* Extra weekday chips for recurring calendar events
                          (Mon/Wed/Fri-style). Same chip styling as the
                          primary so they read as part of one bullet. */}
                      {extraDayLabels.map((label) => (
                        <span
                          key={label}
                          className="shrink-0 rounded bg-foreground/5 px-1 text-[10px] font-medium tabular-nums text-foreground/60"
                        >
                          {label}
                        </span>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          setDetailItem({
                            action_id: item.action_id,
                            signal_id: item.action_id ? undefined : item.key,
                            title: item.title,
                            add_to_today_ref: item.action_id ?? item.key,
                            add_to_today_text: item.title,
                            already_in_today: alreadyInToday,
                          })
                        }
                        className={cn(
                          "line-clamp-1 cursor-pointer text-left hover:underline",
                          item.state === "deferred"
                            ? "text-foreground/55"
                            : "text-foreground",
                        )}
                        title="View details"
                      >
                        {item.title}
                      </button>
                      {item.state === "deferred" ? (
                        <span className="shrink-0 rounded border border-neutral-300 bg-neutral-50 px-1 text-[9px] font-semibold uppercase tracking-wide text-neutral-500">
                          on hold
                        </span>
                      ) : null}
                      {item.note ? (
                        <span className="basis-full pl-0.5 text-[10.5px] italic text-neutral-500 line-clamp-1">
                          &ldquo;{item.note}&rdquo;
                        </span>
                      ) : null}
                    </span>
                    {item.state === "committed" ||
                    item.state === "deferred" ||
                    alreadyInToday ? null : (
                      <button
                        type="button"
                        onClick={addToToday}
                        title="Add to today list"
                        aria-label="Add to today list"
                        className="ml-1 inline-flex shrink-0 rounded-md p-0.5 text-foreground/25 transition-colors hover:bg-sky-100 hover:text-sky-700"
                      >
                        <ListPlus className="size-3.5" aria-hidden />
                      </button>
                    )}
                    {/* Hard-delete: removes the action + slots, or the
                        signal-only bullet, from BQ. Use when this item
                        is from an unrelated email or doc the user
                        doesn't care about. */}
                    <button
                      type="button"
                      onClick={async () => {
                        const confirmMsg = item.action_id
                          ? "Delete this item from your quadrants and time bar? This cannot be undone."
                          : "Remove this item entirely so it stops showing? This cannot be undone.";
                        if (!window.confirm(confirmMsg)) return;
                        try {
                          const path = item.action_id
                            ? `/api/actions/${encodeURIComponent(item.action_id)}`
                            : `/api/signals/${encodeURIComponent(item.key)}`;
                          await fetch(path, { method: "DELETE" });
                          onChanged();
                        } catch {
                          // Best-effort; refresh will reveal whatever state landed.
                          onChanged();
                        }
                      }}
                      title="Remove permanently"
                      aria-label="Remove permanently"
                      className="ml-1 inline-flex shrink-0 rounded-md p-0.5 text-foreground/25 transition-colors hover:bg-rose-100 hover:text-rose-700"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
            {hiddenItemCount > 0 ? (
              <button
                type="button"
                onClick={() => setShowAllSignals((v) => !v)}
                className="mt-1 text-[10px] uppercase tracking-wide text-foreground/55 hover:text-foreground"
              >
                {showAllSignals ? "Show less" : `+ ${hiddenItemCount} more`}
              </button>
            ) : null}
          </>
        )}

        {totalDoneCount > 0 ? (
          <div className="mt-2 rounded-md border border-emerald-200/70 bg-emerald-50/40 px-2 py-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
              Done this week · {totalDoneCount}
            </div>
            <ul className="mt-1 space-y-1">
              {visibleDone.map((a) => (
                <li key={a.action_id} className="text-xs">
                  <div className="flex items-center gap-1.5">
                    <Check
                      className="size-3 shrink-0 text-emerald-600"
                      aria-hidden
                    />
                    <span className="line-clamp-1 text-foreground/45 line-through">
                      {a.subject ?? a.body ?? "(no body)"}
                    </span>
                  </div>
                  {a.user_note ? (
                    <div className="ml-[18px] line-clamp-1 text-[10.5px] italic text-foreground/55">
                      &ldquo;{a.user_note}&rdquo;
                    </div>
                  ) : null}
                </li>
              ))}
              {visibleCancelled.map((a) => (
                <li key={a.action_id} className="text-xs">
                  <div className="flex items-center gap-1.5">
                    <X
                      className="size-3 shrink-0 text-rose-600"
                      aria-hidden
                    />
                    <span className="line-clamp-1 text-foreground/45 line-through decoration-rose-400">
                      {a.subject ?? a.body ?? "(no body)"}
                    </span>
                  </div>
                  {a.cancel_reason ? (
                    <div className="ml-[18px] line-clamp-1 text-[10.5px] italic text-rose-700/70">
                      &ldquo;{a.cancel_reason}&rdquo;
                    </div>
                  ) : null}
                </li>
              ))}
              {visibleLocalDone.map((it) => (
                <li
                  key={`local-${it.key}`}
                  className="flex items-center gap-1.5 text-xs"
                >
                  <Check
                    className="size-3 shrink-0 text-emerald-600"
                    aria-hidden
                  />
                  <span className="line-clamp-1 text-foreground/45 line-through">
                    {it.title}
                  </span>
                </li>
              ))}
            </ul>
            {hiddenDoneCount > 0 ? (
              <button
                type="button"
                onClick={() => setShowAllDone((v) => !v)}
                className="mt-1 text-[10px] uppercase tracking-wide text-emerald-700/80 hover:text-emerald-700"
              >
                {showAllDone ? "Show less" : `+ ${hiddenDoneCount} more`}
              </button>
            ) : null}
          </div>
        ) : null}
        </div>

        {/* Bottom strip: scroll arrows on the left (only when there's
            overflow), impact badge on the right. Both stay outside the
            scrollable area so they're always reachable. */}
        <div className="mt-2 flex shrink-0 items-center justify-between gap-2">
          <div className="flex items-center gap-0.5">
            {(canScrollUp || canScrollDown) ? (
              <>
                <button
                  type="button"
                  onClick={() => scrollByPx(-80)}
                  disabled={!canScrollUp}
                  aria-label="Scroll up"
                  className={cn(
                    "rounded-md p-0.5 transition-colors",
                    canScrollUp
                      ? "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
                      : "cursor-not-allowed text-neutral-300",
                  )}
                >
                  <ChevronUp className="size-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => scrollByPx(80)}
                  disabled={!canScrollDown}
                  aria-label="Scroll down"
                  className={cn(
                    "rounded-md p-0.5 transition-colors",
                    canScrollDown
                      ? "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
                      : "cursor-not-allowed text-neutral-300",
                  )}
                >
                  <ChevronDown className="size-3.5" aria-hidden />
                </button>
              </>
            ) : null}
          </div>
          <Badge
            variant="outline"
            className="border-neutral-200 bg-white text-[10px] font-medium text-neutral-500"
            title="How much this quadrant matters in your priorities"
          >
            impact · {Math.round(score.user_weight * 100)}%
          </Badge>
        </div>
      </CardContent>
      <ItemDetailModal
        open={detailItem !== null}
        onClose={() => setDetailItem(null)}
        actionId={detailItem?.action_id}
        signalId={detailItem?.signal_id}
        title={detailItem?.title ?? ""}
        alreadyInToday={detailItem?.already_in_today ?? false}
        onChanged={onChanged}
        onAddToToday={
          detailItem
            ? () => {
                window.dispatchEvent(
                  new CustomEvent("quadri:add-to-today", {
                    detail: {
                      ref_id: detailItem.add_to_today_ref,
                      text: detailItem.add_to_today_text,
                    },
                  }),
                );
              }
            : undefined
        }
      />
    </Card>
  );
}

function SectionToggle({
  label,
  count,
  active,
  onClick,
  chip,
  chipActive,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  chip: string;
  chipActive: string;
}) {
  const empty = count === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={empty}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-medium transition-colors",
        active ? chipActive : chip,
        empty && "cursor-not-allowed opacity-50",
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "rounded-full px-1.5 text-xs font-semibold tabular-nums",
          active ? "bg-white/25" : "bg-white/70",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function NestedSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground/70">
        <span>{title}</span>
        <Badge variant="secondary" className="text-[10px] font-semibold">
          {count}
        </Badge>
      </div>
      <ul className="space-y-1.5">{children}</ul>
    </div>
  );
}

// ---------- Actions board: side-by-side Pending + Committed with DnD ----------

type ActionsDrag =
  | { kind: "pending"; action: PendingAction }
  | { kind: "committed"; action: CommittedAction };

type Override = "committed" | "pending" | "removed" | "done";

function ActionsBoard({
  pending,
  committed,
  busyId,
  onApprove,
  onReject,
  onDone,
  onUncommit,
}: {
  pending: PendingAction[];
  committed: CommittedAction[];
  busyId: string | null;
  onApprove: (id: string) => Promise<boolean>;
  onReject: (id: string) => Promise<boolean>;
  onDone: (id: string) => Promise<boolean>;
  onUncommit: (id: string) => Promise<boolean>;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const [activeDrag, setActiveDrag] = useState<ActionsDrag | null>(null);

  // Optimistic overrides: visually move/remove items the moment the user
  // acts, then sync with the API in the background. Cleaned up by the
  // useEffect below once /api/state catches up.
  const [overrides, setOverrides] = useState<Map<string, Override>>(new Map());
  const setOverride = (id: string, value: Override) =>
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(id, value);
      return next;
    });
  const clearOverride = (id: string) =>
    setOverrides((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });

  // Drop stale overrides whose target state already matches the truth — the
  // API has caught up. Computed on the fly; no setState-in-effect dance.
  const pendingIds = new Set(pending.map((a) => a.action_id));
  const committedIds = new Set(committed.map((a) => a.action_id));
  const doneIds = new Set(
    committed.filter((a) => a.done).map((a) => a.action_id),
  );
  const effective = new Map(overrides);
  for (const [id, override] of overrides) {
    if (override === "committed" && committedIds.has(id)) effective.delete(id);
    else if (override === "pending" && pendingIds.has(id)) effective.delete(id);
    else if (
      override === "removed" &&
      !pendingIds.has(id) &&
      !committedIds.has(id)
    )
      effective.delete(id);
    else if (override === "done" && doneIds.has(id)) effective.delete(id);
  }

  // Visible lists after applying effective overrides.
  // CommittedAction extends PendingAction, so passing it through `as PendingAction`
  // is structurally fine — the extra fields are ignored by the pending row.
  const visiblePending: PendingAction[] = [
    ...pending.filter((a) => !effective.has(a.action_id)),
    ...committed
      .filter((a) => effective.get(a.action_id) === "pending")
      .map((a) => a as PendingAction),
  ];
  const visibleCommitted: CommittedAction[] = [
    // Existing committed items; "done" override forces done=true optimistically.
    ...committed
      .filter((a) => {
        const ov = effective.get(a.action_id);
        return ov === undefined || ov === "done";
      })
      .map((a) =>
        effective.get(a.action_id) === "done" ? { ...a, done: true } : a,
      ),
    // Pending items optimistically moved to committed via drag.
    ...pending
      .filter((a) => effective.get(a.action_id) === "committed")
      .map((a) => ({
        ...a,
        decided_at: new Date().toISOString(),
        hours_since_decided: 0,
        done: false,
        cancelled: false,
        cancel_reason: null,
        user_note: null,
        snoozed_until: null,
      })),
  ];

  async function commitFromPending(id: string) {
    setOverride(id, "committed");
    const ok = await onApprove(id);
    if (!ok) clearOverride(id);
  }
  async function uncommitToPending(id: string) {
    setOverride(id, "pending");
    const ok = await onUncommit(id);
    if (!ok) clearOverride(id);
  }
  async function rejectAt(id: string) {
    setOverride(id, "removed");
    const ok = await onReject(id);
    if (!ok) clearOverride(id);
  }
  async function doneAt(id: string) {
    setOverride(id, "done");
    const ok = await onDone(id);
    if (!ok) clearOverride(id);
  }

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as ActionsDrag | undefined;
    if (data) setActiveDrag(data);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDrag(null);
    const { active, over } = event;
    if (!over) return;
    const overId = String(over.id);
    const data = active.data.current as ActionsDrag | undefined;
    if (!data) return;

    if (data.kind === "pending" && overId === "col:committed") {
      void commitFromPending(data.action.action_id);
      return;
    }
    if (data.kind === "committed" && overId === "col:pending") {
      void uncommitToPending(data.action.action_id);
      return;
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDrag(null)}
    >
      <div className="grid grid-cols-2 gap-2">
        <ActionsColumn
          id="col:pending"
          title="Pending"
          tone="border-sky-300 bg-sky-50/60"
          empty="No pending"
        >
          {visiblePending.map((a) => (
            <PendingActionItem
              key={a.action_id}
              action={a}
              busy={busyId === a.action_id}
              onReject={() => rejectAt(a.action_id)}
            />
          ))}
        </ActionsColumn>
        <ActionsColumn
          id="col:committed"
          title="Committed"
          tone="border-amber-300 bg-amber-50/60"
          empty="Nothing committed"
        >
          {visibleCommitted.map((a) => (
            <CommittedActionItem
              key={a.action_id}
              action={a}
              busy={busyId === a.action_id}
              onDone={() => doneAt(a.action_id)}
            />
          ))}
        </ActionsColumn>
      </div>

      <p className="mt-2 text-[10px] text-foreground/50">
        Drag pending → committed to commit · drag back to undo · {`×`} rejects · ✓ marks done
      </p>

      <DragOverlay dropAnimation={null}>
        {activeDrag ? <ActionDragGhost drag={activeDrag} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function ActionsColumn({
  id,
  title,
  tone,
  empty,
  children,
}: {
  id: string;
  title: string;
  tone: string;
  empty: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "min-h-[80px] rounded-lg border border-dashed p-1.5 transition-colors",
        tone,
        isOver && "border-solid ring-2 ring-indigo-400",
      )}
    >
      <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide text-foreground/65">
        {title}
      </div>
      {hasChildren ? (
        <ul className="space-y-1">{children}</ul>
      ) : (
        <div className="px-1 py-2 text-[11px] italic text-foreground/45">{empty}</div>
      )}
    </div>
  );
}

function PendingActionItem({
  action,
  busy,
  onReject,
}: {
  action: PendingAction;
  busy: boolean;
  onReject: () => void;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `act:${action.action_id}`,
    data: { kind: "pending", action } satisfies ActionsDrag,
  });
  return (
    <li
      ref={setNodeRef}
      className={cn(
        "flex items-start gap-1 rounded-md border border-sky-200 bg-background/90 p-1.5 shadow-sm",
        isDragging && "opacity-30",
        busy && "opacity-60",
      )}
    >
      <button
        type="button"
        {...listeners}
        {...attributes}
        className="mt-0.5 cursor-grab touch-none text-foreground/40 hover:text-foreground/70 active:cursor-grabbing"
        aria-label={`Drag ${action.subject ?? "item"}`}
      >
        <GripVertical className="size-3.5" aria-hidden />
      </button>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wide text-foreground/55">
          {ACTION_TYPE_LABEL[action.action_type]} → {action.to_recipient ?? "—"}
        </div>
        <div className="text-xs text-foreground line-clamp-2">
          {action.subject ?? action.body ?? "(no body)"}
        </div>
      </div>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onReject}
        disabled={busy}
        className="shrink-0 rounded-md p-0.5 text-foreground/40 hover:bg-rose-100 hover:text-rose-700 disabled:opacity-50"
        aria-label="Reject"
        title="Reject"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </li>
  );
}

function CommittedActionItem({
  action,
  busy,
  onDone,
}: {
  action: CommittedAction;
  busy: boolean;
  onDone: () => void;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `act:${action.action_id}`,
    data: { kind: "committed", action } satisfies ActionsDrag,
    disabled: action.done,
  });
  const stale = !action.done && action.hours_since_decided >= 24;
  return (
    <li
      ref={setNodeRef}
      className={cn(
        "flex items-start gap-1 rounded-md border border-amber-200 bg-background/90 p-1.5 shadow-sm",
        isDragging && "opacity-30",
        busy && "opacity-60",
        action.done && "border-emerald-200 bg-emerald-50/40",
      )}
    >
      {action.done ? (
        <span
          className="mt-0.5 inline-flex size-3.5 shrink-0 items-center justify-center text-emerald-600"
          aria-hidden
        >
          <Check className="size-3.5" />
        </span>
      ) : (
        <button
          type="button"
          {...listeners}
          {...attributes}
          className="mt-0.5 cursor-grab touch-none text-foreground/40 hover:text-foreground/70 active:cursor-grabbing"
          aria-label={`Drag ${action.subject ?? "item"}`}
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-foreground/55">
          <span className="truncate">
            {ACTION_TYPE_LABEL[action.action_type]} → {action.to_recipient ?? "—"} ·{" "}
            {ageLabel(action.hours_since_decided)}
          </span>
          {stale ? (
            <Badge variant="destructive" className="text-[9px] font-semibold">
              stale
            </Badge>
          ) : null}
          {action.done ? (
            <span className="text-[9px] font-semibold uppercase text-emerald-700">
              done
            </span>
          ) : null}
        </div>
        <div
          className={cn(
            "text-xs line-clamp-2",
            action.done ? "text-foreground/45 line-through" : "text-foreground",
          )}
        >
          {action.subject ?? action.body ?? "(no body)"}
        </div>
      </div>
      {action.done ? null : (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onDone}
          disabled={busy}
          className="shrink-0 rounded-md p-0.5 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
          aria-label="Done"
          title="Done"
        >
          <Check className="size-3.5" aria-hidden />
        </button>
      )}
    </li>
  );
}

function ActionDragGhost({ drag }: { drag: ActionsDrag }) {
  const text =
    drag.action.subject ?? drag.action.body ?? "(no body)";
  const tone =
    drag.kind === "pending"
      ? "border-sky-500 bg-sky-100 text-sky-900"
      : "border-amber-500 bg-amber-100 text-amber-900";
  const hint = drag.kind === "pending" ? "→ commit" : "← back to pending";
  return (
    <div
      className={cn(
        "pointer-events-none flex w-[160px] items-center gap-1 rounded-md border-2 px-2 py-1.5 text-[11px] font-semibold leading-tight shadow-2xl ring-2 ring-foreground/10",
        tone,
      )}
    >
      <Undo2 className="size-3 shrink-0 opacity-60" aria-hidden />
      <span className="line-clamp-2">{text}</span>
      <span className="ml-auto shrink-0 text-[9px] uppercase opacity-70">{hint}</span>
    </div>
  );
}

// Shown in a quadrant card when there are zero live items. If Quadri
// has proposed any goals for this quadrant they render first with
// Approve / Skip controls; otherwise we render a soft CTA that nudges
// the user toward the chat dock. Layout intentionally minimal — the
// user said "we'll work on layout" after putting the feature back.
function EmptyQuadrantSuggestion({
  quadrant,
  proposedGoals,
  onChanged,
}: {
  quadrant: string;
  proposedGoals: Goal[];
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function decide(goalId: string, decision: "approve" | "reject") {
    setBusyId(goalId);
    try {
      const r = await fetch(`/api/goals/${goalId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!r.ok) {
        toast.error(decision === "approve" ? "Approve failed" : "Skip failed");
        return;
      }
      toast.success(
        decision === "approve" ? "Goal added" : "Suggestion dismissed",
      );
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  if (proposedGoals.length === 0) {
    return (
      <div className="space-y-1.5 rounded-md border border-dashed border-neutral-300 bg-neutral-50/60 px-3 py-2.5">
        <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
          Quiet here
        </div>
        <div className="text-xs leading-snug text-neutral-600">
          Nothing in <span className="capitalize">{quadrant}</span> yet. Ask
          Quadri to suggest a goal &mdash; e.g. <em>&ldquo;propose a {quadrant}{" "}
          goal&rdquo;</em>.
        </div>
      </div>
    );
  }

  const top = proposedGoals[0];
  return (
    <div className="space-y-2 rounded-md border border-sky-200 bg-sky-50/60 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-sky-700">
        <span>Quadri suggests</span>
        {top.derived_confidence != null ? (
          <span className="tabular-nums">
            {Math.round(top.derived_confidence * 100)}%
          </span>
        ) : null}
      </div>
      <div className="text-sm font-medium leading-snug text-neutral-800">
        {top.title}
      </div>
      {top.description ? (
        <div className="text-xs leading-snug text-neutral-600">
          {top.description}
        </div>
      ) : null}
      {top.derived_reasoning ? (
        <div className="text-[11px] italic text-neutral-500">
          — {top.derived_reasoning}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          onClick={() => decide(top.goal_id, "approve")}
          disabled={busyId === top.goal_id}
          className="h-6 bg-sky-600 px-2 text-[11px] text-white hover:bg-sky-700"
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => decide(top.goal_id, "reject")}
          disabled={busyId === top.goal_id}
          className="h-6 px-2 text-[11px] text-neutral-500"
        >
          Skip
        </Button>
      </div>
      {proposedGoals.length > 1 ? (
        <div className="text-[10px] text-neutral-500">
          +{proposedGoals.length - 1} more — ask Quadri to cycle through them.
        </div>
      ) : null}
    </div>
  );
}

function GoalRow({
  goal,
  actions,
  busy,
}: {
  goal: Goal;
  actions?: React.ReactNode;
  busy?: boolean;
}) {
  const isProposed = goal.status === "proposed";
  return (
    <li className="flex items-start justify-between gap-2 rounded-md bg-background/80 px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs text-foreground/60">
          <Badge variant="outline" className="text-[10px] font-semibold">
            {isProposed ? "proposed" : "active"}
          </Badge>
          {isProposed && goal.derived_confidence != null ? (
            <span className="tabular-nums">
              {Math.round(goal.derived_confidence * 100)}%
            </span>
          ) : null}
        </div>
        <div
          className={cn(
            "text-sm font-semibold text-foreground line-clamp-1",
            busy && "opacity-60",
          )}
        >
          {goal.title}
        </div>
        {goal.today_micro_step ? (
          <div className="mt-0.5 text-xs text-foreground/75 line-clamp-1">
            <span className="font-semibold text-foreground/55">Today: </span>
            {goal.today_micro_step.text}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </li>
  );
}
