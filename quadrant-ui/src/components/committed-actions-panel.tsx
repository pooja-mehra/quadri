"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { CommittedAction } from "@/lib/types";

const TYPE_LABEL: Record<CommittedAction["action_type"], string> = {
  email_draft: "Email",
  text_draft: "Text",
  calendar_event: "Calendar",
};

const STALE_HOURS = 24;

function ageLabel(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function CommittedActionsPanel({
  actions,
  onChanged,
}: {
  actions: CommittedAction[];
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<Record<string, boolean>>({});

  async function markSent(id: string) {
    setPending((p) => ({ ...p, [id]: true }));
    try {
      const r = await fetch(`/api/actions/${id}/send`, { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      toast.success("Marked as sent — follow-through credit added");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally {
      setPending((p) => ({ ...p, [id]: false }));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Committed (awaiting send)</span>
          <Badge variant="secondary">{actions.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing committed yet. Approved drafts land here for follow-through.
          </p>
        ) : (
          <ul className="space-y-3">
            {actions.map((a, i) => {
              const stale = a.hours_since_decided >= STALE_HOURS;
              const busy = pending[a.action_id];
              return (
                <li key={a.action_id}>
                  {i > 0 ? <Separator className="mb-3" /> : null}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline">{TYPE_LABEL[a.action_type]}</Badge>
                        <span className="truncate">to {a.to_recipient ?? "—"}</span>
                        <span className="tabular-nums">· {ageLabel(a.hours_since_decided)}</span>
                        {stale ? (
                          <Badge variant="destructive" className="text-xs">stale</Badge>
                        ) : null}
                      </div>
                      {a.subject ? (
                        <div className="mt-1 text-sm font-medium">{a.subject}</div>
                      ) : null}
                      <div className="mt-1 text-sm text-foreground/80 line-clamp-2">
                        {a.body ?? "(no body)"}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1">
                      <Button
                        size="sm"
                        variant="default"
                        disabled={busy}
                        onClick={() => markSent(a.action_id)}
                      >
                        {busy ? "..." : "Mark as sent"}
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
