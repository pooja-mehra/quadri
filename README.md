# Quadri

> An ADHD-first executive-function copilot. Reads your inbox, calendar,
> and Drive sheets; surfaces one thing to focus on; drafts the emails
> you'd rather not write.

Quadri is a multi-source AI agent that helps people with executive-function
challenges get from "I have 30 emails, 12 tasks, and don't know where to start"
to "I'm doing one thing." Built for the Google Cloud Agent Hackathon (2026).

---

## What it does

1. **Reads multi-source signals** — Gmail (inbox-scan via LLM), Google
   Calendar (Fivetran → BigQuery), Google Drive sheets and docs (Fivetran
   + direct API). Every row becomes a `quadrant_signals` record tagged with
   one of four life quadrants: career, health, education, relationships.
2. **Drafts the right reply, automatically** — when an email needs a
   response, Quadri uses the `draft_email` tool to compose one. When a
   Drive sheet row marks something *fixed* or *in progress*, Quadri
   drafts the follow-up email to the right person — including
   cross-sheet name → email resolution (e.g. a project tracker row says
   *"Priya waiting on decision"* → Quadri finds Priya's address in the
   beta feedback sheet and writes to her).
3. **Auto-attaches Drive docs** — if the email is a pricing inquiry or
   estimate, the relevant policy doc from Drive lands in
   `metadata.attachments` automatically via `find_drive_attachments`.
4. **One-thing-at-a-time UI** — no quadrant grid, no overwhelming list.
   A single focus card with `Back / Open / Next`, an `Up Next` peek of
   three items, and a collapsible `Later` lane. Time bar is gone (time
   blindness makes scheduled slots a shame trigger for ADHD).
5. **Scheduling that actually fires** — pick a time in the modal, the
   item lands on the calendar strip AND a FastAPI background poller
   fires the Gmail send at the chosen time.
6. **Calendar round-trip** — sync any scheduled item to Google Calendar
   with one click; remove from calendar deletes it both in BigQuery
   and on Google's side.
7. **Quiet wins, not streaks** — Done celebrations are small. The
   "Done today" panel hides itself when empty (no shame for slow days)
   and shows a strikethrough recap when there's something to celebrate.
   Notes per item auto-append to `~/Documents/quadri-notes.csv`.

---

## Repo layout

```
.
├── quadrant-ui/          Next.js 15 frontend (the user-facing app)
│   ├── src/app/          App Router pages + API routes
│   ├── src/components/   FocusCard, CalendarStrip, ItemDetailModal, ChatDock, …
│   └── src/lib/          BigQuery client, OAuth, demo-mode flag, helpers
│
├── quadrant/             FastAPI agent backend (the brain)
│   ├── app/
│   │   ├── agent.py          ADK agent definition + every tool
│   │   ├── fast_api_app.py   ADK web app + background poller for due sends
│   │   ├── plan_today.py     Daily plan generator
│   │   └── drive_ingest.py   Drive Docs/PDFs/Slides → BigQuery
│   └── sql/              BigQuery DDL + classifier SQL files
│
├── *.md                  Design docs (architecture, decisions, demo prep)
├── LICENSE               MIT
└── README.md             This file
```

The repo is a monorepo. The UI deploys to Vercel (root: `quadrant-ui/`).
The agent backend deploys to Cloud Run (root: `quadrant/`).
Neither knows about the other's path; they communicate via HTTP.

---

## Architecture

```
   Google Drive ──┐         Gmail ──┐         Google Calendar ──┐
                  │                 │                            │
                  ▼                 ▼                            ▼
              Fivetran  +  Direct OAuth                      Fivetran
                  │                 │                            │
                  └───────► BigQuery ◄──────────────────────────┘
                          (quadrant.*)
                                │
            ┌───────────────────┼────────────────────┐
            ▼                                        ▼
     classifier SQL                              FastAPI / ADK
     (sheets, calendar)                          (agent.py tools)
            │                                        │
            ▼                                        ▼
       quadrant_signals  ◄──────── plan_today ◄── /api/plan/today
                                                      │
                                                      ▼
                                             Next.js (Vercel)
                                                      │
                                                      ▼
                                                   User
```

Outbound effects (Gmail send, Google Calendar sync) round-trip through
the user's own OAuth — Quadri never sends from its own identity. In
deployed demo mode (`QUADRI_DEMO_MODE=true`), all outbound writes are
no-oped so judges can click freely without test emails leaving the
deployment.

---

## Running locally

You need: Python 3.13, Node 20+, a GCP project with BigQuery enabled,
and a service account with BigQuery + (optionally) Drive/Gmail scopes.

```bash
# Backend (FastAPI + ADK agent)
cd quadrant
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in GCP_PROJECT, GOOGLE_GENAI_API_KEY, etc.
make local-backend     # uvicorn on :8000 with --reload

# Frontend (Next.js)
cd ../quadrant-ui
npm install
cp .env.example .env.local   # fill in GCP_PROJECT, AGENT_BACKEND_URL, etc.
npm run dev                   # localhost:3000
```

Open `http://localhost:3000`. The chat dock will prompt you to connect
Google on first run (live mode only — demo mode skips this).

---

## Demo mode

When `QUADRI_DEMO_MODE=true` (and `NEXT_PUBLIC_QUADRI_DEMO_MODE=true`):

- OAuth status returns `authorized=true, onboarded=true` — no Connect
  Google dance for visiting judges
- `/api/gmail/send` no-ops with `{ok: true, demo: true}`
- `/api/calendar/sync-today` no-ops with a synthetic count
- Google Calendar deletes in `/api/slots/remove` are skipped
- Local CSV note mirror is skipped (read-only filesystem in hosted
  deployments)
- Header shows an amber **Demo** pill

Every BigQuery read/write still happens, so judges see the actual
product behavior — modal Send → marks the action sent → Done-today
panel reflects it. Nothing is faked except the outbound network call.

---

## License

MIT. See [LICENSE](./LICENSE).
