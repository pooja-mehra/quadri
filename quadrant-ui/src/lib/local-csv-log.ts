// Auto-append a row to the user's local notes CSV file on every
// Done. Backend (Next.js) is running locally on the user's machine
// for this demo so it can write directly to disk — no Drive OAuth,
// no permission prompts, plain file the user opens in Excel/Sheets.
//
// File location:
//   - Default: ~/Documents/quadri-notes.csv
//   - Overridable via env var QUADRI_NOTES_FILE (absolute path).
// First write creates the file with a header row. Subsequent writes
// append one row. Best-effort — failures are swallowed so a missing
// permission or read-only filesystem doesn't break Mark Done.
//
// Format: date,title,source,notes   (RFC-4180-ish quoting)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { bq, fqn, USER_ID } from "@/lib/bq";
import { isDemoMode } from "@/lib/demo-mode";

const DEFAULT_FILE = path.join(os.homedir(), "Documents", "quadri-notes.csv");
const HEADER = "date,title,source,notes\n";

export function notesCsvPath(): string {
  const env = process.env.QUADRI_NOTES_FILE;
  return env && env.trim().length > 0 ? env.trim() : DEFAULT_FILE;
}

// Dedup sidecar — invisible to the user, lives next to the CSV.
// One item_ref_id per line. Keeping refs OUT of the visible CSV so
// the user sees a clean 4-column file in Excel.
function notesRefsPath(): string {
  const csv = notesCsvPath();
  return path.join(path.dirname(csv), ".quadri-notes-refs.txt");
}

function csvCell(v: string | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function appendNoteToLocalCsv(opts: {
  refId: string;
  planDate: string;
  titleHint?: string | null;
}): Promise<void> {
  const { refId, planDate, titleHint } = opts;
  if (!refId) return;
  // Hosted demo runtimes (Vercel, Cloud Run) have a read-only
  // filesystem; writing would just throw on every Done. Skip cleanly
  // and rely on item_notes + BQ for the user's note history.
  if (isDemoMode()) return;

  try {
    // Resolve title + source. Action first, then signal.
    let title: string | null = titleHint ?? null;
    let source: string | null = null;

    const [actionRows] = await bq.query({
      query: `
        SELECT
          ANY_VALUE(p.subject) AS title,
          ANY_VALUE(s.source) AS source
        FROM ${fqn("proposed_actions")} p
        LEFT JOIN UNNEST(p.related_signal_ids) AS sid
        LEFT JOIN ${fqn("quadrant_signals")} s
          ON s.signal_id = sid AND s.user_id = @uid
        WHERE p.user_id = @uid AND p.action_id = @ref
        GROUP BY p.action_id
        LIMIT 1
      `,
      params: { uid: USER_ID, ref: refId },
    });
    const aMatch = (actionRows as Array<{
      title: string | null;
      source: string | null;
    }>)[0];
    if (aMatch) {
      title = aMatch.title ?? title;
      source = aMatch.source ?? source;
    } else {
      const [sigRows] = await bq.query({
        query: `
          SELECT title, source
          FROM ${fqn("quadrant_signals")}
          WHERE user_id = @uid AND signal_id = @ref
          LIMIT 1
        `,
        params: { uid: USER_ID, ref: refId },
      });
      const sMatch = (sigRows as Array<{
        title: string | null;
        source: string | null;
      }>)[0];
      if (sMatch) {
        title = sMatch.title ?? title;
        source = sMatch.source ?? source;
      }
    }
    if (!source) source = "user";

    // Pull the user's notes for this ref. May be null/empty — fine.
    const [noteRows] = await bq.query({
      query: `
        SELECT notes FROM ${fqn("item_notes")}
        WHERE user_id = @uid AND item_ref_id = @ref
        LIMIT 1
      `,
      params: { uid: USER_ID, ref: refId },
    });
    const notes =
      (noteRows as Array<{ notes: string | null }>)[0]?.notes ?? null;

    const filePath = notesCsvPath();
    const refsPath = notesRefsPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Dedup via sidecar — refs.txt holds one item_ref_id per line.
    // If this ref is already logged, skip the append. Sidecar is
    // hidden (dot-prefix) so the user only ever sees the CSV.
    let refs = "";
    if (fs.existsSync(refsPath)) {
      refs = fs.readFileSync(refsPath, "utf-8");
    }
    const refLines = new Set(refs.split("\n").filter(Boolean));
    if (refLines.has(refId)) {
      return;
    }

    // If the existing CSV was written by an earlier build that
    // included a 5th `ref` column, migrate it in place: strip the
    // last column and bring the prior refs into the sidecar so we
    // don't double-log them on the next click.
    let csvExisted = fs.existsSync(filePath);
    if (csvExisted) {
      const existing = fs.readFileSync(filePath, "utf-8");
      const firstLine = existing.split("\n", 1)[0] ?? "";
      if (/,ref\s*$/.test(firstLine)) {
        const lines = existing.split("\n");
        const harvested: string[] = [];
        const cleaned: string[] = ["date,title,source,notes"];
        for (let i = 1; i < lines.length; i++) {
          const l = lines[i];
          if (!l) continue;
          // last column is ref (we control the writer so a simple
          // last-comma split is safe — no commas inside the marker).
          const lastComma = l.lastIndexOf(",");
          if (lastComma < 0) continue;
          const front = l.slice(0, lastComma);
          const tail = l.slice(lastComma + 1);
          const m = tail.match(/#ref=(.+)$/);
          if (m) harvested.push(m[1]);
          cleaned.push(front);
        }
        fs.writeFileSync(filePath, cleaned.join("\n") + "\n", "utf-8");
        if (harvested.length > 0) {
          fs.appendFileSync(
            refsPath,
            harvested.join("\n") + "\n",
            "utf-8",
          );
          for (const r of harvested) refLines.add(r);
        }
        // After migration, treat as if the (cleaned) file exists.
        csvExisted = true;
        // If this ref happened to be in the old file, skip.
        if (refLines.has(refId)) return;
      }
    }

    const row =
      [
        csvCell(planDate),
        csvCell(title),
        csvCell(source),
        csvCell(notes),
      ].join(",") + "\n";

    if (!csvExisted) {
      fs.writeFileSync(filePath, HEADER + row, "utf-8");
    } else {
      fs.appendFileSync(filePath, row, "utf-8");
    }
    fs.appendFileSync(refsPath, refId + "\n", "utf-8");
  } catch (e) {
    // Best-effort — never block Done.
    console.error("appendNoteToLocalCsv failed:", e);
  }
}
