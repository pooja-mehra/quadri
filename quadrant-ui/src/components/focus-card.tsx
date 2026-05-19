"use client";

// Three-lane focus stack — Now Brewing / Up Next / Later.
//
// Replaces the time-bar-based scheduling model (removed 2026-05-17).
// Rationale: time slots create phantom commitments that turn into
// shame when missed. ADHD time blindness means "I'll do this at 3pm"
// routinely fails. Lanes carry the "what's next" signal without the
// felt-pressure of a clock.
//
// Lanes:
//   - Now Brewing (1): the big card on screen. The current focus.
//   - Up Next     (≤3): small tappable rows. Tap → that item becomes
//                       Now Brewing.
//   - Later       (rest): collapsed count by default. Expands to a
//                         scrollable list of tappable rows.
//
// Quadri NEVER auto-promotes. The user always decides what to focus
// on; the AI only ranks. The "Done" button records completion in
// BigQuery and triggers a brief celebration overlay so the ADHD
// brain gets a small dopamine return before the next item slides
// in.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Heart,
  GraduationCap,
  Briefcase,
  Users,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ItemDetailModal } from "@/components/item-detail-modal";
import { useDailyPlan } from "@/lib/use-daily-plan";
import { todayLocalISO } from "@/lib/date";
import type { Quadrant } from "@/lib/bq";
import type { ScoreComponent } from "@/lib/quadri-score";
import type {
  CommittedAction,
  DashboardState,
  PendingAction,
  PlanItem,
} from "@/lib/types";

const CATEGORY_META: Record<
  Quadrant,
  { label: string; Icon: typeof Heart; chip: string; ring: string }
> = {
  health: {
    label: "Health",
    Icon: Heart,
    chip: "bg-rose-50 text-rose-700 border-rose-200",
    ring: "ring-rose-200",
  },
  education: {
    label: "Education",
    Icon: GraduationCap,
    chip: "bg-amber-50 text-amber-800 border-amber-200",
    ring: "ring-amber-200",
  },
  career: {
    label: "Career",
    Icon: Briefcase,
    chip: "bg-indigo-50 text-indigo-700 border-indigo-200",
    ring: "ring-indigo-200",
  },
  relationships: {
    label: "Relationships",
    Icon: Users,
    chip: "bg-pink-50 text-pink-700 border-pink-200",
    ring: "ring-pink-200",
  },
};

function effortLabel(
  action: PendingAction | CommittedAction | null,
): string | null {
  if (!action) return null;
  if (action.action_type === "calendar_event") {
    if (action.event_start && action.event_end) {
      const ms =
        new Date(action.event_end).getTime() -
        new Date(action.event_start).getTime();
      const mins = Math.max(15, Math.round(ms / 60000));
      if (mins < 60) return `~${mins} min`;
      const h = Math.round((mins / 60) * 10) / 10;
      return `~${h} hr`;
    }
    return null;
  }
  if (action.action_type === "email_draft") return "~5 min · Quick win";
  if (action.action_type === "text_draft") return "~2 min · Quick win";
  return null;
}

type FocusItem = {
  planItem: PlanItem;       // possibly rewritten to point at the action
  action: PendingAction | CommittedAction | null;
  quadrant: Quadrant | null;
  actionId?: string;
  // signalId is the ID we'll display from. For action-backed items
  // we still capture the cited signal so we can show the *actual*
  // email subject (the LLM rephrase sometimes lies; the source
  // title is the honest version).
  signalId?: string;
};

