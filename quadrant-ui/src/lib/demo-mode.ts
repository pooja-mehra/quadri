// Demo mode — single env-var switch that judges hit a hosted URL
// without OAuth, and whose Send/Sync clicks don't pump real Gmail
// messages to test addresses. Enabled by `QUADRI_DEMO_MODE=true` on
// the deployment (Vercel project setting, Cloud Run env var).
//
// What demo mode changes:
//   - /api/auth/google/status returns authorized=true / onboarded=true
//     so the chat dock skips the "Connect Google" CTA
//   - /api/gmail/send no-ops with {ok: true, demo: true}
//   - /api/calendar/sync-today no-ops with {ok: true, demo: true}
//   - /api/slots/remove still deletes the BQ row but skips the
//     Google Calendar DELETE (no token, nothing to delete)
//   - local-csv-log skips the filesystem write (Vercel/Cloud Run
//     fs is read-only anyway; this just suppresses log noise)
//
// BigQuery reads/writes are NOT short-circuited — modals show real
// drafts, marking sent updates the action row, the done-today panel
// fills out, the calendar strip reflects scheduled items. Judges
// see the actual product behavior end-to-end; just no outbound
// effects leave the deployment.

// Works on both server and client. Deployment should set BOTH:
//   QUADRI_DEMO_MODE=true             (server-only, for API routes)
//   NEXT_PUBLIC_QUADRI_DEMO_MODE=true (inlined at build, client UI)
// The NEXT_PUBLIC_ variant is the only one Next.js will expose to
// the browser bundle.
export function isDemoMode(): boolean {
  return (
    process.env.QUADRI_DEMO_MODE === "true" ||
    process.env.NEXT_PUBLIC_QUADRI_DEMO_MODE === "true"
  );
}
