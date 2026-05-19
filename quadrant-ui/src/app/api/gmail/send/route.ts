import { NextResponse } from "next/server";
import { getAccessToken } from "@/lib/google-oauth";
import { isDemoMode } from "@/lib/demo-mode";

export const dynamic = "force-dynamic";

// Send an email from the connected Gmail account.
// POST body: { to, subject, body, cc?, bcc?, html?, attachment_file_ids? }
//
// If attachment_file_ids is non-empty, downloads each file from Drive
// (Google Docs export to PDF; everything else as the file's native
// content) and builds a multipart/mixed MIME message. Otherwise builds
// the simple single-part RFC-2822 message it always has.

const SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const DRIVE_FILES_API = "https://www.googleapis.com/drive/v3/files";

type SendBody = {
  to?: unknown;
  subject?: unknown;
  body?: unknown;
  cc?: unknown;
  bcc?: unknown;
  html?: unknown;
  attachment_file_ids?: unknown;
};

type DriveFileMeta = {
  id: string;
  name: string;
  mimeType: string;
};

type FetchedAttachment = {
  filename: string;
  mimeType: string;
  base64Body: string;
};

// Google-native types (Docs/Sheets/Slides) can't be downloaded raw —
// they have to be EXPORTED. Pick a reasonable mime for each. Everything
// else falls through to the alt=media path.
const NATIVE_EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document":
    "application/pdf",
  "application/vnd.google-apps.spreadsheet":
    "application/pdf",
  "application/vnd.google-apps.presentation":
    "application/pdf",
};

function toBase64Url(s: string): string {
  return Buffer.from(s, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function bufferToBase64Standard(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString("base64");
}

// Break a base64 string into 76-char lines (RFC 2045 requirement for
// content-transfer-encoding: base64). Gmail accepts shorter, but some
// receiving MTAs reject lines >998 chars, so wrap properly.
function wrapBase64(b64: string): string {
  return b64.match(/.{1,76}/g)?.join("\r\n") ?? b64;
}

async function fetchDriveAttachment(
  accessToken: string,
  fileId: string,
): Promise<FetchedAttachment | null> {
  // 1. Metadata — need the name + mimeType to decide raw vs export.
  const metaResp = await fetch(
    `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}?fields=id,name,mimeType`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!metaResp.ok) return null;
  const meta = (await metaResp.json()) as DriveFileMeta;

  const exportMime = NATIVE_EXPORT_MIME[meta.mimeType];
  let downloadUrl: string;
  let outMime: string;
  let outName: string;
  if (exportMime) {
    downloadUrl = `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`;
    outMime = exportMime;
    // Append a .pdf extension if exporting a native type to PDF and the
    // current name doesn't already carry one.
    outName = /\.[a-z0-9]+$/i.test(meta.name) ? meta.name : `${meta.name}.pdf`;
  } else {
    downloadUrl = `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}?alt=media`;
    outMime = meta.mimeType || "application/octet-stream";
    outName = meta.name;
  }

  const fileResp = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!fileResp.ok) return null;
  const buf = await fileResp.arrayBuffer();
  return {
    filename: outName,
    mimeType: outMime,
    base64Body: bufferToBase64Standard(buf),
  };
}

function buildSimpleRfc2822(args: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  html?: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`To: ${args.to}`);
  if (args.cc) lines.push(`Cc: ${args.cc}`);
  if (args.bcc) lines.push(`Bcc: ${args.bcc}`);
  const subjectIsAscii = /^[\x20-\x7E]*$/.test(args.subject);
  const subject = subjectIsAscii
    ? args.subject
    : `=?UTF-8?B?${Buffer.from(args.subject, "utf-8").toString("base64")}?=`;
  lines.push(`Subject: ${subject}`);
  lines.push("MIME-Version: 1.0");
  lines.push(
    `Content-Type: ${args.html ? "text/html" : "text/plain"}; charset=UTF-8`,
  );
  lines.push("Content-Transfer-Encoding: 8bit");
  lines.push("");
  lines.push(args.body);
  return lines.join("\r\n");
}