function buildQueue(
  state: DashboardState,
  planItems: PlanItem[],
  scheduledRefs: Set<string>,
): FocusItem[] {
  if (planItems.length === 0) return [];

  const pendingById = new Map(
    state.pending_actions.map((a) => [a.action_id, a]),
  );
  const committedById = new Map(
    state.committed_actions.map((a) => [a.action_id, a]),
  );

  // signal_id → owning action lookup. The plan ranker sometimes
  // emits an item whose source_ref_id is a signal_id, even when an
  // action draft already exists for that signal. Without this map,
  // the modal would fetch /api/signals (read-only excerpt) instead
  // of the editable email draft.
  const signalToAction = new Map<
    string,
    { actionId: string; source: PlanItem["source"] }
  >();
  for (const a of state.pending_actions) {
    for (const sid of a.related_signal_ids ?? []) {
      if (!signalToAction.has(sid))
        signalToAction.set(sid, {
          actionId: a.action_id,
          source: "pending_action",
        });
    }
  }
  for (const a of state.committed_actions) {
    for (const sid of a.related_signal_ids ?? []) {
      if (!signalToAction.has(sid))
        signalToAction.set(sid, {
          actionId: a.action_id,
          source: "committed_action",
        });
    }
  }
  const isKnownAction = (id: string) =>
    pendingById.has(id) || committedById.has(id);

  // Rolling 7-day done refs — covers signal-only items marked done
  // via /api/slots/done (the action-backed path drops out via the
  // pending/committed filter below). Without this, an item the user
  // just marked done would reappear until the next plan re-rank.
  const doneRefs = new Set(
    (state.done_slot_refs ?? []).map((r) => r.ref_id),
  );

  const out: FocusItem[] = [];
  for (const pi of planItems) {
    if (pi.source === "goal") continue;
    if (!pi.source_ref_id) continue;

    // Hide if user just marked the underlying signal or any cited
    // signal as done.
    if (doneRefs.has(pi.source_ref_id)) continue;
    let citedDone = false;
    for (const sid of pi.cited_signal_ids ?? []) {
      if (doneRefs.has(sid)) {
        citedDone = true;
        break;
      }
    }
    if (citedDone) continue;

    // Hide if the item already has a scheduled slot today — it
    // belongs on the calendar strip, not in the focus queue. We
    // check both the plan item's ref AND any cited signals; the
    // action's owning signal is also added via the signalToAction
    // map below for action-backed items.
    if (scheduledRefs.has(pi.source_ref_id)) continue;
    let citedScheduled = false;
    for (const sid of pi.cited_signal_ids ?? []) {
      if (scheduledRefs.has(sid)) {
        citedScheduled = true;
        break;
      }
    }
    if (citedScheduled) continue;

    // Normalize: if source_ref_id isn't a known action_id, look it
    // (and the cited signals) up in the signal→action map.
    let normalized = pi;
    if (!isKnownAction(pi.source_ref_id)) {
      const candidates = [...(pi.cited_signal_ids ?? []), pi.source_ref_id];
      for (const sid of candidates) {
        const hit = signalToAction.get(sid);
        if (hit) {
          normalized = {
            ...pi,
            source: hit.source,
            source_ref_id: hit.actionId,
          };
          break;
        }
      }
    }

    const action =
      pendingById.get(normalized.source_ref_id!) ??
      committedById.get(normalized.source_ref_id!) ??
      null;
    if (action && "done" in action) {
      const committed = action as CommittedAction;
      if (committed.done || committed.cancelled) continue;
    }

    // Also drop if the action_id is itself on the calendar — covers
    // the case where the plan item references a signal but a draft
    // action for it has been scheduled. (The signal_id check above
    // wouldn't catch this — the slot row carries the action_id.)
    if (action && scheduledRefs.has(action.action_id)) continue;
    if (action) {
      let actionCitedScheduled = false;
      for (const sid of action.related_signal_ids ?? []) {
        if (scheduledRefs.has(sid)) {
          actionCitedScheduled = true;
          break;
        }
      }
      if (actionCitedScheduled) continue;
    }
    const quadrant: Quadrant | null = action?.quadrant ?? null;

    // Choose the signal_id we'd use to fetch the source title. For
    // an action, the first related signal is usually the originating
    // email/doc. For signal-only items, source_ref_id IS the signal.
    const signalForTitle = action
      ? action.related_signal_ids?.[0] ?? null
      : normalized.source_ref_id;

    out.push({
      planItem: normalized,
      action,
      quadrant,
      actionId: action?.action_id,
      signalId: signalForTitle ?? undefined,
    });
  }
  return out;
}

function deriveTitle(text: string): string {
  const i = text.indexOf("—");
  return i > 0 ? text.slice(0, i).trim() : text;
}

