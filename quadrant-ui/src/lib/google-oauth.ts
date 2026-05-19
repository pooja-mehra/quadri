// Google OAuth helpers — minimal raw-fetch wrapper around Google's token
// endpoints + Calendar API. We avoid the official `googleapis` package
// to keep the bundle slim; the flow is only ~3 calls (authorize URL,
// code exchange, refresh).
//
// Tokens live in BigQuery (quadrant.user_credentials, keyed by user_id +
// provider='google'). Access tokens are short-lived (~1h) so we fetch a
// fresh one on every server-side request that needs Calendar API access.

import { bq, fqn, USER_ID } from "./bq";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  // Gmail: read messages + labels (categorization), send new messages.
  // gmail.send is restricted to the send action — it can't read back.
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  // Drive read-only: needed so /api/gmail/send can fetch Drive files
  // selected as attachments (see find_drive_attachments / draft_email
  // attachments flow). Read-only is sufficient — we never modify the
  // user's Drive content.
  "https://www.googleapis.com/auth/drive.readonly",
  // openid + email so Google returns a refresh_token reliably on the
  // first authorization. Without prompt=consent, repeat authorizations
  // sometimes omit the refresh_token.
  "openid",
  "email",
].join(" ");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    redirect_uri: requireEnv("GOOGLE_OAUTH_REDIRECT_URI"),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
};

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    redirect_uri: requireEnv("GOOGLE_OAUTH_REDIRECT_URI"),
    grant_type: "authorization_code",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Token exchange failed: ${r.status} ${text}`);
  }
  return (await r.json()) as TokenResponse;
}

// Thrown when Google rejects the refresh token (user revoked the app,
// token expired without use, etc.). Callers can catch this and treat
// the user as disconnected.
export class RefreshTokenInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefreshTokenInvalidError";
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    // Google returns 400 invalid_grant when the refresh token is no
    // longer valid (user revoked at myaccount/permissions, token aged
    // out, scope changes etc). Surface as a distinct error so the
    // caller can purge the stored credential.
    if (r.status === 400 && /invalid_grant/.test(text)) {
      throw new RefreshTokenInvalidError(`invalid_grant: ${text}`);
    }
    throw new Error(`Refresh failed: ${r.status} ${text}`);
  }
  const data = (await r.json()) as TokenResponse;
  return data.access_token;
}

export async function deleteRefreshToken(): Promise<void> {
  await bq.query({
    query: `
      DELETE FROM ${fqn("user_credentials")}
      WHERE user_id = @uid AND provider = 'google'
    `,
    params: { uid: USER_ID },
  });
}

// Fetches the connected account's email via Google's userinfo endpoint.
// Requires the `email` scope (already in SCOPES). Best-effort: returns
// null on any failure so the caller can persist the refresh token even
// if userinfo lookup hiccups.
export async function fetchUserInfoEmail(accessToken: string): Promise<string | null> {
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { email?: string };
    return typeof data.email === "string" && data.email ? data.email : null;
  } catch {
    return null;
  }
}

export async function saveRefreshToken(
  refreshToken: string,
  scope?: string,
  email?: string | null,
): Promise<void> {
  // MERGE upsert on (user_id, provider). One refresh token per provider
  // per user; re-authorizing overwrites. Email comes from userinfo at
  // callback time so the scheduled-send poller can deliver lead-time
  // previews without an explicit USER_NOTIFY_EMAIL env var.
  await bq.query({
    query: `
      MERGE ${fqn("user_credentials")} T
      USING (
        SELECT @uid AS user_id, 'google' AS provider, @rt AS refresh_token,
               @scope AS scope, @email AS email, CURRENT_TIMESTAMP() AS now
      ) S
      ON T.user_id = S.user_id AND T.provider = S.provider
      WHEN MATCHED THEN UPDATE SET
        refresh_token = S.refresh_token,
        scope = S.scope,
        email = S.email,
        updated_at = S.now
      WHEN NOT MATCHED THEN
        INSERT (user_id, provider, refresh_token, scope, email, granted_at, updated_at)
        VALUES (S.user_id, S.provider, S.refresh_token, S.scope, S.email, S.now, S.now)
    `,
    params: {
      uid: USER_ID,
      rt: refreshToken,
      scope: scope ?? null,
      email: email ?? null,
    },
  });
}

export async function readRefreshToken(): Promise<string | null> {
  const [rows] = await bq.query({
    query: `
      SELECT refresh_token
      FROM ${fqn("user_credentials")}
      WHERE user_id = @uid AND provider = 'google'
      LIMIT 1
    `,
    params: { uid: USER_ID },
  });
  if (rows.length === 0) return null;
  const r = rows[0] as { refresh_token: string };
  return r.refresh_token ?? null;
}

// Cheap existence check — used as a precondition before attempting
// any token refresh. Doesn't validate the token actually works.
export async function hasStoredRefreshToken(): Promise<boolean> {
  return (await readRefreshToken()) !== null;
}

// Real authorization check: tries to refresh. If Google rejects the
// token as invalid (revoked / expired), the dead row is deleted so
// future calls see "not authorized" cleanly.
export async function isAuthorized(): Promise<boolean> {
  const rt = await readRefreshToken();
  if (!rt) return false;
  try {
    await refreshAccessToken(rt);
    return true;
  } catch (e) {
    if (e instanceof RefreshTokenInvalidError) {
      await deleteRefreshToken();
      return false;
    }
    // Network error or transient — don't nuke the row, just report
    // not-authorized for this check. Next call will retry.
    return false;
  }
}

// Returns a fresh access token. Throws if no refresh token is stored.
export async function getAccessToken(): Promise<string> {
  const rt = await readRefreshToken();
  if (!rt) throw new Error("Not authorized — visit /api/auth/google first.");
  try {
    return await refreshAccessToken(rt);
  } catch (e) {
    if (e instanceof RefreshTokenInvalidError) {
      // Revoked or expired — purge the dead row so the user sees the
      // Connect prompt instead of repeated silent failures.
      await deleteRefreshToken();
      throw new Error("Not authorized — visit /api/auth/google first.");
    }
    throw e;
  }
}
