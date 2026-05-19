// Shared types + default settings used by both the API route and the
// settings page. Keep this file plain TypeScript (no React/Node imports)
// so it can be imported from server and client.

export type Settings = {
  data_sources: {
    calendar: boolean;
    gmail: boolean;
    slack: boolean;
    github: boolean;
    notion: boolean;
  };
  actions: {
    draft_email: boolean;
    draft_text: boolean;
    draft_calendar_event: boolean;
    propose_goals: boolean;
    auto_send_approved: boolean;
  };
  memory: {
    remember_conversations: boolean;
    auto_classify_signals: boolean;
    cross_quadrant_insights: boolean;
  };
  notifications: {
    morning_briefing: boolean;
    sunday_rebalance: boolean;
    body_double_sms: boolean;
    forgotten_commitment_nudges: boolean;
  };
};

export type SettingsSection = keyof Settings;

export const DEFAULTS: Settings = {
  data_sources: {
    calendar: true,
    gmail: true,
    slack: true,
    github: true,
    notion: true,
  },
  actions: {
    draft_email: true,
    draft_text: true,
    draft_calendar_event: true,
    propose_goals: true,
    auto_send_approved: false,
  },
  memory: {
    remember_conversations: true,
    auto_classify_signals: true,
    cross_quadrant_insights: true,
  },
  notifications: {
    morning_briefing: false,
    sunday_rebalance: false,
    body_double_sms: false,
    forgotten_commitment_nudges: false,
  },
};

// Used by GET to fill in any keys the saved row is missing (forward-compat
// when we add new toggles).
export function withDefaults(s: Partial<Settings> | null | undefined): Settings {
  return {
    data_sources: { ...DEFAULTS.data_sources, ...(s?.data_sources ?? {}) },
    actions: { ...DEFAULTS.actions, ...(s?.actions ?? {}) },
    memory: { ...DEFAULTS.memory, ...(s?.memory ?? {}) },
    notifications: { ...DEFAULTS.notifications, ...(s?.notifications ?? {}) },
  };
}
