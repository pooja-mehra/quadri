"use client";

import { useEffect, useRef, useState } from "react";
import type { DailyPlan } from "./types";

export type PlanPhase = "loading" | "generating" | "ready";

// Fetches today's plan; if missing, triggers POST /api/priorities/today and
// retries the GET when generation finishes. Cached daily server-side, so
// subsequent loads are instant.
export function useDailyPlan(planDate: string): {
  plan: DailyPlan | null;
  phase: PlanPhase;
} {
  const [plan, setPlan] = useState<DailyPlan | null>(null);
  const [phase, setPhase] = useState<PlanPhase>("loading");
  const triggeredRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(
          `/api/plan/today?plan_date=${encodeURIComponent(planDate)}`,
          { cache: "no-store" },
        );
        if (cancelled) return;
        if (r.ok) {
          const data = (await r.json()) as { plan: DailyPlan | null };
          const fresh =
            data.plan && data.plan.plan_date === planDate ? data.plan : null;
          if (fresh) {
            setPlan(fresh);
            setPhase("ready");
            return;
          }
        }
        if (triggeredRef.current) return;
        triggeredRef.current = true;
        setPhase("generating");
        const gen = await fetch("/api/priorities/today", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan_date: planDate }),
        });
        if (cancelled) return;
        if (gen.ok) {
          const gdata = (await gen.json()) as { plan: DailyPlan | null };
          setPlan(gdata.plan);
        }
      } catch {
        // silent — UI shows empty state
      } finally {
        if (!cancelled) setPhase("ready");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [planDate]);

  return { plan, phase };
}
