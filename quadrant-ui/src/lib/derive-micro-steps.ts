import type {
  CommittedAction,
  Goal,
  GoalMicroStep,
  PendingAction,
} from "./types";

// For each active goal, pick one pending/committed action as today's
// micro-step. Prefer signal-overlap matches; fall back to same quadrant.
// No LLM — instant and predictable.
export function deriveMicroSteps(
  goals: Goal[],
  actions: (PendingAction | CommittedAction)[],
): Map<string, GoalMicroStep> {
  const used = new Set<string>(); // each action serves at most one goal
  const out = new Map<string, GoalMicroStep>();

  // Two-pass: signal-overlap first across all goals, then quadrant fallback.
  // First pass establishes the strongest matches; second fills the gaps.
  for (const goal of goals) {
    const goalSignals = new Set(goal.derived_from_signal_ids ?? []);
    if (goalSignals.size === 0) continue;

    let best: { action: PendingAction | CommittedAction; overlap: string[] } | null =
      null;
    for (const a of actions) {
      if (used.has(a.action_id)) continue;
      const overlap = a.related_signal_ids.filter((id) => goalSignals.has(id));
      if (overlap.length > 0 && (!best || overlap.length > best.overlap.length)) {
        best = { action: a, overlap };
      }
    }
    if (best) {
      used.add(best.action.action_id);
      out.set(goal.goal_id, {
        goal_id: goal.goal_id,
        text: describeAction(best.action),
        cited_signal_ids: best.overlap,
      });
    }
  }

  for (const goal of goals) {
    if (out.has(goal.goal_id)) continue;
    const match = actions.find(
      (a) => !used.has(a.action_id) && a.quadrant === goal.quadrant,
    );
    if (match) {
      used.add(match.action_id);
      out.set(goal.goal_id, {
        goal_id: goal.goal_id,
        text: describeAction(match),
        cited_signal_ids: match.related_signal_ids,
      });
    }
  }

  return out;
}

function describeAction(a: PendingAction | CommittedAction): string {
  const verb =
    a.action_type === "email_draft"
      ? "Send email"
      : a.action_type === "text_draft"
        ? "Send text"
        : "Schedule";
  const recipient = a.to_recipient ? ` to ${a.to_recipient}` : "";
  const detail = a.subject ?? a.body ?? "";
  const short = detail.length > 60 ? `${detail.slice(0, 57)}…` : detail;
  return short ? `${verb}${recipient} — ${short}` : `${verb}${recipient}`;
}
