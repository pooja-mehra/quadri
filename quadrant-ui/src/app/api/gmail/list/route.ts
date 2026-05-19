import { NextResponse } from "next/server";
import { getAccessToken } from "@/lib/google-oauth";

export const dynamic = "force-dynamic";

// List recent Gmail messages for the connected account, optionally
// filtered by category. Returns lightweight metadata only — full body
// fetch is a future enhancement (will need text/html parsing).
//
// Query params:
//   category=promotions|social|updates|forums|personal|professional|family
//   max=20  (default 20, cap 50)
//   q=...   (raw Gmail search query, takes precedence over category)
//
// Categorization strategy: Gmail's own CATEGORY_* labels cover
// promo/social/updates/forums/personal. "Professional" and "Family" are
// user-defined labels — the user creates them in Gmail UI and we just
// match by label name.

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const CATEGORY_TO_LABEL: Record<string, string> = {
  promotions: "CATEGORY_PROMOTIONS",
  social: "CATEGORY_SOCIAL",
  updates: "CATEGORY_UPDATES",
  forums: "CATEGORY_FORUMS",
  personal: "CATEGORY_PERSONAL",
};

// User-defined labels resolved at request time. Gmail's label IDs for
// user-created labels look like "Label_1234"; we look them up by name.
const USER_LABEL_NAMES: Record<string, string> = {
  professional: "Professional",
  family: "Family",
  friends: "Friends",
};

// Walk a Gmail payload MIME tree; return decoded plain text body
// (preferred) or stripped HTML. Caps result at 8 KB so the LLM
// doesn't choke on a 200-page newsletter.
type GmailPart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};
function decodeBase64Url(b64: string): string {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(padded, "base64").toString("utf-8");
  } catch {
    return "";
  }
}
function extractBody(payload: GmailPart | undefined): string {
  if (!payload) return "";
  // Prefer text/plain found anywhere in the tree.
  const stack: GmailPart[] = [payload];
  let plain = "";
  let html = "";
  while (stack.length) {
    const p = stack.pop()!;
    if (p.parts) stack.push(...p.parts);
    const data = p.body?.data;
    if (!data) continue;
    if (p.mimeType === "text/plain" && !plain) plain = decodeBase64Url(data);
    else if (p.mimeType === "text/html" && !html) html = decodeBase64Url(data);
  }
  let body = plain || html;
  // Strip HTML tags and collapse whitespace if we fell back to html.
  if (!plain && html) {
    body = body
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }
  return body.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 8000);
}

async function gmailApi(
  accessToken: string,
  path: string,
): Promise<{ ok: boolean; status: number; data: any }> {
  const r = await fetch(`${GMAIL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

export async function GET(request: Request) {
  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "unauthorized",
        authorize_url: "/api/auth/google",
      },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const category = url.searchParams.get("category")?.toLowerCase() ?? "";
  const rawQuery = url.searchParams.get("q") ?? "";
  const maxParam = Number(url.searchParams.get("max") ?? "20");
  const max = Math.min(Math.max(Number.isFinite(maxParam) ? maxParam : 20, 1), 50);
  const includeBody = url.searchParams.get("include_body") === "true";

  // Build the list query.
  const listParams = new URLSearchParams({ maxResults: String(max) });
  if (rawQuery) {
    listParams.set("q", rawQuery);
  } else if (category === "primary") {
    // Inclusive "real inbox" — drops marketing and social chatter but
    // keeps business updates (receipts, inquiries, bookings) and
    // forums/mailing lists. Pure Gmail `category:primary` is too
    // narrow when tabs are disabled or the user's inbox is sparse.
    listParams.set(
      "q",
      "in:inbox -category:promotions -category:social -in:spam",
    );
  } else if (CATEGORY_TO_LABEL[category]) {
    listParams.append("labelIds", CATEGORY_TO_LABEL[category]);
  } else if (USER_LABEL_NAMES[category]) {
    // Resolve user-defined label name → id once.
    const labels = await gmailApi(accessToken, "/labels");
    if (!labels.ok) {
      return NextResponse.json(
        { error: `labels lookup failed: ${labels.status}` },
        { status: 500 },
      );
    }
    const target = USER_LABEL_NAMES[category].toLowerCase();
    const match = (labels.data.labels ?? []).find(
      (l: { name?: string }) =>
        typeof l.name === "string" && l.name.toLowerCase() === target,
    );
    if (!match) {
      return NextResponse.json({ messages: [], note: `label '${USER_LABEL_NAMES[category]}' not found in Gmail` });
    }
    listParams.append("labelIds", (match as { id: string }).id);
  } else if (category) {
    return NextResponse.json(
      { error: `unknown category '${category}'` },
      { status: 400 },
    );
  }

  const listRes = await gmailApi(
    accessToken,
    `/messages?${listParams.toString()}`,
  );
  if (!listRes.ok) {
    return NextResponse.json(
      { error: `list failed: ${listRes.status}`, data: listRes.data },
      { status: 500 },
    );
  }

  const ids: string[] = (listRes.data.messages ?? []).map(
    (m: { id: string }) => m.id,
  );

  // Fetch each message in parallel. Metadata-only by default; full
  // body if the caller asks for it (Quadri's inbox scan needs the body
  // to extract action items + deadlines).
  const fmt = includeBody ? "full" : "metadata";
  const metaHdrs = includeBody
    ? ""
    : "&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date";
  const messages = await Promise.all(
    ids.map(async (id) => {
      const r = await gmailApi(
        accessToken,
        `/messages/${id}?format=${fmt}${metaHdrs}`,
      );
      if (!r.ok) return null;
      const headers: Record<string, string> = {};
      for (const h of r.data.payload?.headers ?? []) {
        if (h?.name) headers[h.name.toLowerCase()] = h.value ?? "";
      }
      const base = {
        id: r.data.id,
        thread_id: r.data.threadId,
        from: headers.from ?? "",
        to: headers.to ?? "",
        subject: headers.subject ?? "",
        date: headers.date ?? "",
        internal_date: r.data.internalDate ? Number(r.data.internalDate) : null,
        snippet: r.data.snippet ?? "",
        label_ids: r.data.labelIds ?? [],
      };
      if (!includeBody) return base;
      // Walk MIME tree to find text/plain (preferred) or text/html.
      const body = extractBody(r.data.payload);
      return { ...base, body };
    }),
  );

  return NextResponse.json({
    messages: messages.filter((m): m is NonNullable<typeof m> => m !== null),
  });
}
