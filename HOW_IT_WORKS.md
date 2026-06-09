# How Quadri Works

A beat-by-beat walkthrough of the product, written so it doubles as the
demo script. Each numbered beat below maps to one demo moment — the
**Caption** line is short enough to drop straight onto a slide in place
of voiceover.

> For the *what* and the system diagram, see the [README](../README.md).
> This doc is the *how the story unfolds* version.

---

## The problem, in one line

Executive-function overload: 30 emails, 12 tasks, a full calendar, and no
idea where to start. The cost isn't the work — it's the *deciding*.

**Caption:** *"Too much input, no entry point. Quadri picks the one next thing."*

---

## Beat 1 — Multi-source ingestion

Quadri reads three Google sources and normalizes everything into one
`quadrant_signals` table in BigQuery:

- **Google Calendar** → Fivetran → BigQuery
- **Google Drive** (Sheets, Docs, Slides, PDFs) → Fivetran + direct API
- **Gmail** → LLM inbox-scan (no connector — privacy by design)

Every row is tagged with one of four life quadrants: **career, health,
education, relationships**. Classifier SQL does the tagging for sheets and
calendar; the agent does it for inbox items.

**Caption:** *"Calendar, Drive, and inbox → one normalized signal table in BigQuery."*

---

## Beat 2 — One thing at a time

The UI deliberately throws away the quadrant grid and the long list. What
the user sees is a single **focus card**: one item, with `Back / Open /
Next`. Below it, an `Up Next` peek of just three items, and a collapsible
`Later` lane.

There is **no time bar** on the main view — for ADHD users, scheduled
slots staring back at you are a shame trigger, so they're opt-in, not
ambient.

**Caption:** *"No grid, no firehose. One focus card. `Back / Open / Next`."*

---

## Beat 3 — Quadri drafts the reply for you

When a signal needs a response, the agent composes it — the user never
faces a blank compose window:

- `draft_email` writes the reply for an inbox item.
- `draft_signed_doc_email` handles the contract send-back flow.
- **Cross-sheet name → email resolution:** a tracker row says *"Priya
  waiting on decision"*; Quadri looks up Priya's address in a *different*
  sheet (beta feedback) and addresses the email correctly.

**Caption:** *"Quadri writes the email you were dreading — and finds the recipient across sheets."*

---

## Beat 4 — Auto-attached Drive docs

If a draft is a pricing inquiry or estimate, `find_drive_attachments`
pulls the relevant policy/pricing doc from Drive and lands it in
`metadata.attachments` automatically. `send_email` then builds the
multipart MIME so the attachment actually rides along.

**Caption:** *"Pricing question? The right Drive doc attaches itself."*

---

## Beat 5 — Scheduling that actually fires

Pick a time in the item modal and two things happen:

1. The item appears on the calendar strip.
2. `schedule_send` stamps `metadata.send_at`, and a **FastAPI background
   poller** (60s tick, lifespan-managed) fires the Gmail send at the
   chosen minute. No Cloud Scheduler needed.

Sending is **chat-only and preference-gated** — the time bar shows drafts
read-only; the actual send goes through Quadri, gated by send-window /
lead-time / priority preferences. The AI never auto-commits you to a slot;
only an explicit user action does.

**Caption:** *"Schedule a send; a background poller fires it at the minute you chose."*

---

## Beat 6 — Calendar round-trip

One click syncs a scheduled item to Google Calendar. Removing it deletes
the event in **both** BigQuery and on Google's side — no orphans. Moves
are atomic remove-add; nothing is duplicated.

**Caption:** *"Sync to Google Calendar both ways — add, move, and delete stay in lockstep."*

---

## Beat 7 — Workload breathing room

`analyze_workload` and `suggest_rebalance` look across the next 7 days
against a capacity model (weekday 8h, weekend 4h). When a day is
overloaded, Quadri proposes moving specific items — `move_slot_to_date` —
**one at a time, each user-confirmed.** No silent bulk reshuffles.

**Caption:** *"Overloaded day? Quadri proposes moves — one at a time, you confirm each."*

---

## Beat 8 — Quiet wins, no streaks

Done celebrations are intentionally small. The "Done today" panel **hides
itself when empty** (no shame on slow days) and shows a strikethrough
recap when there's something to celebrate. Notes per item append to a
local CSV. Done items are terminal — they drop from the list, Today, and
the ranker; "Done This Week" is a rolling 7-day window.

**Caption:** *"Celebrate quietly. The done panel disappears when there's nothing to show — no streaks, no shame."*

---

## The trust model (worth a slide)

- Outbound effects (Gmail send, Calendar sync) round-trip through the
  **user's own OAuth** — Quadri never sends from its own identity.
- After connecting, Quadri **describes its scope and asks before any
  read** — connect ≠ fetch.
- In deployed **demo mode** (`QUADRI_DEMO_MODE=true`), every BigQuery
  read/write still happens, but outbound network calls (Gmail send,
  Calendar writes) are no-oped — judges click freely, nothing leaves the
  deployment. A header **Demo** pill makes the mode visible.

**Caption:** *"Acts as you, not instead of you — your OAuth out, nothing sent from Quadri's identity. Demo mode sandboxes every outbound call."*

---

## Stack at a glance

| Layer | Tech |
|-------|------|
| Frontend | Next.js 16 (App Router), deployed to Vercel |
| Agent backend | FastAPI + Google ADK, deployed to Cloud Run |
| Data warehouse | BigQuery (`quadrant.*`) |
| Ingestion | Fivetran (Calendar + Drive) + direct OAuth |
| Outbound | Gmail API + Google Calendar API via user OAuth |

The two halves are a monorepo but deploy independently and talk over HTTP
— neither knows the other's path.

**Caption:** *"Next.js on Vercel · ADK agent on Cloud Run · BigQuery + Fivetran · Gmail/Calendar out."*
