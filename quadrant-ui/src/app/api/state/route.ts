import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";
import { isAuthorized } from "@/lib/google-oauth";
import type {
  CommittedAction,
  DashboardState,
  Goal,
  PendingAction,
  QuadrantScore,
} from "@/lib/types";

export const dynamic = "force-dynamic";

// Empty payload shape — returned when the user isn't connected to Google
// or hasn't completed onboarding. Mirrors DashboardState so the UI's
// destructuring keeps working; just no rows. Without this gate, Fivetran
// side-syncs (calendar, drive) flow into the quadrants regardless of
// whether the user has authorized Quadri — defeating the "connect first,
// scope second, fetch third" model from [[project_onboarding_gating]].
const EMPTY_PAYLOAD: DashboardState = {
  scores: [
    { quadrant: "health", signal_count: 0, positive_weight: 0, negative_weight: 0, total_weight: 0, score: 0, user_weight: 0.25, weight_source: "default", under_funded_score: null, top_signals: [] },
    { quadrant: "education", signal_count: 0, positive_weight: 0, negative_weight: 0, total_weight: 0, score: 0, user_weight: 0.25, weight_source: "default", under_funded_score: null, top_signals: [] },
    { quadrant: "career", signal_count: 0, positive_weight: 0, negative_weight: 0, total_weight: 0, score: 0, user_weight: 0.25, weight_source: "default", under_funded_score: null, top_signals: [] },
    { quadrant: "relationships", signal_count: 0, positive_weight: 0, negative_weight: 0, total_weight: 0, score: 0, user_weight: 0.25, weight_source: "default", under_funded_score: null, top_signals: [] },
  ],
  active_goals: [],
  proposed_goals: [],
  pending_actions: [],
  committed_actions: [],
  preferences: { deep_work_hours: null, timezone: null },
  daily_plan: null,
  done_slot_refs: [],
  today_slot_counts: { open: 0, done: 0 },
};