function buildMultipartRfc2822(args: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  html?: boolean;
  attachments: FetchedAttachment[];
}): string {
  const boundary = `=_quadri_${Math.random().toString(36).slice(2, 12)}`;
  const lines: string[] = [];
  lines.push(`To: ${args.to}`);
  if (args.cc) lines.push(`Cc: ${args.cc}`);
  if (args.bcc) lines.push(`Bcc: ${args.bcc}`);
  const subjectIsAscii = /^[\x20-\x7E]*$/.test(args.subject);
  const subject = subjectIsAscii
    ? args.subject
    : `=?UTF-8?B?${Buffer.from(args.subject, "utf-8").toString("base64")}?=`;
  lines.push(`Subject: ${subject}`);
  lines.push("MIME-Version: 1.0");
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push("");
  // Body part.
  lines.push(`--${boundary}`);
  lines.push(
    `Content-Type: ${args.html ? "text/html" : "text/plain"}; charset=UTF-8`,
  );
  lines.push("Content-Transfer-Encoding: 8bit");
  lines.push("");
  lines.push(args.body);
  // Each attachment part.
  for (const a of args.attachments) {
    lines.push(`--${boundary}`);
    // Filename — RFC-2047 encode if non-ASCII.
    const nameIsAscii = /^[\x20-\x7E]*$/.test(a.filename);
    const filename = nameIsAscii
      ? a.filename
      : `=?UTF-8?B?${Buffer.from(a.filename, "utf-8").toString("base64")}?=`;
    lines.push(`Content-Type: ${a.mimeType}; name="${filename}"`);
    lines.push("Content-Transfer-Encoding: base64");
    lines.push(`Content-Disposition: attachment; filename="${filename}"`);
    lines.push("");
    lines.push(wrapBase64(a.base64Body));
  }
  lines.push(`--${boundary}--`);
  return lines.join("\r\n");
}

export async function POST(request: Request) {
  // Demo mode: don't actually fire Gmail. Return success so the
  // upstream caller (modal Send button, FastAPI poller) marks the
  // action sent and the Done celebration / Done-today panel still
  // flow correctly. No real message leaves the deployment.
  if (isDemoMode()) {
    return NextResponse.json({
      ok: true,
      demo: true,
      // Fake an id so any logging on the caller still has a string.
      messageId: `demo-${Date.now().toString(36)}`,
    });
  }
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

  let body: SendBody;
  try {
    body = (await request.json()) as SendBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const to = typeof body.to === "string" ? body.to.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject : "";
  const text = typeof body.body === "string" ? body.body : "";
  const cc = typeof body.cc === "string" ? body.cc.trim() : undefined;
  const bcc = typeof body.bcc === "string" ? body.bcc.trim() : undefined;
  const html = typeof body.html === "boolean" ? body.html : false;
  const attachmentFileIds = Array.isArray(body.attachment_file_ids)
    ? (body.attachment_file_ids as unknown[])
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];

  if (!to) {
    return NextResponse.json({ error: "'to' is required" }, { status: 400 });
  }
  if (!subject && !text) {
    return NextResponse.json(
      { error: "'subject' and/or 'body' must be non-empty" },
      { status: 400 },
    );
  }

  // Fetch attachments (in parallel) if any. Missing files don't fail the
  // whole send — Quadri may have stale references; surface them in the
  // response so the caller can flag the user.
  const fetched: FetchedAttachment[] = [];
  const failedAttachmentIds: string[] = [];
  if (attachmentFileIds.length > 0) {
    const results = await Promise.all(
      attachmentFileIds.map((id) => fetchDriveAttachment(accessToken, id)),
    );
    results.forEach((r, idx) => {
      if (r) fetched.push(r);
      else failedAttachmentIds.push(attachmentFileIds[idx]);
    });
  }

  const rfc =
    fetched.length > 0
      ? buildMultipartRfc2822({
          to,
          subject,
          body: text,
          cc,
          bcc,
          html,
          attachments: fetched,
        })
      : buildSimpleRfc2822({ to, subject, body: text, cc, bcc, html });
  const raw = toBase64Url(rfc);

  const r = await fetch(SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    return NextResponse.json(
      { error: `send failed: ${r.status}`, data },
      { status: r.status },
    );
  }
  return NextResponse.json({
    ok: true,
    id: data?.id ?? null,
    thread_id: data?.threadId ?? null,
    label_ids: data?.labelIds ?? [],
    attachments_sent: fetched.length,
    attachments_failed: failedAttachmentIds,
  });
}
