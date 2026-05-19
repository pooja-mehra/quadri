"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { Goal } from "@/lib/types";

export function ProposedGoalsPanel({
  goals,
  onChanged,
}: {
  goals: Goal[];
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<Record<string, "approve" | "reject" | undefined>>({});

  async function decide(id: string, decision: "approve" | "reject") {
    setPending((p) => ({ ...p, [id]: decision }));
    try {
      const r = await fetch(`/api/goals/${id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      toast.success(decision === "approve" ? "Goal activated" : "Goal archived");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Goal decision failed");
    } finally {
      setPending((p) => ({ ...p, [id]: undefined }));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Proposed goals</span>
          <Badge variant="secondary">{goals.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {goals.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No proposed goals right now. Ask the copilot to look for patterns in your data.
          </p>
        ) : (
          <ul className="space-y-3">
            {goals.map((g, i) => {
              const busy = pending[g.goal_id];
              return (
                <li key={g.goal_id}>
                  {i > 0 ? <Separator className="mb-3" /> : null}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline" className="capitalize">{g.quadrant}</Badge>
                        {g.derived_confidence != null ? (
                          <span className="tabular-nums">
                            confidence {Math.round(g.derived_confidence * 100)}%
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 text-sm font-medium">{g.title}</div>
                      <div className="mt-1 text-sm text-foreground/80 line-clamp-2">
                        {g.description}
                      </div>
                      {g.derived_reasoning ? (
                        <div className="mt-1 text-xs italic text-muted-foreground line-clamp-2">
                          — {g.derived_reasoning}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col gap-1">
                      <Button
                        size="sm"
                        variant="default"
                        disabled={!!busy}
                        onClick={() => decide(g.goal_id, "approve")}
                      >
                        {busy === "approve" ? "..." : "Approve"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!busy}
                        onClick={() => decide(g.goal_id, "reject")}
                      >
                        {busy === "reject" ? "..." : "Reject"}
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