export async function GET() {
  try {
    // Gate: nothing flows to the UI until the user has authorized
    // Google AND completed onboarding. Fivetran can keep ingesting
    // upstream and the classifier can keep populating BQ, but the
    // dashboard treats those as invisible until the user is in.
    const [authorized, onboardingRows] = await Promise.all([
      isAuthorized().catch(() => false),
      bq
        .query({
          query: `
            SELECT
              COALESCE(
                CAST(JSON_VALUE(settings, '$.onboarding.completed') AS BOOL),
                FALSE
              ) AS completed
            FROM ${fqn("user_settings")}
            WHERE user_id = @uid
            LIMIT 1
          `,
          params: { uid: USER_ID },
        })
        .then(([rows]) => rows)
        .catch(() => []),
    ]);
    const onboardingCompleted = Boolean(
      onboardingRows[0]?.completed,
    );
    if (!authorized || !onboardingCompleted) {
      return NextResponse.json(EMPTY_PAYLOAD);
    }

    // Roll forward yesterday's undone items so the dashboard never
    // shows past-dated pending bullets. Calendar-source signals are
    // skipped (real events, not AI plans). Cheap when nothing's stale
    // — UPDATE just affects 0 rows. Fail-silent: a rollover failure
    // shouldn't take down the dashboard.
    await Promise.all([
      bq
        .query({
          query: `
            UPDATE ${fqn("quadrant_signals")} AS s
            SET occurred_at = TIMESTAMP(CURRENT_DATE('America/Los_Angeles'), 'America/Los_Angeles'),
                ingested_at = CURRENT_TIMESTAMP()
            WHERE s.user_id = @uid
              AND s.source != 'calendar'
              AND DATE(s.occurred_at, 'America/Los_Angeles') < CURRENT_DATE('America/Los_Angeles')
              AND s.signal_id NOT IN (
                SELECT item_ref_id FROM ${fqn("daily_slots")}
                WHERE done = TRUE AND item_ref_id IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM ${fqn("proposed_actions")} pa,
                     UNNEST(pa.related_signal_ids) AS sid
                WHERE sid = s.signal_id AND pa.status IN ('sent', 'rejected')
              )
          `,
          params: { uid: USER_ID },
        })
        .catch(() => null),
      bq
        .query({
          query: `
            UPDATE ${fqn("proposed_actions")}
            SET event_start = TIMESTAMP(CURRENT_DATE('America/Los_Angeles'), 'America/Los_Angeles'),
                event_end = NULL
            WHERE user_id = @uid
              AND action_type = 'calendar_event'
              AND status IN ('drafted', 'approved')
              AND sent_at IS NULL
              AND event_start IS NOT NULL
              AND DATE(event_start, 'America/Los_Angeles') < CURRENT_DATE('America/Los_Angeles')
          `,
          params: { uid: USER_ID },
        })
        .catch(() => null),
      // Slots are NEVER auto-rolled — they're user decisions. The
      // signal/action rollovers above surface stale items in today's
      // priority list; the user re-pins to the bar if they want.
    ]);

    const [scoresRows, goalsRows, draftedRows, committedRows, prefsRows, doneSlotRows, todaySlotCountRows] = await Promise.all([
      bq.query({
        query: `SELECT * FROM ${fqn("vw_quadrant_scores_current")}`,
      }).then(([rows]) => rows),
      bq.query({
        query: `
          SELECT goal_id, quadrant, title, description, source, status,
                 derived_reasoning, derived_from_signal_ids, derived_confidence,
                 proposed_at, approved_at
          FROM ${fqn("user_goals")}
          WHERE user_id = @uid AND status IN ('active', 'proposed')
          ORDER BY status, proposed_at DESC
        `,
        params: { uid: USER_ID },
      }).then(([rows]) => rows),
      bq.query({
        // Pending drafts use a rolling 7-day window — NOT the
        // Monday-anchored week. Otherwise a draft created Sunday
        // night disappears Monday morning even though nothing
        // happened to it, which the user sees as "Quadri lost my
        // drafts." Drafts stay alive until acted on (sent /
        // rejected / aged out at 7d).
        query: `
          WITH cutoff AS (
            SELECT TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY) AS ts
          ),
          unnested AS (
            SELECT p.action_id, sig_id
            FROM ${fqn("proposed_actions")} p,
                 UNNEST(p.related_signal_ids) AS sig_id, cutoff
            WHERE p.user_id = @uid AND p.status = 'drafted'
              AND p.drafted_at >= cutoff.ts
          ),
          quadrant_counts AS (
            SELECT u.action_id, s.quadrant AS q, COUNT(*) AS n
            FROM unnested u
            JOIN ${fqn("quadrant_signals")} s ON s.signal_id = u.sig_id
            WHERE s.quadrant IS NOT NULL
            GROUP BY u.action_id, s.quadrant
          ),
          derived AS (
            SELECT
              action_id,
              ARRAY_AGG(q ORDER BY n DESC LIMIT 1)[OFFSET(0)] AS derived_quadrant
            FROM quadrant_counts
            GROUP BY action_id
          )
          SELECT
            p.action_id, p.action_type, p.to_recipient, p.subject, p.body, p.attendees,
            p.event_start, p.event_end, p.reasoning, p.related_signal_ids, p.drafted_at,
            d.derived_quadrant
          FROM ${fqn("proposed_actions")} p
          LEFT JOIN derived d USING (action_id)
          CROSS JOIN cutoff
          WHERE p.user_id = @uid AND p.status = 'drafted'
            AND p.drafted_at >= cutoff.ts
          ORDER BY p.drafted_at DESC
        `,
        params: { uid: USER_ID },
      }).then(([rows]) => rows),
      bq.query({
        // Committed actions: same rolling 7-day window. Anchoring to
        // Monday made approved-but-unsent drafts vanish on the
        // weekly rollover even though they're still live.
        query: `
          WITH cutoff AS (
            SELECT TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY) AS ts
          ),
          unnested AS (
            SELECT p.action_id, sig_id
            FROM ${fqn("proposed_actions")} p,
                 UNNEST(p.related_signal_ids) AS sig_id, cutoff
            WHERE p.user_id = @uid AND p.drafted_at >= cutoff.ts AND (
              (p.status = 'approved' AND p.sent_at IS NULL)
              OR p.status = 'sent'
              OR p.status = 'rejected'
            )
          ),
          quadrant_counts AS (
            SELECT u.action_id, s.quadrant AS q, COUNT(*) AS n
            FROM unnested u
            JOIN ${fqn("quadrant_signals")} s ON s.signal_id = u.sig_id
            WHERE s.quadrant IS NOT NULL
            GROUP BY u.action_id, s.quadrant
          ),
          derived AS (
            SELECT
              action_id,
              ARRAY_AGG(q ORDER BY n DESC LIMIT 1)[OFFSET(0)] AS derived_quadrant
            FROM quadrant_counts
            GROUP BY action_id
          )
          SELECT
            p.action_id, p.action_type, p.to_recipient, p.subject, p.body, p.attendees,
            p.event_start, p.event_end, p.reasoning, p.related_signal_ids, p.drafted_at,
            p.decided_at,
            TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), p.decided_at, HOUR) AS hours_since_decided,
            p.sent_at IS NOT NULL AS done,
            p.status = 'rejected' AS cancelled,
            JSON_VALUE(p.metadata, '$.cancel_reason') AS cancel_reason,
            JSON_VALUE(p.metadata, '$.user_note') AS user_note,
            JSON_VALUE(p.metadata, '$.snoozed_until') AS snoozed_until,
            d.derived_quadrant
          FROM ${fqn("proposed_actions")} p
          LEFT JOIN derived d USING (action_id)
          CROSS JOIN cutoff
          WHERE p.user_id = @uid AND p.drafted_at >= cutoff.ts AND (
            (p.status = 'approved' AND p.sent_at IS NULL)
            OR p.status = 'sent'
            OR p.status = 'rejected'
          )
          ORDER BY done ASC, cancelled ASC, p.decided_at DESC
        `,
        params: { uid: USER_ID },
      }).then(([rows]) => rows),
      bq.query({
        query: `
          SELECT deep_work_hours, timezone
          FROM ${fqn("user_preferences")}
          WHERE user_id = @uid
          LIMIT 1
        `,
        params: { uid: USER_ID },
      }).then(([rows]) => rows).catch(() => []),
      // Rolling 7-day window of done slots. Used by the quadrant card to
      // bucket a bullet into "Done This Week" (and the Today panel to
      // suppress its re-appearance) even when the user is viewing on a
      // day after the slot was marked done. Window matches the
      // [[project_today_no_ai_suggestions]] sibling rule that done
      // one-time events should never echo back.
      bq.query({
        query: `
          SELECT item_ref_id, plan_date
          FROM ${fqn("daily_slots")}
          WHERE done = TRUE
            AND plan_date >= DATE_SUB(CURRENT_DATE('America/Los_Angeles'), INTERVAL 7 DAY)
            AND item_ref_id IS NOT NULL
        `,
      }).then(([rows]) => rows).catch(() => []),
      // Per-bucket count of today's daily_slots. Used by the Quadri
      // Score footer so calendar-imported slots (no proposed_actions
      // backing → committed_actions.done can never flip) still
      // contribute to "done today".
      bq.query({
        query: `
          SELECT
            COUNTIF(done IS NULL OR done = FALSE) AS open_count,
            COUNTIF(done = TRUE) AS done_count
          FROM ${fqn("daily_slots")}
          WHERE user_id = @uid
            AND plan_date = CURRENT_DATE('America/Los_Angeles')
            AND (unscheduled IS NULL OR unscheduled = FALSE)
        `,
        params: { uid: USER_ID },
      }).then(([rows]) => rows).catch(() => []),
    ]);

    const scores = scoresRows.map(normalizeScore);
    const allGoals = goalsRows.map(normalizeGoal);
    const pending_actions = draftedRows.map(normalizeAction);
    const committed_actions = committedRows.map(normalizeCommitted);
    const done_slot_refs = doneSlotRows.map((r) => ({
      ref_id: String((r as Record<string, unknown>).item_ref_id),
      plan_date: String((r as Record<string, unknown>).plan_date),
    }));
    const todayCountRow = (todaySlotCountRows[0] ?? {}) as Record<string, unknown>;
    const today_slot_counts = {
      open: Number(todayCountRow.open_count ?? 0),
      done: Number(todayCountRow.done_count ?? 0),
    };

    const prefs = (prefsRows[0] ?? {}) as Record<string, unknown>;
    const payload: DashboardState = {
      scores,
      active_goals: allGoals.filter((g) => g.status === "active"),
      proposed_goals: allGoals.filter((g) => g.status === "proposed"),
      pending_actions,
      committed_actions,
      preferences: {
        deep_work_hours: prefs.deep_work_hours ? String(prefs.deep_work_hours) : null,
        timezone: prefs.timezone ? String(prefs.timezone) : null,
      },
      daily_plan: null,  // hydrated by page.tsx via /api/plan/today
      done_slot_refs,
      today_slot_counts,
    };

    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}

// BigQuery returns timestamps as { value: string } objects and decimals as
// strings; normalize to plain JS for the UI.
function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v && "value" in v) return String((v as { value: unknown }).value);
  return null;
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v);
  return 0;
}

