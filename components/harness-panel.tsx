import { useCallback, useEffect, useRef, useState } from "react";
import {
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { HarnessStatusDto, PlanNodeDto, rpcContract } from "../server";
import {
  PHASES,
  PHASE_COPY,
  formatChoice,
  nodeSpawnsChild,
  routingChoiceForPlanNode,
  type ExecutionChoice,
  type Phase,
} from "../lib/harness";
import { CRITIC_VERDICTS, type CriticVerdict } from "../lib/outcomes";
import { NodeRoutingControl } from "./harness-settings";
import { HarnessV3Panel } from "./harness-v3-panel";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function persistedPlanChoice(node: PlanNodeDto): ExecutionChoice | null {
  if (!node.providerId || !node.model || !node.reasoningLevel) return null;
  const choice: ExecutionChoice = {
    providerId: node.providerId,
    model: node.model,
    reasoningLevel: node.reasoningLevel as ExecutionChoice["reasoningLevel"],
  };
  if (node.serviceTier === "default" || node.serviceTier === "fast") {
    choice.serviceTier = node.serviceTier;
  }
  return choice;
}

function useHarness(threadId: string | null, projectId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const requestId = useRef(0);
  const [status, setStatus] = useState<{
    threadId: string;
    value: HarnessStatusDto;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refetch = useCallback(() => {
    if (!threadId) {
      requestId.current += 1;
      setStatus(null);
      setError(null);
      setPending(false);
      return;
    }
    const id = ++requestId.current;
    rpc
      .call("getStatus", { threadId, projectId: projectId ?? undefined })
      .then((result) => {
        if (id !== requestId.current) return;
        setStatus({ threadId, value: result });
        setError(null);
      }, (cause: unknown) => {
        if (id !== requestId.current) return;
        report(cause);
      });
  }, [rpc, threadId, projectId, report]);

  useEffect(() => {
    setError(null);
    setPending(false);
    refetch();
  }, [refetch]);
  useRealtime("harness", refetch);
  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = connection;
    if (previous !== "connected" && connection === "connected") refetch();
  }, [connection, refetch]);

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      setPending(true);
      try {
        await work();
        refetch();
      } catch (cause) {
        report(cause);
      } finally {
        setPending(false);
      }
    },
    [refetch, report],
  );

  const visibleStatus =
    threadId && status?.threadId === threadId ? status.value : null;
  return { rpc, status: visibleStatus, error, pending, run, refetch };
}

