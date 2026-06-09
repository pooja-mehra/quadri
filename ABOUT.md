# Quadri

> **The copilot for when you don't know where to start.**

---

## A note on the demo link

**The link we're sharing is a sandboxed demo deployment** — built so judges can click through the real product without any setup. A few buttons are intentionally inert here:

- **Export notes** and **Sync with Google Calendar** (and **Send email**) are **no-oped in the demo.** These are the only actions that reach *outside* the app, and live versions require **your own Google OAuth** — Quadri never sends or writes from its own identity, so there's no shared account to act through on a public link.
- **Live ingestion runs on Fivetran.** Pulling your Calendar and Drive into BigQuery needs an authenticated **Fivetran subscription** wired to your Google account. The demo runs on **pre-loaded sample data** instead, so the full experience is visible without connecting anything.

**Everything else is real.** Every BigQuery read and write still happens — the focus ranker, drafting, attaching Drive docs, marking items done, the self-hiding "Done today" panel. Click **Send** in a draft and Quadri marks the action sent and updates the Done panel; only the final outbound network call is sandboxed. In short: **nothing is faked except what would leave the building.** A header **Demo** pill makes the mode visible at all times.

To run the fully live version, connect your own Google account (OAuth) and a Fivetran source — `QUADRI_DEMO_MODE=false` flips every one of these buttons back on.

---

## Inspiration

Executive dysfunction isn't a motivation problem — it's a *decision* problem. The moment that breaks the day isn't the work itself; it's standing in front of 30 unread emails, 12 half-tasks, and a full calendar, and being unable to pick the **one** thing to touch first. Every app we tried made this worse: they showed us *everything*, brightly, all at once. Kanban boards, priority matrices, streak counters — each one a fresh surface to feel behind on.

We wanted the opposite. Not a system that demands you organize your life before it helps, but one that reads the life you already have — your inbox, your calendar, your Drive — and quietly hands you a single next thing. Quadri is named for the four life quadrants it balances (career, health, education, relationships), but the whole product is built around subtraction: throwing away the grid, the firehose, and the shame triggers until one card remains.

## What it does

Quadri reads three Google sources — **Gmail, Calendar, and Drive** — and turns them into one quiet list. Then it does four simple things:

- **Picks one thing.** A single focus card with `Back / Open / Next`. No grid, no firehose, no time bar staring back at you.
- **Writes the email for you.** When something needs a reply, Quadri drafts it — and finds the right recipient even when their address lives in a *different* sheet.
- **Attaches the right file.** A pricing question pulls the pricing doc from Drive into the draft, automatically.
- **Schedules and rebalances.** Pick a time and it sends at that minute; when a day gets overloaded, it suggests moves — one at a time, you confirm each.

And one rule underneath all of it: **Quadri proposes, you commit.** It never puts a phantom block on your calendar — a slot exists only because you chose it.

## How we built it

Quadri is a monorepo with two halves that deploy separately and talk over HTTP.

**Frontend — Next.js 16, on Vercel.** The App Router app renders the focus card, the chat dock, and the item modals. It's intentionally thin: it reads from BigQuery and calls the agent, but holds no business logic of its own.

**Agent backend — FastAPI + Google ADK, on Cloud Run.** This is the brain. The Google Agent Development Kit (ADK) defines the agent and its tools — `draft_email`, `draft_signed_doc_email`, `find_drive_attachments`, `schedule_send`, `analyze_workload`, `suggest_rebalance`, `move_slot_to_date`. FastAPI wraps it as a web service and also runs a **background poller** (a 60-second lifespan task) that fires scheduled email sends at the right minute — no Cloud Scheduler or cron needed.

**Data warehouse — BigQuery.** Everything normalizes into one `quadrant_signals` table. Classifier SQL tags Drive-sheet and calendar rows into the four life quadrants; the agent classifies inbox items. This single table is what lets a small agent reason over a messy, multi-source life.

