import { NextResponse } from "next/server";
import {
  exchangeCodeForTokens,
  fetchUserInfoEmail,
  saveRefreshToken,
} from "@/lib/google-oauth";

export const dynamic = "force-dynamic";

// Receives the OAuth `code` after the user consents, exchanges it for
// tokens, stores the refresh_token in BigQuery, and redirects back to
// wherever the user came from (encoded in `state`).

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(
      new URL(`/?google_auth=error&reason=${encodeURIComponent(error)}`, url.origin),
    );
  }
  if (!code) {
    return NextResponse.redirect(new URL("/?google_auth=missing_code", url.origin));
  }

  let returnTo = "/";
  if (state) {
    try {
      const decoded = JSON.parse(
        Buffer.from(state, "base64url").toString("utf8"),
      ) as { return_to?: string };
      if (decoded.return_to) returnTo = decoded.return_to;
    } catch {
      // Bad state — fall back to /.
    }
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      // Refresh token only comes back on FIRST consent (or with
      // prompt=consent which we always pass). If it's missing, the
      // user already authorized once and Google reused the prior token
      // without re-issuing. Tell them to revoke + re-authorize.
      return NextResponse.redirect(
        new URL(
          "/?google_auth=no_refresh_token",
          url.origin,
        ),
      );
    }
    // Pull the connected account's email so the scheduled-send poller
    // can deliver lead-time previews without an env var. Best-effort:
    // a failure here doesn't block storing the refresh token.
    const email = tokens.access_token
      ? await fetchUserInfoEmail(tokens.access_token)
      : null;
    await saveRefreshToken(tokens.refresh_token, tokens.scope, email);
  } catch (e) {
    return NextResponse.redirect(
      new URL(
        `/?google_auth=exchange_failed&msg=${encodeURIComponent(
          e instanceof Error ? e.message : "unknown",
        )}`,
        url.origin,
      ),
    );
  }
  return NextResponse.redirect(new URL(`${returnTo}?google_auth=ok`, url.origin));
}