function normalizeScore(r: Record<string, unknown>): QuadrantScore {
  const top = (r.top_signals as Record<string, unknown>[] | undefined) ?? [];
  return {
    quadrant: r.quadrant as QuadrantScore["quadrant"],
    signal_count: num(r.signal_count),
    positive_weight: num(r.positive_weight),
    negative_weight: num(r.negative_weight),
    total_weight: num(r.total_weight),
    score: num(r.score),
    user_weight: num(r.user_weight),
    weight_source: (r.weight_source as QuadrantScore["weight_source"]) ?? "default",
    under_funded_score: r.under_funded_score == null ? null : num(r.under_funded_score),
    top_signals: top.map((s) => ({
      signal_id: String(s.signal_id),
      title: String(s.title ?? ""),
      valence: (s.valence as TopSignalValence) ?? "neutral",
      weight: num(s.weight),
      excerpt: String(s.excerpt ?? ""),
      occurred_at: isoOrNull(s.occurred_at),
      source: s.source ? String(s.source) : null,
    })),
  };
}

type TopSignalValence = "positive" | "neutral" | "negative";

function normalizeGoal(r: Record<string, unknown>): Goal {
  return {
    goal_id: String(r.goal_id),
    quadrant: r.quadrant as Goal["quadrant"],
    title: String(r.title ?? ""),
    description: String(r.description ?? ""),
    source: r.source as Goal["source"],
    status: r.status as Goal["status"],
    derived_reasoning: r.derived_reasoning ? String(r.derived_reasoning) : null,
    derived_from_signal_ids: (r.derived_from_signal_ids as string[]) ?? [],
    derived_confidence: r.derived_confidence == null ? null : num(r.derived_confidence),
    proposed_at: isoOrNull(r.proposed_at) ?? undefined,
    approved_at: isoOrNull(r.approved_at),
  };
}