**AI — Vertex AI (Gemini).** The agent runs on `gemini-3-flash-preview` through Vertex AI, used for reasoning, email drafting, and signal classification — with tight structured-output schemas so responses are reliable.

**Ingestion — Fivetran + direct OAuth.** Fivetran is the main data path, syncing Google Calendar and Google Drive (Sheets, Docs, Slides, PDFs) into BigQuery on a schedule. Gmail is read on demand by an LLM inbox-scan — deliberately no stored connector, for privacy.

**Outbound — Gmail & Google Calendar APIs.** Sending email and syncing to Calendar round-trip through the **user's own OAuth** — Quadri never acts from its own identity. `send_email` builds the multipart MIME so auto-attached Drive docs actually ride along.

**Demo mode.** A single flag (`QUADRI_DEMO_MODE`) keeps every BigQuery read/write real while no-oping the outbound network calls — this is what disables Export, Sync, and Send on the public link *(see the note for judges above)*.

## Challenges we ran into

- **Resolving people across sources.** A sheet says "Priya," an email needs `priya@…`. Building reliable cross-sheet name→email resolution — without hallucinating an address — meant grounding every lookup in a second Drive sheet and refusing to send when the match was uncertain.
- **Designing for time blindness.** Our first build had a calendar time bar on the home screen. Testing made it obvious it was a *stressor*, not a feature. Removing it — and making the AI propose-only, never auto-commit to a slot — was the single biggest UX decision.
- **Scheduling without infrastructure.** We wanted real timed sends in a demo with no Cloud Scheduler. A FastAPI lifespan poller stamping `metadata.send_at` turned out to be enough, and far simpler to reason about.
- **Letting judges click without consequences.** Demo mode had to be genuinely safe yet *not* fake — so we sandboxed only the final network hop and kept every BigQuery mutation real.
- **A new Next.js with breaking changes.** The frontend ran on a Next.js build whose conventions diverged from what we knew, which meant reading the bundled docs before writing each surface.

## Accomplishments that we're proud of

- **Multi-source life into one table.** Gmail, Calendar, and Drive — three very different shapes of data — land in a single normalized `quadrant_signals` table that a small agent can actually reason over.
- **Recipient resolution that doesn't hallucinate.** Quadri reads a name in one sheet and finds the email in another, and *refuses to send* when it isn't sure. Grounded, not guessed.
- **Real timed sends with zero extra infrastructure.** A 60-second FastAPI poller delivers scheduled emails at the exact minute — no Cloud Scheduler, no cron, no queue.
- **A demo mode that's safe *and* honest.** Judges can click Send and Sync freely; every BigQuery write is real, only the final outbound network call is sandboxed. Nothing is faked except what leaves the building.
- **A UI defined by what it removes.** No grid, no streaks, no ambient schedule. The "Done today" panel hides itself when empty so a slow day never becomes a shame trigger.
- **Shipped and live.** Frontend on Vercel, agent on Cloud Run, data in BigQuery via Fivetran — a working end-to-end product, not a mockup.

## What we learned

The hardest part of an executive-function tool is **what you refuse to show**. Quiet wins beat streaks; a done panel that *hides itself when empty* removes shame on slow days. AI is most trustworthy when it **proposes and you commit** — the value isn't autonomy, it's removing the cost of deciding while leaving the decision yours. And a clean data path matters: funneling Calendar and Drive through Fivetran into one normalized `quadrant_signals` table is what let a small agent reason over a messy multi-source life.

## What's next

Closing the loop on notes. Today every note you jot auto-exports to a CSV you own; next:

- **Notes sync to Drive**, automatically, alongside the sheets they came from.
- **Notes update task status** — *"sent the contract, waiting on Priya"* marks the task in-progress on its own.
- **Notes spin up new tasks** — *"follow up with the vendor next week"* becomes a classified task, no typing into a form.

From **capture** to **action** — so the one thing you do leaves a trail that does the next thing for you.