function deriveWhy(text: string): string | null {
  const i = text.indexOf("—");
  return i > 0 ? text.slice(i + 1).trim() : null;
}

function ofToday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  try {
    return iso.startsWith(new Date().toISOString().slice(0, 10));
  } catch {
    return false;
  }
}

function todayDoneCount(state: DashboardState): number {
  return state.committed_actions.filter(
    (a) => a.done && ofToday(a.decided_at),
  ).length;
}

// A small bag of encouragements rotated through on done. ADHD
// brains get a bigger dopamine return from variety than from a
// single repeated phrase.
const ENCOURAGEMENTS = [
  "Nice — one less thing",
  "Done. That counts.",
  "Off the plate ✓",
  "Look at you go",
  "That's a win",
  "Quietly proud",
];

export function FocusCard({
  state,
  onChanged,
  scoreComponents,
}: {
  state: DashboardState;
  onChanged: () => void;
  scoreComponents?: ScoreComponent[];
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [laterExpanded, setLaterExpanded] = useState(false);
  const [detailItem, setDetailItem] = useState<{
    action_id?: string;
    signal_id?: string;
    title: string;
  } | null>(null);

  // Done-celebration overlay state. `celebration` carries the
  // phrase and a key so a quick second tap restarts the animation.
  // Triggered after the modal closes on Done.
  const [celebration, setCelebration] = useState<{
    key: number;
    phrase: string;
  } | null>(null);

  // Honest title cache. For every signal_id we encounter we fetch
  // /api/signals/<id> once and store its real title. The FocusCard
  // shows this title (when available) in preference to the LLM-
  // generated plan_item.text — the rephrase has been seen to lie
  // about what the underlying email actually is.
  const [signalTitles, setSignalTitles] = useState<
    Record<string, string | null>
  >({});
  const fetchedSignals = useRef<Set<string>>(new Set());

  const planDate = todayLocalISO();
  const { plan, phase } = useDailyPlan(planDate);
  const planItems = plan?.top_items ?? [];

  // Today's active (non-done) slot refs. Anything currently on the
  // calendar strip should not also be in the focus queue — it lives
  // on the calendar surface. Re-fetched whenever the parent triggers
  // a refresh (state change) so a freshly-scheduled item drops out
  // of "Up next" without a page reload.
  const [scheduledRefs, setScheduledRefs] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/slots?plan_date=${encodeURIComponent(planDate)}`, {
      cache: "no-store",
    })
      .then((r) =>
        r.ok ? r.json() : { slots: [] as Array<Record<string, unknown>> },
      )
      .then(
        (data: {
          slots?: Array<{
            item_ref_id?: string | null;
            done?: boolean | null;
            unscheduled?: boolean | null;
          }>;
        }) => {
          if (cancelled) return;
          const s = new Set<string>();
          for (const slot of data.slots ?? []) {
            if (slot.done || slot.unscheduled) continue;
            if (slot.item_ref_id) s.add(slot.item_ref_id);
          }
          setScheduledRefs(s);
        },
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [planDate, state]);

  const queue = useMemo(
    () => buildQueue(state, planItems, scheduledRefs),
    [state, planItems, scheduledRefs],
  );

  // Clamp index whenever queue shrinks.
  useEffect(() => {
    if (currentIndex >= queue.length) {
      setCurrentIndex(Math.max(0, queue.length - 1));
    }
  }, [queue.length, currentIndex]);

  const current = queue[currentIndex] ?? null;

  // Prefetch the signal title for the current item so the card
  // shows the real subject the moment the user navigates to it,
  // not after they Open the modal.
  useEffect(() => {
    const sid = current?.signalId;
    if (!sid) return;
    if (fetchedSignals.current.has(sid)) return;
    fetchedSignals.current.add(sid);
    let cancelled = false;
    fetch(`/api/signals/${encodeURIComponent(sid)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const title = typeof data.title === "string" ? data.title : null;
        setSignalTitles((m) => ({ ...m, [sid]: title }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [current?.signalId]);

  const doneToday = todayDoneCount(state);

  const upNext = queue.slice(currentIndex + 1, currentIndex + 4);
  const later = queue.slice(currentIndex + 4);

  function openItem() {
    if (!current) return;
    setDetailItem({
      action_id: current.actionId,
      signal_id: current.actionId ? undefined : current.signalId,
      title: titleFor(current),
    });
  }

  function jumpTo(absoluteIndex: number) {
    setCurrentIndex(absoluteIndex);
    setLaterExpanded(false);
  }

  function goNext() {
    if (currentIndex < queue.length - 1) {
      setCurrentIndex((i) => i + 1);
    }
  }
  function goBack() {
    if (currentIndex > 0) {
      setCurrentIndex((i) => i - 1);
    }
  }

  function triggerCelebration() {
    const phrase =
      ENCOURAGEMENTS[Math.floor(Math.random() * ENCOURAGEMENTS.length)];
    setCelebration({ key: Date.now(), phrase });
    // Auto-dismiss after the animation completes.
    window.setTimeout(() => setCelebration(null), 1600);
  }

  if (!current) {
    if (phase !== "ready") {
      return (
        <Card className="border-neutral-200 bg-white">
          <CardContent className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <Loader2
              className="size-5 animate-spin text-neutral-400"
              aria-hidden
            />
            <div className="text-sm text-neutral-500">
              Ranking what to focus on…
            </div>
          </CardContent>
        </Card>
      );
    }
    return (
      <Card className="border-emerald-200 bg-emerald-50/40">
        <CardContent className="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <div className="text-3xl">✓</div>
          <div className="text-base font-semibold text-emerald-900">
            All clear today
          </div>
          <div className="text-sm text-emerald-800/70">
            {doneToday > 0
              ? `${doneToday} done. Nice work.`
              : "Nothing queued. Enjoy the quiet."}
          </div>
        </CardContent>
      </Card>
    );
  }

  const meta = current.quadrant ? CATEGORY_META[current.quadrant] : null;
  const Icon = meta?.Icon;
  const effort = effortLabel(current.action);
  const title = titleFor(current);
  const why = deriveWhy(current.planItem.text);
  const canBack = currentIndex > 0;
  const canNext = currentIndex < queue.length - 1;

  // Helper that resolves the best title for an item:
  //   1. The action's subject (if drafted) — verbatim email subject.
  //   2. The cited signal's title (if prefetched) — actual source.
  //   3. The LLM's plan_item.text up to the em-dash.
  function titleFor(item: FocusItem): string {
    const action = item.action;
    if (action && action.subject) return action.subject;
    const sid = item.signalId;
    if (sid) {
      const t = signalTitles[sid];
      if (t) return t;
    }
    return deriveTitle(item.planItem.text);
  }

  return (
    <>
      {/* Now Brewing — the focus card itself */}
      <Card
        className={cn(
          "relative overflow-hidden border-neutral-200 bg-white shadow-sm",
          meta ? `ring-1 ${meta.ring}` : null,
        )}
      >
        <CardContent className="px-6 py-6">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
              Now brewing
            </span>
            {meta && Icon ? (
              <Badge
                variant="outline"
                className={cn(
                  "gap-1.5 border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
                  meta.chip,
                )}
              >
                <Icon className="size-3" aria-hidden />
                {meta.label}
              </Badge>
            ) : null}
            <span className="ml-auto text-[11px] text-neutral-500 tabular-nums">
              {currentIndex + 1} / {queue.length}
            </span>
          </div>

          <div className="text-lg font-semibold leading-snug text-neutral-900">
            {title}
          </div>

          {effort ? (
            <div className="mt-1 text-xs text-neutral-500">{effort}</div>
          ) : null}

          {why ? (
            <div className="mt-3 text-sm leading-relaxed text-neutral-700">
              <span className="font-medium text-neutral-500">Why: </span>
              {why}
            </div>
          ) : null}

          <div className="mt-5 flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={goBack}
              disabled={!canBack}
              className="text-neutral-600"
            >
              <ChevronLeft className="mr-1 size-4" aria-hidden />
              Back
            </Button>
            <Button
              onClick={openItem}
              className="bg-neutral-900 text-white hover:bg-neutral-800"
            >
              Open
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={goNext}
              disabled={!canNext}
              className="text-neutral-600"
            >
              Next
              <ChevronRight className="ml-1 size-4" aria-hidden />
            </Button>
          </div>

          {scoreComponents && scoreComponents.length > 0 ? (
            <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-neutral-100 pt-3 text-[11px] text-neutral-500">
              {scoreComponents.map((c, i) => (
                <span key={i} className="inline-flex items-center gap-2">
                  {i > 0 ? (
                    <span className="text-neutral-300" aria-hidden>
                      ·
                    </span>
                  ) : null}
                  <span>{c.label}</span>
                </span>
              ))}
            </div>
          ) : (
            <div className="mt-5 border-t border-neutral-100 pt-3 text-[11px] text-neutral-500">
              {doneToday} done today
            </div>
          )}
        </CardContent>

        {/* Done celebration — full-card overlay that scales in,
            holds briefly, then fades. Same surface for action-backed
            and signal-only items so the "win" feeling is uniform. */}
        {celebration ? (
          <div
            key={celebration.key}
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-emerald-50/95 animate-[fadeOut_1.6s_ease-out_forwards]"
          >
            <div className="flex flex-col items-center gap-2 animate-[popIn_0.4s_ease-out]">
              <CheckCircle2
                className="size-12 text-emerald-600 drop-shadow-sm"
                aria-hidden
              />
              <div className="text-base font-semibold text-emerald-900">
                {celebration.phrase}
              </div>
            </div>
          </div>
        ) : null}
      </Card>

      {/* Up Next — peek at next ≤3 items in the queue */}
      {upNext.length > 0 ? (
        <div className="rounded-md border border-neutral-200 bg-white">
          <div className="border-b border-neutral-100 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
            Up next
          </div>
          <ul className="divide-y divide-neutral-100">
            {upNext.map((item, i) => {
              const absIdx = currentIndex + 1 + i;
              const itemTitle = titleFor(item);
              return (
                <li key={item.planItem.source_ref_id ?? absIdx}>
                  <button
                    type="button"
                    onClick={() => jumpTo(absIdx)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-neutral-50"
                  >
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-neutral-300"
                      aria-hidden
                    />
                    <span className="line-clamp-1 flex-1 text-sm text-neutral-800">
                      {itemTitle}
                    </span>
                    <ChevronRight
                      className="size-3.5 shrink-0 text-neutral-400"
                      aria-hidden
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Later — collapsed by default; tap to expand */}
      {later.length > 0 ? (
        <div className="rounded-md border border-neutral-200 bg-white">
          <button
            type="button"
            onClick={() => setLaterExpanded((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] uppercase tracking-wider text-neutral-500 hover:bg-neutral-50"
          >
            <span className="font-medium">Later</span>
            <span className="text-neutral-400 tabular-nums">
              ({later.length})
            </span>
            <ChevronDown
              className={cn(
                "ml-auto size-3.5 transition-transform",
                laterExpanded ? "rotate-180" : "",
              )}
              aria-hidden
            />
          </button>
          {laterExpanded ? (
            <ul className="divide-y divide-neutral-100 border-t border-neutral-100">
              {later.map((item, i) => {
                const absIdx = currentIndex + 4 + i;
                const itemTitle = titleFor(item);
                return (
                  <li key={item.planItem.source_ref_id ?? absIdx}>
                    <button
                      type="button"
                      onClick={() => jumpTo(absIdx)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-50"
                    >
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-neutral-300"
                        aria-hidden
                      />
                      <span className="line-clamp-1 flex-1 text-sm text-neutral-700">
                        {itemTitle}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      <ItemDetailModal
        open={detailItem !== null}
        onClose={() => setDetailItem(null)}
        actionId={detailItem?.action_id}
        signalId={detailItem?.signal_id}
        title={detailItem?.title ?? ""}
        alreadyInToday={false}
        onChanged={onChanged}
        planDate={planDate}
        onDone={triggerCelebration}
      />
    </>
  );
}
