import { BigQuery } from "@google-cloud/bigquery";

export const PROJECT_ID = process.env.GCP_PROJECT ?? "quadrant-495518";
export const DATASET = process.env.QUADRANT_DATASET ?? "quadrant";
export const USER_ID = process.env.QUADRANT_USER_ID ?? "demo_user";

export const bq = new BigQuery({ projectId: PROJECT_ID });

export const fqn = (table: string) => `\`${PROJECT_ID}.${DATASET}.${table}\``;

export const QUADRANTS = ["health", "education", "career", "relationships"] as const;
export type Quadrant = (typeof QUADRANTS)[number];
