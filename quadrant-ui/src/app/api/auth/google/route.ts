import { NextResponse } from "next/server";
import { buildAuthorizeUrl } from "@/lib/google-oauth";

export const dynamic = "force-dynamic";

// Initiates the Google OAuth flow. The browser hits this route, we
// redirect to Google's consent screen, Google calls our callback with a
// `code`, and that callback exchanges the code for tokens.
//
// `state` is a CSRF token, encoded into the URL. We just use a random
// string for the demo; in production it would be signed and bound to a
// session cookie.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("return_to") ?? "/";
  // Pack the return-to URL into state so the callback can redirect us
  // back to where the user was when they clicked "Sync".
  const state = Buffer.from(
    JSON.stringify({ nonce: crypto.randomUUID(), return_to: returnTo }),
  ).toString("base64url");
  return NextResponse.redirect(buildAuthorizeUrl(state));
}