function normalizeAction(r: Record<string, unknown>): PendingAction {
  return {
    action_id: String(r.action_id),
    action_type: r.action_type as PendingAction["action_type"],
    to_recipient: r.to_recipient ? String(r.to_recipient) : null,
    subject: r.subject ? String(r.subject) : null,
    body: r.body ? String(r.body) : null,
    attendees: (r.attendees as string[]) ?? null,
    event_start: isoOrNull(r.event_start),
    event_end: isoOrNull(r.event_end),
    reasoning: r.reasoning ? String(r.reasoning) : null,
    related_signal_ids: (r.related_signal_ids as string[]) ?? [],
    drafted_at: isoOrNull(r.drafted_at) ?? "",
    quadrant: (r.derived_quadrant as PendingAction["quadrant"]) ?? null,
  };
}

function normalizeCommitted(r: Record<string, unknown>): CommittedAction {
  return {
    ...normalizeAction(r),
    decided_at: isoOrNull(r.decided_at) ?? "",
    hours_since_decided: num(r.hours_since_decided),
    done: Boolean(r.done),
    cancelled: Boolean(r.cancelled),
    cancel_reason: r.cancel_reason ? String(r.cancel_reason) : null,
    user_note: r.user_note ? String(r.user_note) : null,
    snoozed_until: r.snoozed_until ? String(r.snoozed_until) : null,
  };
}
