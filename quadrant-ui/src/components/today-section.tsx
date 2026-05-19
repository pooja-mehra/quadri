"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  GripVertical,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TodayPanel, type PanelItem } from "@/components/today-panel";
import { DAY_END_MIN, SLOT_MIN, TimeSlotBar } from "@/components/time-slot-bar";
import { cn } from "@/lib/utils";
import { todayLocalISO } from "@/lib/date";
import { useDailyPlan } from "@/lib/use-daily-plan";
import {
  type Slot,
  fetchSlotsRemote,
  makeSlotId,
  readSlots,
  writeSlots,
} from "@/lib/slots-storage";
import {
  calendarEventAt,
  liveStatus,
  nowSlotMin,
  type CalendarEvent,
  type LiveStatus,
} from "@/lib/today-helpers";
import { cascadePlace } from "@/lib/slot-cascade";
import { decideAction } from "@/lib/decisions";
import { readDismissed } from "@/lib/dismissed-actions";
import { SlotDetailModal } from "@/components/slot-detail-modal";
import type { DashboardState, PlanItem } from "@/lib/types";

export function TodaySection({
  state,
  onChanged,
  onTodayRefsChange,
  onCommittedTodayRefsChange,
  onDoneTodayRefsChange,
}: {
  state: DashboardState | null;
  onChanged: () => void;
  // All refs (action_id + signal_id) represented in Today — slots
  // (scheduled or unscheduled) plus plan top_items, excluding done.
  // QuadrantCard uses this to suppress the "+" button.
  onTodayRefsChange?: (refs: Set<string>) => void;
  // Refs of slots actually scheduled on the time bar (NOT unscheduled,
  // NOT plan-only). QuadrantCard uses this to flip the bullet color to
  // "committed" — slotted means committed, anything else stays pending.
  onCommittedTodayRefsChange?: (refs: Set<string>) => void;
  // Refs of slots flipped to slot.done=true locally (Mark Done in the
  // modal). Covers slots whose underlying action couldn't be /send'd
  // (rejected, no backing, etc.). QuadrantCard pulls these out of the
  // main bullet list and into "Done This Week".
  onDoneTodayRefsChange?: (refs: Set<string>) => void;
}) {
  // Locked to today — past/future navigation removed entirely. Per
  // project decision 2026-05-14: the dashboard only ever shows today.
  // If we ever re-introduce date browsing, restore viewDate prop +
  // navigation UI + agent's <<view-date:>> directive together.
  const todayPT = todayLocalISO();
  const planDate = todayPT;
  const { plan, phase } = useDailyPlan(planDate);

  // Today's calendar events from Fivetran-synced quadrant_signals.
  // These get promoted into local slots (idempotent via source_event_id) so
  // they're movable, editable, and markable-done like any other slot.
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let cancelled = false;
    fetch(
      `/api/calendar/today?plan_date=${encodeURIComponent(planDate)}&tz=${encodeURIComponent(tz)}`,
      { cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((data: { events: CalendarEvent[] }) => {
        if (!cancelled) setCalendarEvents(data.events ?? []);
      })
      .catch(() => {
        // Calendar is non-fatal; bar just shows empty cells if fetch fails.
      });
    return () => {
      cancelled = true;
    };
  }, [planDate]);

  // Promote calendar events to local slots once each. Matching by
  // source_event_id makes re-fetches idempotent: user-moved or marked-done
  // calendar items keep their local state across reloads.
  useEffect(() => {
    if (calendarEvents.length === 0) return;
    setSlots((prev) => {
      // Two passes:
      //   1. Existing slots for these events: re-anchor to the event's
      //      authoritative start_min and clear any stale unscheduled flag.
      //      Without this, an old × dismissal leaves the slot stuck off
      //      the bar forever (was the breakfast-in-panel bug).
      //   2. Add slots for events that have no existing slot.
      const eventById = new Map(calendarEvents.map((e) => [e.id, e]));
      const seenEventIds = new Set<string>();
      let changed = false;
      const reanchored = prev.map((s) => {
        if (!s.source_event_id) return s;
        const ev = eventById.get(s.source_event_id);
        if (!ev) return s;
        seenEventIds.add(s.source_event_id);
        // If user marked it done locally, leave it alone.
        if (s.done) return s;
        const wantsUpdate =
          s.slot_start_min !== ev.start_min ||
          s.unscheduled === true ||
          s.duration_min !== ev.duration_min;
        if (!wantsUpdate) return s;
        changed = true;
        return {
          ...s,
          slot_start_min: ev.start_min,
          duration_min: ev.duration_min,
          original_slot_start_min: ev.start_min,
          unscheduled: false,
        };
      });
      const additions: Slot[] = [];
      for (const ev of calendarEvents) {
        if (seenEventIds.has(ev.id)) continue;
        additions.push({
          // Deterministic slot_id derived from the calendar event id.
          // The previous `makeSlotId()` produced a fresh UUID per
          // promotion, which meant each cold-start mounted the SAME
          // calendar event under a NEW slot_id; combined with /api/slots
          // POST's MERGE-by-slot-id, BQ accumulated one row per cold-
          // start. Pinning slot_id to the event id makes it idempotent.
          slot_id: `cal_${ev.id}`,
          slot_start_min: ev.start_min,
          item_kind: "user",
          item_ref_id: ev.id,
          item_text: ev.title,
          source_event_id: ev.id,
          duration_min: ev.duration_min,
          original_slot_start_min: ev.start_min,
        });
      }
      if (!changed && additions.length === 0) return prev;
      return [...reanchored, ...additions];
    });
  }, [calendarEvents]);

  // Read on every render — refreshes when /api/state changes (cheap localStorage read).
  const dismissedRefIds = new Set(readDismissed(planDate));

  const [slots, setSlots] = useState<Slot[]>(() => readSlots(planDate));

  // Day rollover.
  const [lastDate, setLastDate] = useState(planDate);
  if (lastDate !== planDate) {
    setLastDate(planDate);
    setSlots(readSlots(planDate));
  }

  // Hydrate from BigQuery on mount and on planDate change. BQ is the
  // durable source of truth; localStorage is only an instant-render
  // cache. We always overwrite local with remote here — any "unsaved
  // local changes" the previous version protected were also (sometimes)
  // stale cross-date pollution from the prior writeSlots bug, so trusting
  // BQ unconditionally also cleans those up on next view.
  // Three-phase optimistic flow:
  //  1. quadri:slot-added (fired immediately by drop/chip): insert
  //     a placeholder slot with id `optimistic_<ref>_<start>`. NO
  //     refetch here — the BQ row doesn't exist yet, so a refetch
  //     would race and wipe the placeholder.
  //  2. quadri:slot-confirmed (fired after POST 200): refetch from
  //     BQ. The placeholder gets replaced with the real row (same
  //     start_min, real slot_id, real created_at).
  //  3. quadri:slot-failed (fired after POST !ok): drop the
  //     placeholder.
  const [slotRefetchKey, setSlotRefetchKey] = useState(0);
  useEffect(() => {
    function onSlotAdded(e: Event) {
      const detail = (e as CustomEvent<{
        ref_id?: string;
        slot_start_min?: number;
        duration_min?: number;
        item_text?: string;
        item_kind?: string;
      }>).detail;
      if (!detail?.ref_id || typeof detail.slot_start_min !== "number") return;
      const optimisticId = `optimistic_${detail.ref_id}_${detail.slot_start_min}`;
      setSlots((prev) => {
        if (prev.some((s) => s.slot_id === optimisticId)) return prev;
        return [
          ...prev,
          {
            slot_id: optimisticId,
            slot_start_min: detail.slot_start_min!,
            duration_min: detail.duration_min ?? 15,
            item_kind: (detail.item_kind ?? "committed_action") as Slot["item_kind"],
            item_ref_id: detail.ref_id!,
            item_text: detail.item_text ?? "(scheduling…)",
            done: false,
          },
        ];
      });
    }
    function onSlotConfirmed() {
      // BQ has it now — pull fresh, replace the optimistic with real.
      setSlotRefetchKey((k) => k + 1);
    }
    function onSlotFailed(e: Event) {
      const detail = (e as CustomEvent<{
        ref_id?: string;
        slot_start_min?: number;
      }>).detail;
      if (!detail?.ref_id || typeof detail.slot_start_min !== "number") return;
      const optimisticId = `optimistic_${detail.ref_id}_${detail.slot_start_min}`;
      setSlots((prev) => prev.filter((s) => s.slot_id !== optimisticId));
    }
    window.addEventListener("quadri:slot-added", onSlotAdded);
    window.addEventListener("quadri:slot-confirmed", onSlotConfirmed);
    window.addEventListener("quadri:slot-failed", onSlotFailed);
    return () => {
      window.removeEventListener("quadri:slot-added", onSlotAdded);
      window.removeEventListener("quadri:slot-confirmed", onSlotConfirmed);
      window.removeEventListener("quadri:slot-failed", onSlotFailed);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const remote = await fetchSlotsRemote(planDate);
      if (cancelled || remote === null) return;
      // Merge — DON'T replace. Two locally-built slot kinds can exist
      // before BQ knows about them:
      //   (a) Calendar promotions (have source_event_id) — the
      //       promotion effect auto-pins Google Calendar events to
      //       the bar; the BQ POST is fire-and-forget so a remote
      //       refetch races and would otherwise wipe them.
      //   (b) Optimistic slots from chip / drop scheduling (slot_id
      //       starts with "optimistic_") — same race, same fix.
      // For both, if remote doesn't yet have them, keep the local
      // copy so the bar stays visually stable. Once the BQ writes
      // land, the next refetch returns them with real slot_ids and
      // the dedup-by-item_ref_id below replaces the local versions.
      setSlots((prev) => {
        const remoteRefIds = new Set(
          remote.map((s) => s.item_ref_id).filter(Boolean) as string[],
        );
        const remoteSlotIds = new Set(remote.map((s) => s.slot_id));
        const preserved = prev.filter((s) => {
          const isCalendar = !!s.source_event_id;
          const isOptimistic = s.slot_id.startsWith("optimistic_");
          if (!isCalendar && !isOptimistic) return false;
          // Already represented in remote (by ref_id or slot_id)? Drop
          // the local copy; the remote one is canonical.
          if (s.slot_id && remoteSlotIds.has(s.slot_id)) return false;
          if (s.item_ref_id && remoteRefIds.has(s.item_ref_id)) return false;
          return true;
        });
        return [...remote, ...preserved];
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [planDate, slotRefetchKey]);

  useEffect(() => {
    // Guard: when planDate just changed, the rollover above has queued a
    // setSlots(readSlots(newPlanDate)) but the current `slots` value is
    // still the OLD planDate's slots. Writing them under the NEW planDate
    // would clobber the new date's local storage with today's data —
    // which is exactly the "today's events show up tomorrow" bug.
    // Skip until lastDate catches up; the next render will fire this
    // effect again with consistent slots + planDate.
    if (lastDate !== planDate) return;
    writeSlots(planDate, slots);
  }, [planDate, slots, lastDate]);

  // Compute live status per item once and share with both children.
  // Drop items the user explicitly rejected/deleted today.
  // Also canonicalize: the LLM ranker sometimes outputs source="goal" with
  // source_ref_id set to a signal_id ("drive_doc:..."). When a real
  // pending/committed action exists for that signal, rewrite the item so
  // its source_ref_id points at the action_id — that way liveStatus,
  // /api/actions/{id}, and Mark Done all wire to the same row, and done
  // items drop out of the panel naturally.
  const itemsWithStatus = useMemo<PanelItem[]>(() => {
    const signalToAction = new Map<
      string,
      { actionId: string; source: "pending_action" | "committed_action" }
    >();
    if (state) {
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
    }
    const isKnownAction = (id: string) =>
      !!state &&
      (state.pending_actions.some((a) => a.action_id === id) ||
        state.committed_actions.some((a) => a.action_id === id));

    // Refs marked done in the rolling 7-day window. Don't re-surface a
    // done one-time event in Today even when the ranker still lists it —
    // see [[feedback_ai_never_auto_commits]] + done-week design.
    const doneRefs = new Set(
      (state?.done_slot_refs ?? []).map((r) => r.ref_id),
    );
    return (plan?.top_items ?? [])
      .filter((item) => item.source !== "goal")
      .filter(
        (item) => !item.source_ref_id || !dismissedRefIds.has(item.source_ref_id),
      )
      .filter((item) => {
        if (!item.source_ref_id) return true;
        if (doneRefs.has(item.source_ref_id)) return false;
        for (const sid of item.cited_signal_ids ?? []) {
          if (doneRefs.has(sid)) return false;
        }
        return true;
      })
      .map((item) => {
        let normalized = item;
        const ref = item.source_ref_id;
        if (ref && !isKnownAction(ref)) {
          const candidates = [...(item.cited_signal_ids ?? []), ref];
          for (const sid of candidates) {
            const hit = signalToAction.get(sid);
            if (hit) {
              normalized = {
                ...item,
                source: hit.source,
                source_ref_id: hit.actionId,
              };
              break;
            }
          }
        }
        return { item: normalized, status: liveStatus(normalized, state) };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, state, dismissedRefIds.size]);

  // Visible slots: drop dismissed / unscheduled. For terminal-action
  // slots (action sent or rejected), keep visible only when the action
  // became terminal TODAY — that's a "just done/cancelled" item the
  // user wants to see with strike styling. If it was decided on a
  // PRIOR day, hide it: stale leftover from a previous day's context.
  const visibleSlots = useMemo(() => {
    // Build action_id → "was-terminal-before-today" set.
    const stalelyTerminal = new Set<string>();
    if (state) {
      const today = todayPT;
      for (const a of state.committed_actions) {
        if (!a.done && !a.cancelled) continue;
        // decided_at is ISO UTC; convert to PT date for the compare.
        if (!a.decided_at) {
          // No timestamp — treat as stale to be safe.
          stalelyTerminal.add(a.action_id);
          continue;
        }
        const d = new Date(a.decided_at);
        if (Number.isNaN(d.getTime())) continue;
        const pt = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Los_Angeles",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(d);
        if (pt < today) stalelyTerminal.add(a.action_id);
      }
    }
    return slots.filter(
      (s) =>
        !dismissedRefIds.has(s.item_ref_id) &&
        !s.unscheduled &&
        !stalelyTerminal.has(s.item_ref_id),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, dismissedRefIds.size, state, todayPT]);

  // Unscheduled slots — surface in the today panel as items the user can
  // drag onto the bar (or × to delete). Two sources of unscheduled slots:
  //   1. Calendar event the user × out from the bar (has source_event_id)
  //   2. Quadrant card item the user "+ added to today" (no source_event_id)
  const unscheduledPanelItems = useMemo<PanelItem[]>(
    () =>
      slots
        .filter((s) => s.unscheduled)
        .map((s) => ({
          item: {
            rank: 0,
            text: s.item_text,
            // Use 'user' as a generic source so PlanItem typing is happy.
            // The slot_id in source_ref_id is the discriminator we look for
            // in the drag/delete handlers.
            source: "user",
            source_ref_id: s.slot_id,
            cited_signal_ids: [],
          },
          status: "pending",
        })),
    [slots],
  );

  // Listen for "+ to today" events fired by QuadrantCard. Creates an
  // unscheduled slot so the item appears in the today panel; user can
  // then drag it to a time slot or × it to delete.
  useEffect(() => {
    type Detail = { ref_id: string; text: string };
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Detail>).detail;
      if (!detail?.ref_id || !detail?.text) return;
      let wasAdded = false;
      setSlots((prev) => {
        // Don't double-pin or shadow an already-slotted item.
        if (prev.some((s) => s.item_ref_id === detail.ref_id)) return prev;
        wasAdded = true;
        return [
          ...prev,
          {
            slot_id: makeSlotId(),
            slot_start_min: 0, // placeholder; unscheduled = true masks this
            item_kind: "user",
            item_ref_id: detail.ref_id,
            item_text: detail.text,
            unscheduled: true,
          },
        ];
      });
      // Defer the toast to next tick so it fires after setSlots's optimistic
      // reconciliation, ensuring the dedup branch decides correctly.
      queueMicrotask(() => {
        if (wasAdded) {
          toast.success(`Added to today: ${detail.text}`);
        } else {
          toast.info(`Already in today's list: ${detail.text}`);
        }
      });
    };
    window.addEventListener("quadri:add-to-today", handler as EventListener);
    return () =>
      window.removeEventListener(
        "quadri:add-to-today",
        handler as EventListener,
      );
  }, []);

  const slottedRefIds = useMemo(
    () => new Set(visibleSlots.map((s) => s.item_ref_id)),
    [visibleSlots],
  );

  // Any slot — scheduled OR unscheduled — represents this action in Today.
  // Used to suppress plan-derived duplicates (the ranker may surface the
  // same action the user already pinned via "+ to today" with different
  // phrasing).
  const allSlotRefIds = useMemo(
    () => new Set(slots.map((s) => s.item_ref_id)),
    [slots],
  );

  // action_id → its related_signal_ids. Lets us dedupe across DIFFERENT
  // actions that share a signal (e.g. an email_draft + a calendar_event
  // both drafted from the "Northline invoice overdue" Drive doc — two
  // action_ids, one signal_id, one underlying task in the user's head).
  const actionSignalsById = useMemo(() => {
    const m = new Map<string, string[]>();
    if (!state) return m;
    for (const a of state.pending_actions)
      m.set(a.action_id, a.related_signal_ids ?? []);
    for (const a of state.committed_actions)
      m.set(a.action_id, a.related_signal_ids ?? []);
    return m;
  }, [state]);

  const statusByRefId = useMemo(() => {
    const m = new Map<string, LiveStatus>();
    // Plan-derived status first, so non-action sources (goal, user) get
    // covered. State below is authoritative for action-backed items.
    for (const { item, status } of itemsWithStatus) {
      if (item.source_ref_id) m.set(item.source_ref_id, status);
    }
    // State overrides — `done = sent_at IS NOT NULL` on committed_actions
    // is the source of truth for "done". Also index by related signal_ids
    // so stale slots whose item_ref_id is a signal_id (created before the
    // plan-normalization fix) still resolve to "done" once their underlying
    // action is sent. For multi-action signals (e.g. Day 1 done, Day 2
    // pending) the more-actionable status wins — "done" only sticks when
    // the signal has no live action left.
    if (state) {
      for (const a of state.pending_actions) {
        m.set(a.action_id, "pending");
        for (const sid of a.related_signal_ids ?? [])
          if (!m.has(sid) || m.get(sid) === "done") m.set(sid, "pending");
      }
      for (const a of state.committed_actions) {
        const s: LiveStatus = a.cancelled
          ? "cancelled"
          : a.done
            ? "done"
            : "committed";
        m.set(a.action_id, s);
        for (const sid of a.related_signal_ids ?? []) {
          const cur = m.get(sid);
          if (!cur) m.set(sid, s);
          // Live ("committed" / "pending") status wins over terminal
          // ("done" / "cancelled") at signal granularity — if any action
          // on this signal is still live, prefer that for the chip.
          else if (
            (cur === "done" || cur === "cancelled") &&
            s !== "done" &&
            s !== "cancelled"
          ) {
            m.set(sid, s);
          }
        }
      }
    }
    return m;
  }, [itemsWithStatus, state]);

  // Items shown in the panel: unscheduled "+ to today" pins first (user
  // intent wins), then plan-ranker items that don't duplicate an existing
  // slot. Dedupe at two levels:
  //   - action_id: same action surfaced via plan + "+ to today" with
  //     different phrasing.
  //   - signal_id: two distinct actions (e.g. email + calendar reminder)
  //     drafted from the same Drive doc — same task in the user's head.
  const panelItems = useMemo(() => {
    const emittedSignals = new Set<string>();
    for (const slot of slots) {
      // Action-backed slot: pull its related signals.
      for (const sid of actionSignalsById.get(slot.item_ref_id) ?? [])
        emittedSignals.add(sid);
      // Stale-or-signal-only slot: item_ref_id IS itself a signal_id
      // (e.g. pre-fix localStorage with signal_id stored as ref_id, or
      // a "+ to today" of a bullet with no live action). Add it directly.
      if (slot.item_ref_id) emittedSignals.add(slot.item_ref_id);
    }
    const out: PanelItem[] = [...unscheduledPanelItems];
    for (const entry of itemsWithStatus) {
      if (entry.status === "done") continue;
      const refId = entry.item.source_ref_id;
      if (refId && allSlotRefIds.has(refId)) continue;
      const sigs = new Set<string>(entry.item.cited_signal_ids ?? []);
      if (refId) {
        for (const s of actionSignalsById.get(refId) ?? []) sigs.add(s);
      }
      let overlaps = false;
      for (const s of sigs) {
        if (emittedSignals.has(s)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      for (const s of sigs) emittedSignals.add(s);
      out.push(entry);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    unscheduledPanelItems,
    itemsWithStatus,
    allSlotRefIds,
    slots,
    actionSignalsById,
  ]);

  // Broadcast two ref sets to the quadrant cards:
  //   - allRefs: anything in Today (slots + plan items, excluding done).
  //     Used to suppress the "+" button on already-pinned bullets.
  //   - committedRefs: refs of slots ACTUALLY scheduled on the time bar.
  //     Used to flip the quadrant bullet color to "committed" amber.
  //     Plan items and unscheduled slots are NOT committed — moving a
  //     slot off the bar back into the panel should revert the bullet
  //     to its pending/default state in the quadrant.
  useEffect(() => {
    if (
      !onTodayRefsChange &&
      !onCommittedTodayRefsChange &&
      !onDoneTodayRefsChange
    )
      return;
    const allRefs = new Set<string>();
    const committedRefs = new Set<string>();
    const doneRefs = new Set<string>();
    for (const slot of slots) {
      if (!slot.item_ref_id) continue;
      allRefs.add(slot.item_ref_id);
      const sigs = actionSignalsById.get(slot.item_ref_id) ?? [];
      for (const sid of sigs) allRefs.add(sid);
      if (slot.done) {
        doneRefs.add(slot.item_ref_id);
        for (const sid of sigs) doneRefs.add(sid);
      } else if (!slot.unscheduled) {
        committedRefs.add(slot.item_ref_id);
        for (const sid of sigs) committedRefs.add(sid);
      }
    }
    // A bullet only flips to "committed" when the user actually drops it
    // onto the time bar. An AI-drafted calendar_event with event_start
    // does NOT count — that's an unconfirmed suggestion until the user
    // slots it.
    for (const entry of itemsWithStatus) {
      if (entry.status === "done") continue;
      const refId = entry.item.source_ref_id;
      if (refId) {
        allRefs.add(refId);
        for (const sid of actionSignalsById.get(refId) ?? []) allRefs.add(sid);
      }
      for (const sid of entry.item.cited_signal_ids ?? []) allRefs.add(sid);
    }
    onTodayRefsChange?.(allRefs);
    onCommittedTodayRefsChange?.(committedRefs);
    onDoneTodayRefsChange?.(doneRefs);
  }, [
    slots,
    itemsWithStatus,
    actionSignalsById,
    onTodayRefsChange,
    onCommittedTodayRefsChange,
    onDoneTodayRefsChange,
  ]);

  // Auto-slot done items that weren't manually slotted. Only fires once per
  // ref_id per session, tracked via ref to avoid loops.
  const autoSlottedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!plan || !state) return;
    const candidates = itemsWithStatus
      .filter(({ status }) => status === "done")
      .map(({ item }) => item)
      .filter(
        (item) =>
          item.source_ref_id &&
          !slottedRefIds.has(item.source_ref_id) &&
          !autoSlottedRef.current.has(item.source_ref_id),
      );

    if (candidates.length === 0) return;

    setSlots((prev) => {
      const out = [...prev];
      let cursor = nowSlotMin(SLOT_MIN);
      for (const item of candidates) {
        // Find next free, non-calendar slot starting at cursor.
        while (
          out.some((s) => s.slot_start_min === cursor) ||
          calendarEventAt(cursor, calendarEvents) !== null
        ) {
          cursor += SLOT_MIN;
        }
        out.push({
          slot_id: makeSlotId(),
          slot_start_min: cursor,
          item_kind: item.source,
          item_ref_id: item.source_ref_id!,
          item_text: item.text,
        });
        autoSlottedRef.current.add(item.source_ref_id!);
        cursor += SLOT_MIN;
      }
      return out;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsWithStatus]); // intentionally not in deps: slots/slottedRefIds (would loop)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  type ActiveDrag =
    | { kind: "todayItem"; item: PlanItem; status: LiveStatus }
    | { kind: "slotted"; slot: Slot; status: LiveStatus };

  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);


  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as
      | { kind: "todayItem"; item: PlanItem }
      | { kind: "slotted"; slot: Slot }
      | undefined;
    if (!data) return;
    if (data.kind === "todayItem") {
      // Panel items: still use the plan-derived live status so the drag
      // ghost matches the chip color in the panel (pending/committed/done).
      const status = data.item.source_ref_id
        ? statusByRefId.get(data.item.source_ref_id) ?? "unknown"
        : "unknown";
      setActiveDrag({ kind: "todayItem", item: data.item, status });
    } else {
      // Slotted items: time bar uses slot.done as the authoritative flag,
      // so the ghost should match — "done" if marked, "committed" otherwise.
      const status: LiveStatus = data.slot.done ? "done" : "committed";
      setActiveDrag({ kind: "slotted", slot: data.slot, status });
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDrag(null);
    const { active, over } = event;
    if (!over) {
      toast.info("drop missed: no drop target under cursor");
      return;
    }

    const overData = over.data.current as
      | { kind: "slot"; startMin: number; occupiedBy: string | null }
      | undefined;
    if (!overData || overData.kind !== "slot") {
      toast.info(`drop missed: over=${String(over.id)}`);
      return;
    }

    if (calendarEventAt(overData.startMin, calendarEvents)) {
      toast.error("That slot is on your calendar");
      return;
    }

    const activeData = active.data.current as
      | { kind: "todayItem"; item: PlanItem }
      | { kind: "slotted"; slot: Slot }
      | undefined;
    if (!activeData) {
      toast.error("drop failed: drag source missing data");
      return;
    }

    if (
      activeData.kind === "slotted" &&
      activeData.slot.slot_start_min === overData.startMin
    ) {
      return; // dropped where it was
    }

    if (activeData.kind === "todayItem" && !activeData.item.source_ref_id) {
      toast.error("Item has no reference id — can't slot");
      return;
    }

    // Re-schedule case: dragged "todayItem" whose source_ref_id matches an
    // unscheduled calendar slot. Treat as moving an existing slot rather
    // than creating a new one (so we don't duplicate the calendar event).
    let effectivePayload: typeof activeData = activeData;
    if (activeData.kind === "todayItem" && activeData.item.source_ref_id) {
      const unschedSlot = slots.find(
        (s) =>
          s.slot_id === activeData.item.source_ref_id && s.unscheduled,
      );
      if (unschedSlot) {
        effectivePayload = { kind: "slotted", slot: unschedSlot };
      }
    }

    const next = cascadePlace(
      slots,
      effectivePayload,
      overData.startMin,
      DAY_END_MIN,
      calendarEvents,
      SLOT_MIN,
    );
    if (!next) {
      toast.error("Not enough room — try a slot earlier in the day");
      return;
    }

    // Clear unscheduled on the re-placed calendar slot.
    if (effectivePayload.kind === "slotted" && effectivePayload.slot.unscheduled) {
      const placed = next.find(
        (s) => s.slot_id === effectivePayload.slot.slot_id,
      );
      if (placed) placed.unscheduled = false;
    }

    // Open the editor on drop so the user sees what they committed to.
    // Email sending is no longer triggered from the time bar — drafts
    // are sent only when the user explicitly asks Quadri in chat, and
    // only subject to scheduling prefs set on Quadri.
    if (activeData.kind === "todayItem" && activeData.item.source_ref_id) {
      const refId = activeData.item.source_ref_id;
      const newSlot = next.find((s) => s.item_ref_id === refId);
      if (newSlot && !newSlot.source_event_id) {
        setModalSlotId(newSlot.slot_id);
      }
    }
    setSlots(next);

    // Slotting from the today panel = committing. Promote pending → approved
    // so the chip transitions and /send (Mark Done) is unblocked. Two paths:
    // - plan-derived todayItem: source_ref_id IS the action_id.
    // - unscheduled "+ to today" item: source_ref_id is the slot_id; the
    //   real action_id lives on the placed slot's item_ref_id.
    const placedSlot =
      effectivePayload.kind === "slotted"
        ? next.find((s) => s.slot_id === effectivePayload.slot.slot_id) ?? null
        : activeData.kind === "todayItem" && activeData.item.source_ref_id
          ? next.find((s) => s.item_ref_id === activeData.item.source_ref_id) ??
            null
          : null;
    const approveCandidateRefId = placedSlot?.item_ref_id ?? null;
    if (approveCandidateRefId) {
      const isCurrentlyPending = state?.pending_actions.some(
        (a) => a.action_id === approveCandidateRefId,
      );
      if (isCurrentlyPending) {
        void decideAction(approveCandidateRefId, "approve").then((ok) => {
          if (ok) onChanged();
        });
      }
    }
  }

  // Modal state for the slot detail editor. Triggered on drop (above) and
  // on click of an occupied slot.
  const [modalSlotId, setModalSlotId] = useState<string | null>(null);
  const modalSlot = modalSlotId
    ? slots.find((s) => s.slot_id === modalSlotId) ?? null
    : null;

  function updateSlot(next: Slot) {
    setSlots((prev) =>
      prev.map((s) => (s.slot_id === next.slot_id ? next : s)),
    );
  }

  function removeSlotById(slotId: string) {
    setSlots((prev) => prev.filter((s) => s.slot_id !== slotId));
  }

  // Auto-send removed 2026-05-14: the time bar no longer fires email
  // sends. Drafts created from emails stay as drafts; the user must ask
  // Quadri in chat to send them, and Quadri respects the user's
  // scheduling preferences (send window, lead time, blackout hours).
  // See save_preference / list_preferences in agent.py.


  function removeSlot(slotId: string) {
    const slot = slots.find((s) => s.slot_id === slotId);
    if (!slot) return;

    // Calendar-imported slots: park in today panel as unscheduled rather
    // than deleting. User can drag back onto the bar, or × from the panel
    // to delete entirely.
    if (slot.source_event_id) {
      setSlots((prev) =>
        prev.map((s) =>
          s.slot_id === slotId ? { ...s, unscheduled: true } : s,
        ),
      );
      return;
    }

    // Action-backed slots: × also revokes the commit so the action returns
    // to the pending list as 'drafted'. Only flip status if currently
    // 'approved'; sent items are terminal (× shouldn't appear on them).
    if (slot.item_ref_id) {
      const live = state?.committed_actions.find(
        (a) => a.action_id === slot.item_ref_id,
      );
      if (live && !live.done) {
        void fetch(`/api/actions/${slot.item_ref_id}/uncommit`, {
          method: "POST",
        }).then((r) => {
          if (r.ok) onChanged();
        });
      }
    }
    setSlots((prev) => prev.filter((s) => s.slot_id !== slotId));
  }

  // Delete a today item.
  // - Synth unscheduled-calendar items: source_ref_id is a slot_id. Remove
  //   the slot entirely (the calendar event itself isn't touched).
  // - Action-backed items: reject the underlying action.
  async function deleteItem(item: PlanItem) {
    if (!item.source_ref_id) return;

    const slot = slots.find(
      (s) => s.slot_id === item.source_ref_id && s.unscheduled,
    );
    if (slot) {
      setSlots((prev) => prev.filter((s) => s.slot_id !== slot.slot_id));
      return;
    }

    if (item.source === "pending_action" || item.source === "committed_action") {
      const ok = await decideAction(item.source_ref_id, "reject");
      if (ok) onChanged();
    }
  }

  const totalOpen = panelItems.length;
  const totalDone = itemsWithStatus.filter((x) => x.status === "done").length;
  const total = itemsWithStatus.length;
  const summary = quadriSummary({
    phase,
    total,
    totalOpen,
    totalDone,
    hour: new Date().getHours(),
  });

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDrag(null)}
    >
      <Card className="overflow-hidden border-foreground/15 bg-white py-0 shadow-md">
        {/* "Today" status strip removed 2026-05-16. Bar only. */}
        <TimeSlotBar
          state={state}
          slots={visibleSlots}
          statusByRefId={statusByRefId}
          calendarEvents={calendarEvents}
          onRemoveSlot={removeSlot}
          onSlotClick={(slotId) => setModalSlotId(slotId)}
          planDate={planDate}
        />
      </Card>

      <DragOverlay dropAnimation={null}>
        {activeDrag ? <DragGhost drag={activeDrag} /> : null}
      </DragOverlay>

      <SlotDetailModal
        open={modalSlot !== null}
        onClose={() => setModalSlotId(null)}
        slot={modalSlot}
        onSlotUpdate={updateSlot}
        onRemoveSlot={() => {
          if (modalSlot) removeSlotById(modalSlot.slot_id);
        }}
        onChanged={onChanged}
      />
    </DndContext>
  );
}

// Quadri's voice — short, time-aware, ADHD-shaped. Varies through the day
// without cycling through a fixed list. Praise when things get done; gentle
// nudge when nothing's slotted; quiet when there's nothing to surface.
function quadriSummary(args: {
  phase: "loading" | "generating" | "ready";
  total: number;
  totalOpen: number;
  totalDone: number;
  hour: number;
}): string {
  const { phase, total, totalOpen, totalDone, hour } = args;

  if (phase === "loading") return "loading…";
  if (phase === "generating") return "thinking…";

  const morning = hour >= 5 && hour < 11;
  const evening = hour >= 17 && hour < 21;
  const lateNight = hour >= 21 || hour < 5;

  if (lateNight) {
    if (totalDone > 0) return `${totalDone} ${totalDone === 1 ? "win" : "wins"} today · rest up`;
    return "wind down";
  }

  if (total === 0) {
    if (morning) return "morning · quiet inbox";
    if (evening) return "evening · all clear";
    return "all clear";
  }

  // All done.
  if (totalOpen === 0) {
    if (evening) return `evening · ${total} done. nice.`;
    if (morning) return `already ${total} done? wow.`;
    return `${total} done · coast clear`;
  }

  // Some done.
  if (totalDone > 0) {
    if (evening) return `evening · ${totalDone} done, ${totalOpen} left`;
    if (totalDone === 1) return "1 done · keep going";
    return `${totalDone} done · ${totalOpen} to go`;
  }

  // None done yet.
  if (morning) return `morning · ${total} on deck`;
  if (evening) return `evening · ${total} still pending`;
  return `${total} to slot`;
}

const STATUS_GHOST: Record<LiveStatus, string> = {
  pending: "border-sky-500 bg-gradient-to-br from-sky-100 to-sky-200 text-sky-900",
  committed: "border-amber-500 bg-gradient-to-br from-amber-100 to-amber-200 text-amber-900",
  done: "border-emerald-500 bg-gradient-to-br from-emerald-100 to-emerald-200 text-emerald-900",
  cancelled: "border-rose-500 bg-gradient-to-br from-rose-100 to-rose-200 text-rose-900",
  unknown: "border-foreground/30 bg-muted text-foreground/70",
};

type ActiveDragGhost =
  | { kind: "todayItem"; item: PlanItem; status: LiveStatus }
  | { kind: "slotted"; slot: Slot; status: LiveStatus };

// (GoogleSyncButton removed — Google Calendar sync is now driven from
//  the Quadri chat instead of a header button. See the connect_google /
//  sync_today_calendar tools in agent.py.)

function DragGhost({ drag }: { drag: ActiveDragGhost }) {
  const text = drag.kind === "todayItem" ? drag.item.text : drag.slot.item_text;
  return (
    <div
      className={cn(
        "pointer-events-none flex w-[180px] items-center gap-1.5 rounded-md border-2 px-2 py-1.5 text-[11px] font-semibold leading-tight shadow-2xl ring-2 ring-foreground/10",
        STATUS_GHOST[drag.status],
      )}
    >
      <GripVertical className="size-3 shrink-0 opacity-70" aria-hidden />
      <span className="line-clamp-2">{text}</span>
      <Badge
        variant="outline"
        className="ml-auto shrink-0 border-current bg-white/70 text-[9px] font-bold uppercase"
      >
        {drag.status}
      </Badge>
    </div>
  );
}
