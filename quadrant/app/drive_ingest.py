"""Drive ingest: Docs / Slides / PDFs → `quadrant.drive_documents_raw`.

Fivetran's Google Drive connector is effectively Sheets-only — it ignores
Doc / Slides / PDF body content. This script fills the gap with a direct
Drive API path so the classifier can read every format from one table.

One-shot for the hackathon demo. Can be turned into a Cloud Run job + Cloud
Scheduler trigger later without restructuring.

Run:
    cd quadrant
    uv run python -m app.drive_ingest

Required env (same OAuth client also covers Gmail send later):
    GOOGLE_CLOUD_PROJECT          quadrant-495518
    GOOGLE_OAUTH_CLIENT_ID
    GOOGLE_OAUTH_CLIENT_SECRET
    GOOGLE_OAUTH_REFRESH_TOKEN    granted scopes: drive.readonly + gmail.send
    DRIVE_FOLDER_ID               optional — restrict ingest to one folder
"""

from __future__ import annotations

import io
import logging
import os
from datetime import datetime, timezone

from google.cloud import bigquery
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from pypdf import PdfReader

log = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
)

PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT", "quadrant-495518")
RAW_TABLE = f"{PROJECT_ID}.quadrant.drive_documents_raw"

DOC_MIME = "application/vnd.google-apps.document"
SLIDES_MIME = "application/vnd.google-apps.presentation"
PDF_MIME = "application/pdf"
INGESTABLE_MIMES = (DOC_MIME, SLIDES_MIME, PDF_MIME)

OAUTH_SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/gmail.send",
]


def _drive_service():
    creds = Credentials(
        token=None,
        refresh_token=os.environ["GOOGLE_OAUTH_REFRESH_TOKEN"],
        client_id=os.environ["GOOGLE_OAUTH_CLIENT_ID"],
        client_secret=os.environ["GOOGLE_OAUTH_CLIENT_SECRET"],
        token_uri="https://oauth2.googleapis.com/token",
        scopes=OAUTH_SCOPES,
    )
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def _ensure_table(bq: bigquery.Client) -> None:
    bq.query(
        f"""
        CREATE TABLE IF NOT EXISTS `{RAW_TABLE}` (
          file_id        STRING NOT NULL,
          name           STRING,
          mime_type      STRING,
          modified_time  TIMESTAMP,
          body_text      STRING,
          ingested_at    TIMESTAMP
        )
        """
    ).result()


def _list_files(svc, folder_id: str | None) -> list[dict]:
    mime_clause = " or ".join(f"mimeType = '{m}'" for m in INGESTABLE_MIMES)
    query = f"trashed = false and ({mime_clause})"
    if folder_id:
        query = f"'{folder_id}' in parents and {query}"

    files: list[dict] = []
    page_token: str | None = None
    while True:
        resp = (
            svc.files()
            .list(
                q=query,
                fields="nextPageToken, files(id, name, mimeType, modifiedTime)",
                pageSize=100,
                pageToken=page_token,
            )
            .execute()
        )
        files.extend(resp.get("files", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return files


def _export_text(svc, file_id: str) -> str:
    raw = svc.files().export(fileId=file_id, mimeType="text/plain").execute()
    return raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)


def _download_pdf_text(svc, file_id: str) -> str:
    request = svc.files().get_media(fileId=file_id)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    buf.seek(0)
    reader = PdfReader(buf)
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def _body_for(svc, f: dict) -> str:
    mime = f["mimeType"]
    try:
        if mime in (DOC_MIME, SLIDES_MIME):
            return _export_text(svc, f["id"])
        if mime == PDF_MIME:
            return _download_pdf_text(svc, f["id"])
    except Exception as exc:
        log.warning("Body extraction failed for %s (%s): %s", f["name"], mime, exc)
    return ""


def _upsert(bq: bigquery.Client, rows: list[dict]) -> None:
    if not rows:
        return

    stage = f"{PROJECT_ID}.quadrant._drive_documents_stage"
    load_job = bq.load_table_from_json(
        rows,
        stage,
        job_config=bigquery.LoadJobConfig(
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
            schema=[
                bigquery.SchemaField("file_id", "STRING", mode="REQUIRED"),
                bigquery.SchemaField("name", "STRING"),
                bigquery.SchemaField("mime_type", "STRING"),
                bigquery.SchemaField("modified_time", "TIMESTAMP"),
                bigquery.SchemaField("body_text", "STRING"),
                bigquery.SchemaField("ingested_at", "TIMESTAMP"),
            ],
        ),
    )
    load_job.result()

    bq.query(
        f"""
        MERGE `{RAW_TABLE}` T
        USING `{stage}` S
        ON T.file_id = S.file_id
        WHEN MATCHED THEN UPDATE SET
          name = S.name,
          mime_type = S.mime_type,
          modified_time = S.modified_time,
          body_text = S.body_text,
          ingested_at = S.ingested_at
        WHEN NOT MATCHED THEN
          INSERT (file_id, name, mime_type, modified_time, body_text, ingested_at)
          VALUES (S.file_id, S.name, S.mime_type, S.modified_time, S.body_text, S.ingested_at)
        """
    ).result()

    bq.query(f"DROP TABLE `{stage}`").result()


def main() -> None:
    bq = bigquery.Client(project=PROJECT_ID)
    _ensure_table(bq)

    svc = _drive_service()
    folder_id = os.environ.get("DRIVE_FOLDER_ID") or None
    files = _list_files(svc, folder_id)
    log.info("Found %d files to ingest", len(files))

    now = datetime.now(timezone.utc).isoformat()
    rows: list[dict] = []
    for f in files:
        body = _body_for(svc, f)
        rows.append(
            {
                "file_id": f["id"],
                "name": f["name"],
                "mime_type": f["mimeType"],
                "modified_time": f.get("modifiedTime"),
                "body_text": body,
                "ingested_at": now,
            }
        )
        log.info("  %s (%s, %d chars)", f["name"], f["mimeType"], len(body))

    _upsert(bq, rows)
    log.info("Upserted %d rows into %s", len(rows), RAW_TABLE)


if __name__ == "__main__":
    main()
