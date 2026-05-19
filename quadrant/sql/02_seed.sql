INSERT INTO quadrant.quadrant_signals
(signal_id, user_id, source, source_record_id, occurred_at, quadrant, quadrant_secondary, weight, valence, title, excerpt, participants, metadata, classified_by, classified_ref_id, ingested_at)
VALUES
-- Career — heavy week
("sig_001", "demo_user", "calendar", "cal_001", TIMESTAMP "2026-04-29 14:00:00", "career", NULL, 0.8, "positive", "Q2 planning with Maria", "Locked Q2 OKRs; got the headcount ask approved", ["maria@example.com"], JSON '{"duration_min": 60}', "rule", "rule_calendar_oneonone", CURRENT_TIMESTAMP()),
("sig_002", "demo_user", "github", "pr_2871", TIMESTAMP "2026-04-30 11:23:00", "career", NULL, 0.6, "positive", "Merged: ingestion retry logic", "PR #2871 closed after review", ["demo_user"], JSON '{"additions": 142, "deletions": 38}', "rule", "rule_github_merged", CURRENT_TIMESTAMP()),
("sig_003", "demo_user", "gmail", "msg_a3f2", TIMESTAMP "2026-05-01 09:14:00", "career", NULL, 0.4, "neutral", "Re: investor update draft", "Sent revised draft, awaiting Sarah's sign-off", ["sarah@example.com"], JSON '{"thread_size": 4}', "rule", "rule_gmail_sent_external", CURRENT_TIMESTAMP()),
("sig_004", "demo_user", "calendar", "cal_007", TIMESTAMP "2026-05-02 16:00:00", "career", NULL, 0.7, "negative", "On-call escalation", "Pager went off; spent 2hrs debugging prod", [], JSON '{"duration_min": 120}', "override", "ovr_oncall", CURRENT_TIMESTAMP()),

-- Health — under-served
("sig_005", "demo_user", "calendar", "cal_012", TIMESTAMP "2026-04-29 07:00:00", "health", NULL, 0.5, "positive", "Morning run", "5k around the lake", [], JSON '{"duration_min": 35}', "rule", "rule_calendar_workout", CURRENT_TIMESTAMP()),
("sig_006", "demo_user", "gmail", "msg_b7e1", TIMESTAMP "2026-05-01 18:02:00", "health", NULL, 0.3, "neutral", "Dr. Chen — appointment reminder", "Annual physical Tuesday 10am, please confirm", ["drchen@clinic.example.com"], JSON '{}', "rule", "rule_gmail_health_provider", CURRENT_TIMESTAMP()),

-- Education — light week
("sig_007", "demo_user", "notion", "page_x91", TIMESTAMP "2026-04-30 21:30:00", "education", NULL, 0.4, "positive", "Notes: distributed systems chapter 4", "20 min reading + summary notes", [], JSON '{"word_count": 412}', "rule", "rule_notion_learning", CURRENT_TIMESTAMP()),

-- Relationships — clearly the lowest
("sig_008", "demo_user", "gmail", "msg_c4d8", TIMESTAMP "2026-04-28 19:45:00", "relationships", NULL, 0.7, "negative", "Re: brunch this weekend?", "Declined; sister's third invite this month", ["sister@example.com"], JSON '{"sentiment": "decline"}', "llm", NULL, CURRENT_TIMESTAMP()),
("sig_009", "demo_user", "slack", "msg_d2a5", TIMESTAMP "2026-05-01 13:20:00", "relationships", NULL, 0.3, "neutral", "DM with Alex — happy hour?", "Said maybe, never followed up", ["alex"], JSON '{}', "llm", NULL, CURRENT_TIMESTAMP()),

-- Forgotten commitments (juicy for the sweep demo)
("sig_010", "demo_user", "gmail", "msg_e9f3", TIMESTAMP "2026-04-26 10:11:00", "career", NULL, 0.5, "neutral", "Re: design doc feedback", "I'll send notes by Friday — never sent", ["priya@example.com"], JSON '{"promise_detected": true}', "override", "ovr_promise", CURRENT_TIMESTAMP()),
("sig_011", "demo_user", "slack", "msg_f1b6", TIMESTAMP "2026-04-27 15:33:00", "relationships", NULL, 0.4, "neutral", "DM with mom", "Said I'd call Sunday — Sunday came and went", ["mom"], JSON '{"promise_detected": true}', "override", "ovr_promise", CURRENT_TIMESTAMP()),
("sig_012", "demo_user", "gmail", "msg_g8c9", TIMESTAMP "2026-04-29 12:00:00", "education", NULL, 0.3, "neutral", "Course: send group the reading list", "Promised in last cohort meeting; haven't", ["cohort@example.com"], JSON '{"promise_detected": true}', "override", "ovr_promise", CURRENT_TIMESTAMP());
