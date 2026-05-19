import fs from "node:fs";
import { notesCsvPath } from "@/lib/local-csv-log";

export const dynamic = "force-dynamic";

// Serves the auto-appended local CSV at ~/Documents/quadri-notes.csv
// (or QUADRI_NOTES_FILE override). The file is written incrementally
// by appendNoteToLocalCsv on every Mark Done — this endpoint just
// streams it back so the header "Export notes" link downloads the
// current contents.

export async function GET() {
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
