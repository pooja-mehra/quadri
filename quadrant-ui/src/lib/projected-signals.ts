// Synthetic signals written when the user approves/rejects/sends a drafted
// action. Lets the score react in real time to the user's commitment loop:
//   approve  → +0.15 positive (commitment goody)
//   reject   → +0.10 negative (marginal ding for avoidance)
//   sent     → +0.15 positive (follow-through bonus, on top of approve)
//
// Weights are intentionally smaller than typical real ingested signals
// (0.3–0.8) — intent is worth less than action. The score formula
// amplifies low-weight changes via engagement + sentiment compounding,
// so even +0.15 produces a meaningful (~+0.7) score shift on a
// below-saturation quadrant, which is the right reward magnitude.
//
// classified_by tags them so they can be distinguished from real
// ingested signals.

import { bq, fqn, USER_ID } from "./bq";

const SPECS = {
  approved: {
    weight: 0.15,
    valence: "positive" as const,
    classified_by: "approved_action",
    verb: "Committed:",
  },
  rejected: {
    weight: 0.1,
    valence: "negative" as const,
    classified_by: "rejected_action",
    verb: "Declined:",
  },
  sent: {
    weight: 0.15,
    valence: "positive" as const,
    classified_by: "sent_action",
    verb: "Sent:",
  },
} as const;

export type SignalKind = keyof typeof SPECS;

type ActionRow = {
  action_id: string;
  action_type: string;
  to_recipient: string | null;
  subject: string | null;
  body: string | null;
  related_signal_ids: string[] | null;
};

export async function recordProjectedSignal(actionId: string, kind: SignalKind): Promise<void> {
  const spec = SPECS[kind];

  // 1. Fetch the action so we can derive a quadrant + build the signal title.
  const [actionRows] = await bq.query({
    query: `
      SELECT action_id, action_type, to_recipient, subject, body, related_signal_ids
      FROM ${fqn("proposed_actions")}
      WHERE action_id = @id AND user_id = @uid
      LIMIT 1
    `,
    params: { id: actionId, uid: USER_ID },
  });
  if (actionRows.length === 0) return;
  const a = actionRows[0] as ActionRow;
  const relatedIds = a.related_signal_ids ?? [];

  // 2. Pick the most-common quadrant from the action's source signals.
  // If the action wasn't anchored to any signals, we can't infer a quadrant
  // — skip writing the synthetic signal in that case (better than guessing).
  if (relatedIds.length === 0) return;
  const [quadRows] = await bq.query({
    query: `
      SELECT quadrant
      FROM ${fqn("quadrant_signals")}
      WHERE signal_id IN UNNEST(@ids) AND quadrant IS NOT NULL
      GROUP BY quadrant
      ORDER BY COUNT(*) DESC
      LIMIT 1
    `,
    params: { ids: relatedIds },
  });
  if (quadRows.length === 0) return;
  const quadrant = (quadRows[0] as { quadrant: string }).quadrant;

  // 3. Insert the synthetic signal.
  const signalId = `synth_${kind}_${actionId}`;
  const recipient = a.to_recipient ?? "—";
  const title = `${spec.verb} ${a.action_type.replace("_", " ")} → ${recipient}`;
  const excerptRaw = a.subject ?? a.body ?? "";
  const excerpt = excerptRaw.slice(0, 240);

  // MERGE on signal_id so repeated clicks (e.g., reject then re-approve) just
  // update the same row instead of piling up duplicates. signal_id is
  // deterministic per (kind, actionId).
  await bq.query({
    query: `
      MERGE ${fqn("quadrant_signals")} T
      USING (
        SELECT
          @sid AS signal_id, @uid AS user_id, 'projected' AS source, @aid AS source_record_id,
          CURRENT_TIMESTAMP() AS occurred_at, @q AS quadrant, @w AS weight, @v AS valence,
          @t AS title, @e AS excerpt, @cb AS classified_by, @aid AS classified_ref_id,
          CURRENT_TIMESTAMP() AS ingested_at
      ) S
      ON T.signal_id = S.signal_id
      WHEN MATCHED THEN UPDATE SET
        occurred_at       = S.occurred_at,
        quadrant          = S.quadrant,
        weight            = S.weight,
        valence           = S.valence,
        title             = S.title,
        excerpt           = S.excerpt,
        classified_by     = S.classified_by,
        ingested_at       = S.ingested_at
      WHEN NOT MATCHED THEN
        INSERT (signal_id, user_id, source, source_record_id, occurred_at,
                quadrant, weight, valence, title, excerpt, participants, metadata,
                classified_by, classified_ref_id, ingested_at)
        VALUES (S.signal_id, S.user_id, S.source, S.source_record_id, S.occurred_at,
                S.quadrant, S.weight, S.valence, S.title, S.excerpt, [],
                JSON '{"projected": true}',
                S.classified_by, S.classified_ref_id, S.ingested_at)
    `,
    params: {
      sid: signalId,
      uid: USER_ID,
      aid: actionId,
      q: quadrant,
      w: spec.weight,
      v: spec.valence,
      t: title,
      e: excerpt,
      cb: spec.classified_by,
    },
  });
}
