import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";

const WEIGHT_MIN = 0.1;
const WEIGHT_MAX = 0.5;
const SUM_TOLERANCE = 0.01;

const QUADRANTS = ["health", "education", "career", "relationships"] as const;
type Q = (typeof QUADRANTS)[number];
type Weights = Record<Q, number>;

export async function POST(request: Request) {
  let body: Partial<Weights>;
  try {
    body = (await request.json()) as Partial<Weights>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  for (const q of QUADRANTS) {
    if (typeof body[q] !== "number" || Number.isNaN(body[q])) {
      return NextResponse.json(
        { error: `${q} must be a number` },
        { status: 400 },
      );
    }
  }
  const w = body as Weights;

  const out = QUADRANTS.filter((q) => w[q] < WEIGHT_MIN || w[q] > WEIGHT_MAX);
  if (out.length) {
    return NextResponse.json(
      {
        error:
          `out of bounds: ${out.join(", ")} ` +
          `(each must be in [${WEIGHT_MIN}, ${WEIGHT_MAX}])`,
      },
      { status: 400 },
    );
  }

  const total = QUADRANTS.reduce((s, q) => s + w[q], 0);
  if (Math.abs(total - 1.0) > SUM_TOLERANCE) {
    return NextResponse.json(
      {
        error: `weights sum to ${total.toFixed(3)} — must sum to 1.0 (±${SUM_TOLERANCE})`,
      },
      { status: 400 },
    );
  }

  const sql = `
    MERGE ${fqn("user_quadrant_weights")} AS T
    USING (
      SELECT @uid AS uid, "health"        AS q, @health        AS w UNION ALL
      SELECT @uid,        "education",       @education              UNION ALL
      SELECT @uid,        "career",          @career                 UNION ALL
      SELECT @uid,        "relationships",   @relationships
    ) AS S
    ON T.user_id = S.uid AND T.quadrant = S.q
    WHEN MATCHED THEN
      UPDATE SET weight = S.w, source = 'user_set', set_at = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN
      INSERT (user_id, quadrant, weight, source, set_at)
      VALUES (S.uid, S.q, S.w, 'user_set', CURRENT_TIMESTAMP())
  `;

  try {
    await bq.query({
      query: sql,
      params: {
        uid: USER_ID,
        health: w.health,
        education: w.education,
        career: w.career,
        relationships: w.relationships,
      },
    });
    return NextResponse.json({ ok: true, weights: w });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "save failed" },
      { status: 500 },
    );
  }
}
