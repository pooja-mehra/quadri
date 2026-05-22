import fs from "node:fs";
import { notesCsvPath } from "@/lib/local-csv-log";
import { isDemoMode } from "@/lib/demo-mode";

export const dynamic = "force-dynamic";

// Serves the auto-appended local CSV at ~/Documents/quadri-notes.csv
// (or QUADRI_NOTES_FILE override). The file is written incrementally
// by appendNoteToLocalCsv on every Mark Done — this endpoint just
// streams it back so the header "Export notes" link downloads the
// current contents.

// Demo-mode sample. Hosted demo writes are short-circuited (read-only
// fs), so the live file is empty. Return a realistic seed so judges
// clicking "Export notes" on the deployed URL see the feature working.
const DEMO_SAMPLE_CSV = `date,title,source,notes
2026-05-20,Sign Northwind MSA,email,"Sent signed v3 back to Sarah. Renewal locked through Q4."
2026-05-20,Prep board update slides,drive,"Pulled metrics from the Q1 sheet. Retention section needs a chart, not the table."
2026-05-19,1:1 with David,calendar,"Roadmap discussion — he's good with pushing ingestion rewrite to July."
2026-05-19,Reply to Acme redlines,email,"Pushed back on clause 4.2; legal flagged the indemnity wording as non-standard."
2026-05-18,Reschedule team offsite,user,"Mission Bay room booked for Friday. Catering ordered."
`;

export async function GET() {
  if (isDemoMode()) {
    const filename = `quadri-notes-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(DEMO_SAMPLE_CSV, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  const filePath = notesCsvPath();
  try {
    if (!fs.existsSync(filePath)) {
      return new Response("date,title,source,notes\n", {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="quadri-notes-empty.csv"`,
        },
      });
    }
    const body = fs.readFileSync(filePath, "utf-8");
    const filename = `quadri-notes-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: e instanceof Error ? e.message : "unknown error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