function ArcStrip({ phase }: { phase: Phase }) {
  const currentIndex = PHASES.indexOf(phase);
  return (
    <ol className="grid grid-cols-5 gap-1">
      {PHASES.map((item, index) => {
        const active = item === phase;
        const done = index < currentIndex;
        return (
          <li key={item}>
            <div
              className={cn(
                "flex w-full flex-col items-center gap-1.5 rounded-md px-1 py-2 text-center",
                active ? "bg-foreground text-background" : "bg-transparent",
              )}
            >
              <span
                className={cn(
                  "size-2.5 rounded-full",
                  active ? "bg-background" : done ? "bg-foreground" : "bg-border",
                )}
              />
              <span className="text-[11px] font-medium leading-none">
                {PHASE_COPY[item].label}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function RoutingBand({
  phase,
  routing,
}: {
  phase: Phase;
  routing: HarnessStatusDto["routing"];
}) {
  const slots = [
    routing.explore,
    routing.plan,
    routing.workerFirst,
    routing.critic,
    routing.promote,
  ] as const;
  const labels = ["explore", "plan", "worker*", "critic", "promote"] as const;
  return (
    <div className="mt-2 space-y-1">
      <div className="grid grid-cols-5 gap-1 text-[10px] leading-none text-muted-foreground">
        {labels.map((label, index) => (
          <div
            key={label}
            className={cn(
              "truncate rounded-sm px-1 py-1 text-center",
              slots[index] ? "bg-foreground/10 text-foreground" : "bg-muted",
              PHASES[index] === phase && "ring-1 ring-ring",
            )}
            title={formatChoice(slots[index])}
          >
            {slots[index]?.model ?? "inherit"}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Role defaults from Settings. Later Worker nodes use Worker (later nodes)
        {routing.workerRest ? ` (${routing.workerRest.model})` : " (inherit)"}.
      </p>
    </div>
  );
}

function formatTokens(total: number | null | undefined): string {
  return total == null ? "—" : String(total);
}

function mutationRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function ManualHarnessView({
  status,
  pending,
  onStop,
  onStartNode,
  onCompleteNode,
  onAddWorker,
  onSetRouting,
  onResetBlock,
}: {
  status: HarnessStatusDto;
  pending: boolean;
  onStop: () => void;
  onStartNode: (nodeId: string) => void;
  onCompleteNode: (nodeId: string, extra?: { verdict?: CriticVerdict; summary?: string }) => void;
  onAddWorker: (title: string) => void;
  onSetRouting: (nodeId: string, choice: ExecutionChoice | null) => void;
  onResetBlock: () => void;
}) {
  const navigate = useBbNavigate();
  const [workerTitle, setWorkerTitle] = useState("");
  const [completionSummaries, setCompletionSummaries] = useState<Record<string, string>>({});
  const plan = status.plan;
  const phase = status.arc.phase;
  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm font-medium">
        Harness · {status.harness?.name ?? "Standard Harness"}
      </p>
      <p className="text-sm text-muted-foreground">{status.arc.note || status.harness?.description}</p>
      <ArcStrip phase={phase} />
      <RoutingBand phase={phase} routing={status.routing} />
      {plan ? (
        <p className="text-[11px] text-muted-foreground">
          Corrections {plan.correctionCount}
          {plan.harnessSnapshot?.maxCorrections != null
            ? ` / ${plan.harnessSnapshot.maxCorrections}`
            : ""}
          {plan.criticBlocked ? " · Promote blocked" : ""}
          {` · ${plan.lifecycle} · rev ${plan.revision}`}
          {` · child ${plan.totals.durationMs ?? "—"}ms · tokens ${formatTokens(plan.totals.tokens.total)}`}
        </p>
      ) : null}
      {plan?.skillWarnings.map((warning) => (
        <p key={warning} className="text-[11px] text-muted-foreground">
          {warning}
        </p>
      ))}
      {plan?.mutations?.[0] ? (
        <p className="text-[11px] text-muted-foreground">
          Last change: {plan.mutations[0].action} · {plan.mutations[0].source}
          {plan.mutations[0].reason ? ` · ${plan.mutations[0].reason}` : ""}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {plan?.criticBlocked ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={onResetBlock}>
            Reset block
          </Button>
        ) : null}
        <Button size="sm" variant="destructive" disabled={pending} onClick={onStop}>
          Stop
        </Button>
      </div>
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-3 py-2">
          <p className="text-sm font-medium">DAG</p>
        </div>
        <ul className="divide-y divide-border">
          {(plan?.nodes ?? []).map((node) => (
            <li key={node.id} className="flex flex-col gap-1 px-3 py-2">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {node.status === "done"
                    ? "[x]"
                    : node.status === "in_progress" || node.status === "starting"
                      ? "[>]"
                      : node.status === "skipped"
                        ? "[-]"
                        : "[ ]"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{node.title}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {node.phase} · {node.execution} · {node.status}
                    {` · ${formatChoice(routingChoiceForPlanNode(plan?.nodes ?? [], node, status.routing))}`}
                    {node.result?.verdict ? ` · ${node.result.verdict}` : ""}
                    {node.attempt ? ` · ${node.attempt.outcome}` : ""}
                    {node.attempt?.durationMs != null ? ` · ${node.attempt.durationMs}ms` : ""}
                    {node.attempt?.tokens.total != null ? ` · ${node.attempt.tokens.total} tok` : ""}
                  </p>
                  {node.result?.summary ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">{node.result.summary}</p>
                  ) : null}
                  {node.child ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Child {node.child.status}
                      {node.child.title ? ` · ${node.child.title}` : ""}
                    </p>
                  ) : !nodeSpawnsChild(node) ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {node.status === "pending"
                        ? "Stays on the parent thread — click Start to run in this thread"
                        : node.status === "in_progress" && !node.attempt
                          ? "Starting in this thread…"
                          : node.status === "in_progress" && node.attempt?.outcome === "running"
                            ? "Running in this thread — waiting for agent response…"
                            : node.status === "in_progress" && node.attempt?.outcome === "idle_with_output"
                              ? "Output captured — review the response above, then mark Done"
                              : node.status === "in_progress" && node.attempt?.outcome === "idle_empty"
                                ? "No output was produced — retry or stop"
                                : node.attempt
                                  ? `Parent attempt ${node.attempt.outcome}`
                                  : "Stays on the parent thread"}
                    </p>
                  ) : null}
                  {(() => {
                    const override = persistedPlanChoice(node);
                    const effective = routingChoiceForPlanNode(plan?.nodes ?? [], node, status.routing);
                    const editable = node.status === "pending";
                    const locked = node.status !== "pending";
                    return (
                      <div className="mt-2">
                        <NodeRoutingControl
                          effective={effective}
                          override={override}
                          editable={editable}
                          disabled={pending}
                          onChange={(next) => onSetRouting(node.id, next)}
                        />
                        {locked && override ? (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Locked to node override {override.providerId}/{override.model} ({override.reasoningLevel}).
                          </p>
                        ) : null}
                      </div>
                    );
                  })()}
                  {node.status === "in_progress" && nodeSpawnsChild(node) ? (
                    <div className="mt-2 space-y-2">
                      <textarea
                        value={completionSummaries[node.id] ?? ""}
                        onChange={(event) =>
                          setCompletionSummaries((current) => ({
                            ...current,
                            [node.id]: event.target.value,
                          }))
                        }
                        placeholder={`${PHASE_COPY[node.phase].label} completion summary`}
                        aria-label={`${PHASE_COPY[node.phase].label} completion summary`}
                        rows={2}
                        className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                      />
                      {node.phase === "critic" ? (
                        <div className="flex flex-wrap gap-1">
                          {CRITIC_VERDICTS.map((verdict) => (
                            <Button
                              key={verdict}
                              size="sm"
                              variant={verdict === "BLOCK" ? "destructive" : "outline"}
                              disabled={pending || !(completionSummaries[node.id] ?? "").trim()}
                              onClick={() =>
                                onCompleteNode(node.id, {
                                  verdict,
                                  summary: (completionSummaries[node.id] ?? "").trim(),
                                })
                              }
                            >
                              {verdict}
                            </Button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1">
                  {node.status === "pending" ? (
                    <Button size="sm" disabled={pending} onClick={() => onStartNode(node.id)}>
                      Start
                    </Button>
                  ) : null}
                  {node.status === "in_progress" && node.phase !== "critic" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        pending ||
                        (nodeSpawnsChild(node)
                          ? !(completionSummaries[node.id] ?? "").trim()
                          : node.attempt?.outcome !== "idle_with_output")
                      }
                      onClick={() => {
                        const summary = (completionSummaries[node.id] ?? "").trim();
                        if (nodeSpawnsChild(node)) {
                          onCompleteNode(node.id, summary ? { summary } : undefined);
                        } else {
                          onCompleteNode(node.id, summary ? { summary } : undefined);
                        }
                      }}
                    >
                      Done
                    </Button>
                  ) : null}
                  {node.child ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => navigate.toThread(node.child!.id)}
                    >
                      Open
                    </Button>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!workerTitle.trim()) return;
          onAddWorker(workerTitle.trim());
          setWorkerTitle("");
        }}
      >
        <Input
          value={workerTitle}
          onChange={(event) => setWorkerTitle(event.target.value)}
          placeholder="Add Worker node"
          aria-label="Add Worker node"
          disabled={pending}
        />
        <Button type="submit" size="sm" disabled={pending || workerTitle.trim() === ""}>
          Add Worker
        </Button>
      </form>
    </div>
  );
}

export function HarnessPanel({
  threadId: threadIdProp,
}: {
  threadId?: string | null;
}) {
  const ctx = useBbContext();
  const threadId = threadIdProp ?? ctx.threadId;
  const projectId = ctx.projectId;
  const { rpc, status, error, pending, run } = useHarness(threadId, projectId);
  const manual = Boolean(status?.harness);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">
          Ordinary chats stay ordinary until you start a Harness. New runs
          are always v3 — Planner-led, with an explicit implementation DAG.
          Auditable output lives in <code>artifacts/</code>.
        </p>

        <HarnessV3Panel threadId={threadId} />

        {!threadId ? (
          <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Open a thread to start a Harness run.
          </div>
        ) : !status ? (
          <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Loading harness…
          </div>
        ) : manual ? (
          <section aria-label="Legacy run">
            <h2 className="mt-6 text-sm font-medium">Legacy run (v0.1/v2)</h2>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Read-only compatibility for a run started before v3. Finish or
              stop it here; new work starts above as v3.
            </p>
            <ManualHarnessView
                status={status}
                pending={pending}
                onStop={() => {
                  if (!status.plan) return;
                  const active = status.plan.nodes.find(
                    (node) => node.status === "starting" || node.status === "in_progress",
                  );
                  const detail = active
                    ? ` Active ${PHASE_COPY[active.phase].label} node “${active.title}” and its child will be interrupted.`
                    : "";
                  if (!window.confirm(`Cancel Harness “${status.plan.name}”?${detail}`)) return;
                  void run(() =>
                    rpc.call("stopRun", {
                      threadId,
                      projectId: projectId ?? undefined,
                      expectedRevision: status.plan!.revision,
                      requestId: mutationRequestId(),
                      reason: "Operator confirmed cancellation from Harness panel.",
                    }),
                  );
                }}
                onStartNode={(nodeId) => {
                  if (!status.plan) return;
                  void run(() =>
                    rpc.call("startNode", {
                      planId: status.plan!.id,
                      nodeId,
                      threadId,
                      projectId: projectId ?? undefined,
                      expectedRevision: status.plan!.revision,
                      requestId: mutationRequestId(),
                    }),
                  );
                }}
                onCompleteNode={(nodeId, extra) => {
                  if (!status.plan) return;
                  const node = status.plan.nodes.find((item) => item.id === nodeId);
                  const base: Record<string, unknown> = {
                    planId: status.plan!.id,
                    nodeId,
                    threadId,
                    projectId: projectId ?? undefined,
                    expectedRevision: status.plan!.revision,
                    expectedAttemptId: node?.attempt?.id ?? null,
                    requestId: mutationRequestId(),
                  };
                  if ((extra as Record<string, unknown> | undefined)?.summary !== undefined) base.summary = (extra as Record<string, unknown>).summary;
                  if ((extra as Record<string, unknown> | undefined)?.verdict !== undefined) base.verdict = (extra as Record<string, unknown>).verdict;
                  if ((extra as Record<string, unknown> | undefined)?.artifactPaths !== undefined) base.artifactPaths = (extra as Record<string, unknown>).artifactPaths;
                  const payload = base;
                  void run(() => rpc.call("completeNode", payload as never));
                }}
                onAddWorker={(title) => {
                  if (!status.plan) return;
                  const workers = status.plan.nodes.filter((node) => node.phase === "worker");
                  const last = workers[workers.length - 1];
                  const planNode = status.plan.nodes.find((node) => node.phase === "plan");
                  void run(() =>
                    rpc.call("addNode", {
                      planId: status.plan!.id,
                      title,
                      phase: "worker",
                      deps: last ? [last.id] : planNode ? [planNode.id] : [],
                      threadId,
                      projectId: projectId ?? undefined,
                      expectedRevision: status.plan!.revision,
                      requestId: mutationRequestId(),
                    }),
                  );
                }}
                onSetRouting={(nodeId, choice) => {
                  if (!status.plan) return;
                  void run(() =>
                    rpc.call("setNodeRouting", {
                      planId: status.plan!.id,
                      nodeId,
                      choice,
                      threadId,
                      projectId: projectId ?? undefined,
                      expectedRevision: status.plan!.revision,
                      requestId: mutationRequestId(),
                    }),
                  );
                }}
                onResetBlock={() => {
                  if (!status.plan) return;
                  void run(() =>
                    rpc.call("resetCriticBlock", {
                      planId: status.plan!.id,
                      threadId,
                      projectId: projectId ?? undefined,
                      expectedRevision: status.plan!.revision,
                      requestId: mutationRequestId(),
                      reason: "Operator reset Critic block from Harness panel.",
                    }),
                  );
                }}
              />
            </section>
        ) : null}

        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function HarnessBanner({
  threadId: threadIdProp,
}: {
  threadId?: string | null;
} = {}) {
  const ctx = useBbContext();
  const threadId = threadIdProp ?? ctx.threadId;
  const projectId = ctx.projectId;
  const { status } = useHarness(threadId, projectId);
  const rpc = useRpc();
  const [v3State, setV3State] = useState<string | null>(null);
  const refetchV3 = useCallback(() => {
    if (!threadId) {
      setV3State(null);
      return;
    }
    (rpc.call as (m: string, i: unknown) => Promise<unknown>)(
      "v3Status",
      projectId ? { threadId, projectId } : { threadId },
    ).then(
      (result) => setV3State((result as { run: { state: string } | null }).run?.state ?? null),
      () => setV3State(null),
    );
  }, [rpc, threadId, projectId]);
  useEffect(() => {
    refetchV3();
  }, [refetchV3]);
  useRealtime("harness", refetchV3);
  if (v3State) {
    return (
      <p className="px-1 text-xs text-muted-foreground">
        Harness · {v3State}
      </p>
    );
  }
  if (status?.harness) {
    return (
      <p className="px-1 text-xs text-muted-foreground">
        Harness · {PHASE_COPY[status.arc.phase].label} (legacy)
      </p>
    );
  }
  return null;
}

export function HarnessHeaderAction({
  isCompactViewport,
}: {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}) {
  const navigate = useBbNavigate();
  return (
    <Button
      size={isCompactViewport ? "icon" : "sm"}
      variant="ghost"
      aria-label="Start Harness"
      onClick={() => {
        navigate.openThreadPanel({ actionId: "arc", title: "Harness" });
      }}
    >
      <Icon name="Workflow" className="size-4" />
      {isCompactViewport ? null : "Start Harness"}
    </Button>
  );
}
