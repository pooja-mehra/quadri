import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";
import { isAuthorized } from "@/lib/google-oauth";
import { isDemoMode } from "@/lib/demo-mode";

export const dynamic = "force-dynamic";

// Returns Google auth status plus onboarding completion. The frontend
// uses these together to decide what to fire on app load:
//   - !authorized                  → show Connect button, no scan
//   - authorized + !onboarded      → fire [internal:onboarding-start]
//   - authorized + onboarded       → fire [internal:inbox-scan]
export async function GET() {
  // Demo mode: short-circuit to "fully wired" so judges don't see a
  // Connect Google CTA they can't satisfy. BQ already has demo_user's
  // data; we're just claiming the OAuth handshake is already done.
  if (isDemoMode()) {
    return NextResponse.json({
      authorized: true,
      onboarding_completed: true,
      demo: true,
    });
  }
  try {
    const authorized = await isAuthorized();
    let onboardingCompleted = false;
    try {
      const [rows] = await bq.query({
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
      });
      onboardingCompleted = Boolean(rows[0]?.completed);
    } catch {
      // user_settings row may not exist yet — treat as not onboarded.
      onboardingCompleted = false;
    }
    return NextResponse.json({
      authorized,
      onboarding_completed: onboardingCompleted,
    });
  } catch (e) {
    return NextResponse.json(
      { authorized: false, onboarding_completed: false, error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}
