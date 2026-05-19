// Quadri score — a single 0-100 number that reflects how "balanced"
// the user's day looks across the four life areas (Health, Education,
// Career, Relationships) plus a couple of light signals.
//
// Design tenet (locked 2026-05-17): the score is INFORMATIVE, never
// prescriptive. It does NOT nag about packed days, doesn't suggest
// rebalances, doesn't change the focus card behavior. It just tells
// the user where the day is right now.
//
// Three components, each weighted simply:
//   • Balance (50 pts): distinct quadrants represented in today's
//     open + done actions. 4 areas = full 50; scales linearly.
//   • Progress (30 pts): done-today / open-today ratio.
//   • Engagement (20 pts): any open or done item at all (so the
//     score doesn't read "0" on a quiet morning before anything
//     has landed).
//
// Returns the integer score plus a derivation list the footer can
// render verbatim.

import type { CommittedAction, DashboardState, PendingAction } from "./types";

export type ScoreComponent = {
  label: string;
  value: number;
  max: number;
};

export type QuadriScore = {
  score: number;
  components: ScoreComponent[];
  // Short one-line summary good for chat / tooltip ("3/4 areas active,
  // 60% progress").
  summary: string;
};

export function computeQuadriScore(state: DashboardState): QuadriScore {
  const allActions: Array<PendingAction | CommittedAction> = [
    ...state.pending_actions,
    ...state.committed_actions,
  ];

  // 1. Balance — distinct quadrants represented.
  const quadrants = new Set<string>();
  for (const a of allActions) {
    if (a.quadrant) quadrants.add(a.quadrant);
  }
  const balanceScore = Math.round((quadrants.size / 4) * 50);

  // 2. Progress — done today / total today, sourced from
  //    `today_slot_counts`. Calendar-imported slots don't have an
  //    underlying `proposed_actions` row, so the previous
  //    `committed_actions.done` filter undercounted them. The
  //    daily_slots table is the canonical source for "what's pinned
  //    today and which are done" — both calendar AND action slots
  //    live there with a uniform `done` boolean.
  const doneToday = state.today_slot_counts?.done ?? 0;
  const openToday = state.today_slot_counts?.open ?? 0;
  const totalToday = doneToday + openToday;
  const progressRatio = totalToday > 0 ? doneToday / totalToday : 0;
  const progressScore = Math.round(progressRatio * 30);

  // 3. Engagement — any item at all on the plate today.
  const engagementScore = totalToday > 0 ? 20 : 0;

  const score = Math.min(100, balanceScore + progressScore + engagementScore);

  return {
    score,
    components: [
      {
        label: `${quadrants.size}/4 areas active`,
        value: balanceScore,
        max: 50,
      },
      {
        label: `${doneToday}/${totalToday} done today`,
        value: progressScore,
        max: 30,
      },
      {
        label: totalToday > 0 ? "On the plate" : "Empty plate",
        value: engagementScore,
        max: 20,
      },
    ],
    summary:
      quadrants.size === 0
        ? "Nothing pinned yet today."
        : `${quadrants.size}/4 areas active · ${doneToday}/${totalToday} done`,
  };
}
