import type { Quadrant } from "./bq";

export type TopSignal = {
  signal_id: string;
  title: string;
  valence: "positive" | "neutral" | "negative";
  weight: number;
  excerpt: string;
  occurred_at: string | null;   // ISO timestamp — used for day-of-week label and sort
  source: string | null;        // 'calendar' | 'google_drive_doc' | 'google_drive_sheet' | …
                                // Calendar items get a clock-time appended to the chip.
};

export type QuadrantScore = {
  quadrant: Quadrant;
  signal_count: number;
  positive_weight: number;
  negative_weight: number;
  total_weight: number;
  score: number;
  user_weight: number;
  weight_source: "default" | "user_set";
  under_funded_score: number | null;
  top_signals: TopSignal[];
};

export type Goal = {
  goal_id: string;
  quadrant: Quadrant;
  title: string;
  description: string;
  source: "user_set" | "derived" | "imported";
  status: "active" | "proposed" | "archived";
  derived_reasoning?: string | null;
  derived_from_signal_ids?: string[];
  derived_confidence?: number | null;
  proposed_at?: string;
  approved_at?: string | null;
  // Populated by /api/state from today's daily_plan_v1 row, when present.
  // Hidden when generated_at is not the user-local date for today.
  today_micro_step?: GoalMicroStep | null;
};

export type GoalMicroStep = {
  goal_id: string;
  text: string;
  cited_signal_ids: string[];
};

export type PlanItem = {
  rank: number;
  text: string;
  source:
    | "pending_action"
    | "committed_action"
    | "forgotten_commitment"
    | "goal"
    | "user";
  source_ref_id: string | null;
  cited_signal_ids: string[];
};

export type DailyPlan = {
  plan_id: string;
  plan_date: string;       // ISO date in user-local TZ
  generated_at: string;    // ISO timestamp UTC
  user_intentions: string | null;
  top_items: PlanItem[];
  goal_micro_steps: GoalMicroStep[];
  nudge_at: string | null;
};

export type PendingAction = {
  action_id: string;
  action_type: "email_draft" | "text_draft" | "calendar_event";
  to_recipient: string | null;
  subject: string | null;
  body: string | null;
  attendees: string[] | null;
  event_start: string | null;
  event_end: string | null;
  reasoning: string | null;
  related_signal_ids: string[];
  drafted_at: string;
  // Derived from related_signal_ids — null if none of the source signals
  // had a quadrant assigned.
  quadrant: Quadrant | null;
};

export type CommittedAction = PendingAction & {
  decided_at: string;
  hours_since_decided: number;  // age — UI uses this for the "stale" badge
  done: boolean;                 // true once user marked done (status='sent'); stays
                                 // visible with strikethrough until week rolls.
  cancelled: boolean;            // true when status='rejected'. Shown in Done section
                                 // with red strike instead of green.
  cancel_reason: string | null;  // from metadata.cancel_reason (chatbot-saved).
  user_note: string | null;      // from metadata.user_note (chatbot-saved on done).
  snoozed_until: string | null;  // ISO timestamp; while in the future, Quadri
                                 // and the quadrant card suppress this item.
};

export type UserPreferences = {
  deep_work_hours: string | null;     // "9am-noon", "9am-6pm", etc.
  timezone: string | null;
};

export type DashboardState = {
  scores: QuadrantScore[];
  active_goals: Goal[];
  proposed_goals: Goal[];
  pending_actions: PendingAction[];
  committed_actions: CommittedAction[];
  preferences: UserPreferences;
  // Today's plan, if one exists for the user-local date. Null until the
  // user taps "Plan today". Stale (non-today) plans are hidden upstream.
  daily_plan: DailyPlan | null;
  // Rolling 7-day window of slots marked done. The quadrant card uses this
  // to bucket cross-date dones into "Done This Week" (and to drop dones
  // older than the window from the main list).
  done_slot_refs: DoneSlotRef[];
  // Counts of TODAY's daily_slots — needed for the Quadri Score because
  // calendar-imported slots have no `proposed_actions` row, so
  // committed_actions.done counts miss them. Includes both open
  // (done=false / null) and done slots, scoped to today's plan_date.
  today_slot_counts: {
    open: number;
    done: number;
  };
};

export type DoneSlotRef = {
  ref_id: string;      // slot.item_ref_id — action_id, signal_id, or calendar event id
  plan_date: string;   // YYYY-MM-DD in user-local TZ
};
