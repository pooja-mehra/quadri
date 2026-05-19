-- Seed pending + committed actions for testing the side-by-side actions flow.
-- Idempotent via MERGE on action_id. Reuses signal_ids from 02_seed.sql.
--
-- Action statuses:
--   drafted   → "pending"   (awaiting Approve/Reject)
--   approved  → "committed" (awaiting Done / Undo)

MERGE quadrant.proposed_actions AS T
USING (
  SELECT * FROM UNNEST([
    -- ---------- PENDING (drafted) ----------
    STRUCT(
      "act_p_health_1" AS action_id, "demo_user" AS user_id,
      "email_draft" AS action_type, "drafted" AS status,
      "Confirm Tuesday physical with Dr Chen — overdue annual." AS reasoning,
      ["sig_006"] AS related_signal_ids,
      "drchen@clinic.example.com" AS to_recipient,
      "Re: Annual physical Tuesday 10am" AS subject,
      "Hi Dr Chen — confirming Tuesday 10am. Anything I should bring?" AS body,
      CAST(NULL AS TIMESTAMP) AS event_start, CAST(NULL AS TIMESTAMP) AS event_end,
      CAST(NULL AS ARRAY<STRING>) AS attendees,
      TIMESTAMP "2026-05-08 08:00:00" AS drafted_at,
      CAST(NULL AS TIMESTAMP) AS decided_at, CAST(NULL AS TIMESTAMP) AS sent_at,
      CAST(NULL AS JSON) AS metadata
    ),
    STRUCT(
      "act_p_rel_1", "demo_user", "text_draft", "drafted",
      "Mom missed the Sunday call — short check-in.",
      ["sig_011"], "mom", CAST(NULL AS STRING),
      "Hey Mom — sorry I missed Sunday. Free this evening for a quick call?",
      CAST(NULL AS TIMESTAMP), CAST(NULL AS TIMESTAMP), CAST(NULL AS ARRAY<STRING>),
      TIMESTAMP "2026-05-08 08:05:00", CAST(NULL AS TIMESTAMP), CAST(NULL AS TIMESTAMP),
      CAST(NULL AS JSON)
    ),
    STRUCT(
      "act_p_rel_2", "demo_user", "email_draft", "drafted",
      "Reschedule the brunch you declined; sister has been asking.",
      ["sig_008"], "sister@example.com",
      "Re: brunch this weekend?",
      "Hey — sorry for the late reply. How about brunch next Sunday?",
      CAST(NULL AS TIMESTAMP), CAST(NULL AS TIMESTAMP), CAST(NULL AS ARRAY<STRING>),
      TIMESTAMP "2026-05-08 08:10:00", CAST(NULL AS TIMESTAMP), CAST(NULL AS TIMESTAMP),
      CAST(NULL AS JSON)
    ),
    STRUCT(
      "act_p_career_1", "demo_user", "email_draft", "drafted",
      "Owe Priya the design-doc notes you promised by Friday.",
      ["sig_010"], "priya@example.com",
      "Re: design doc feedback",
      "Hi Priya — finally got the notes together. Top three concerns inline.",
      CAST(NULL AS TIMESTAMP), CAST(NULL AS TIMESTAMP), CAST(NULL AS ARRAY<STRING>),
      TIMESTAMP "2026-05-08 08:15:00", CAST(NULL AS TIMESTAMP), CAST(NULL AS TIMESTAMP),
      CAST(NULL AS JSON)
    ),
    STRUCT(
      "act_p_edu_1", "demo_user", "email_draft", "drafted",
      "Cohort still waiting for the reading list you promised.",
      ["sig_012"], "cohort@example.com",
      "Reading list — distributed systems",
      "Hey all — sorry for the delay. Reading list attached. Chapter 4 first.",
      CAST(NULL AS TIMESTAMP), CAST(NULL AS TIMESTAMP), CAST(NULL AS ARRAY<STRING>),
      TIMESTAMP "2026-05-08 08:20:00", CAST(NULL AS TIMESTAMP), CAST(NULL AS TIMESTAMP),
      CAST(NULL AS JSON)
    ),
    STRUCT(
      "act_p_health_2", "demo_user", "calendar_event", "drafted",
      "Block a 30-min run tomorrow morning — third week below 3 runs.",
      ["sig_005"], CAST(NULL AS STRING),
      "Run — 30 min", "Run — 30 min",
      TIMESTAMP "2026-05-09 07:00:00", TIMESTAMP "2026-05-09 07:30:00",
      CAST([] AS ARRAY<STRING>),
      TIMESTAMP "2026-05-08 08:25:00", CAST(NULL AS TIMESTAMP), CAST(NULL AS TIMESTAMP),
      CAST(NULL AS JSON)
    ),

    -- ---------- COMMITTED (approved, not yet sent) ----------
    STRUCT(
      "act_c_career_1", "demo_user", "email_draft", "approved",
      "Investor update follow-up to Sarah, awaiting your send.",
      ["sig_003"], "sarah@example.com",
      "Re: investor update draft v2",
      "Hi Sarah — v2 attached with the headcount asks updated.",
      CAST(NULL AS TIMESTAMP), CAST(NULL AS TIMESTAMP), CAST(NULL AS ARRAY<STRING>),
      TIMESTAMP "2026-05-07 10:00:00", TIMESTAMP "2026-05-07 11:00:00", CAST(NULL AS TIMESTAMP),
      CAST(NULL AS JSON)
    ),
    STRUCT(
      "act_c_career_2", "demo_user", "calendar_event", "approved",
      "Q2 retrospective with Maria — locked in last week.",
      ["sig_001"], CAST(NULL AS STRING),
      "Q2 retro w/ Maria", "Q2 retro w/ Maria",
      TIMESTAMP "2026-05-12 14:00:00", TIMESTAMP "2026-05-12 15:00:00",
      ["maria@example.com"],
      TIMESTAMP "2026-05-06 16:00:00", TIMESTAMP "2026-05-06 16:05:00", CAST(NULL AS TIMESTAMP),
      CAST(NULL AS JSON)
    ),
    STRUCT(
      "act_c_rel_1", "demo_user", "text_draft", "approved",
      "Quick check-in to Alex you'd been meaning to send.",
      ["sig_009"], "alex", CAST(NULL AS STRING),
      "Hey Alex — happy hour Thursday still on?",
      CAST(NULL AS TIMESTAMP), CAST(NULL AS TIMESTAMP), CAST(NULL AS ARRAY<STRING>),
      TIMESTAMP "2026-05-07 18:00:00", TIMESTAMP "2026-05-07 18:30:00", CAST(NULL AS TIMESTAMP),
      CAST(NULL AS JSON)
    ),
    STRUCT(
      "act_c_health_1", "demo_user", "calendar_event", "approved",
      "Saturday long run on the calendar — 60 min, lake loop.",
      ["sig_005"], CAST(NULL AS STRING),
      "Long run — lake loop", "Long run — lake loop",
      TIMESTAMP "2026-05-10 08:00:00", TIMESTAMP "2026-05-10 09:00:00",
      CAST([] AS ARRAY<STRING>),
      TIMESTAMP "2026-05-07 20:00:00", TIMESTAMP "2026-05-07 20:01:00", CAST(NULL AS TIMESTAMP),
      CAST(NULL AS JSON)
    )
  ])
) AS S
ON T.action_id = S.action_id
WHEN NOT MATCHED THEN
  INSERT (action_id, user_id, action_type, status, reasoning, related_signal_ids,
          to_recipient, subject, body, event_start, event_end, attendees,
          drafted_at, decided_at, sent_at, metadata)
  VALUES (S.action_id, S.user_id, S.action_type, S.status, S.reasoning, S.related_signal_ids,
          S.to_recipient, S.subject, S.body, S.event_start, S.event_end, S.attendees,
          S.drafted_at, S.decided_at, S.sent_at, S.metadata);
