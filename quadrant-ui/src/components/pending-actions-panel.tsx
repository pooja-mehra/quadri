"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { PendingAction } from "@/lib/types";

const TYPE_LABEL: Record<PendingAction["action_type"], string> = {
  email_draft: "Email",
  text_draft: "Text",
  calendar_event: "Calendar",
};

export function PendingActionsPanel({
  actions,
  onChanged,
}: {
  actions: PendingAction[];
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<Record<string, "approve" | "reject" | undefined>>({});

  async function decide(id: string, decision: "approve" | "reject") {
    setPending((p) => ({ ...p, [id]: decision }));
    try {
      const r = await fetch(`/api/actions/${id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      toast.success(decision === "approve" ? "Approved" : "Rejected");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setPending((p) => ({ ...p, [id]: undefined }));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Pending actions</span>
          <Badge variant="secondary">{actions.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing waiting on you. Ask the copilot to rebalance to surface drafts.
          </p>
        ) : (
          <ul className="space-y-3">
            {actions.map((a, i) => {
              const busy = pending[a.action_id];
              return (
                <li key={a.action_id}>
                  {i > 0 ? <Separator className="mb-3" /> : null}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline">{TYPE_LABEL[a.action_type]}</Badge>
                        <span className="truncate">to {a.to_recipient ?? "—"}</span>
                      </div>
                      {a.subject ? (
                        <div className="mt-1 text-sm font-medium">{a.subject}</div>
                      ) : null}
                      <div className="mt-1 text-sm text-foreground/80 line-clamp-2">
                        {a.body ?? "(no body)"}
                      </div>
                      {a.reasoning ? (
                        <div className="mt-1 text-xs italic text-muted-foreground line-clamp-1">
                          — {a.reasoning}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col gap-1">
                      <Button
                        size="sm"
                        variant="default"
                        disabled={!!busy}
                        onClick={() => decide(a.action_id, "approve")}
                      >
                        {busy === "approve" ? "..." : "Approve"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!busy}
                        onClick={() => decide(a.action_id, "reject")}
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
