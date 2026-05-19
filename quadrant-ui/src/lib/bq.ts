import { BigQuery } from "@google-cloud/bigquery";

export const PROJECT_ID = process.env.GCP_PROJECT ?? "quadrant-495518";
export const DATASET = process.env.QUADRANT_DATASET ?? "quadrant";
export const USER_ID = process.env.QUADRANT_USER_ID ?? "demo_user";

// Auth strategy — two paths, in priority order:
//
//   1. GCP_SERVICE_ACCOUNT_KEY (preferred for hosted deploys)
//      The entire service-account JSON, pasted as a single env var.
//      Vercel / Cloud Run have no filesystem for a GOOGLE_APPLICATION_-
//      CREDENTIALS=/path/to/key.json setup, so we parse it inline.
//
//   2. Application Default Credentials (local dev)
//      Picks up `gcloud auth application-default login` automatically.
//      Used when GCP_SERVICE_ACCOUNT_KEY isn't set.
//
// Either path produces a BigQuery client scoped to PROJECT_ID. The
// service account just needs BigQuery Data Editor + Job User on the
// quadrant dataset.

function makeBigQueryClient(): BigQuery {
  const jsonKey = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (jsonKey && jsonKey.trim().length > 0) {
    try {
      const credentials = JSON.parse(jsonKey);
      return new BigQuery({ projectId: PROJECT_ID, credentials });
    } catch (e) {
      throw new Error(
        "GCP_SERVICE_ACCOUNT_KEY is set but isn't valid JSON. " +
          "Paste the full service-account key object (not a file path).",
      );
    }
  }
  return new BigQuery({ projectId: PROJECT_ID });
}

export const bq = makeBigQueryClient();

export const fqn = (table: string) => `\`${PROJECT_ID}.${DATASET}.${table}\``;

export const QUADRANTS = ["health", "education", "career", "relationships"] as const;
export type Quadrant = (typeof QUADRANTS)[number];
