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
  isSpawnablePhase,
  routingSlotFor,
  type ExecutionChoice,
  type Phase,
} from "../lib/harness";
import { SlotModelPicker } from "./harness-settings";
import { StartHarnessForm } from "./start-harness-form";
import {
  MILESTONE_PIPELINE_ID,
  ROLE_TITLE,
  isLiveRunStatus,
  isTerminalRunStatus,
  type AgentRole,
  type RunStatus,
} from "../lib/run-engine";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type RunDetails = NonNullable<HarnessStatusDto["run"]>;
type RunNode = RunDetails["nodes"][number];
type Packet = RunDetails["packets"][number];

const RUN_STATUS_COPY: Record<RunStatus, string> = {
  configuring: "Configuring",
  running: "Running",
  awaiting_plan_approval: "Awaiting plan approval",
  awaiting_correction_approval: "Awaiting correction approval",
  completed: "APPROVED",
  blocked: "BLOCKED",
  cancelled: "CANCELLED",
  failed: "FAILED",
};

function packetSummary(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["summary", "recommendation", "verdict"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  try {
    return JSON.stringify(payload).slice(0, 160);
  } catch {
    return "";
  }
}

function persistedChoice(
  node: Pick<
    RunNode,
    "providerId" | "model" | "reasoningLevel" | "serviceTier"
  >,
): ExecutionChoice | null {
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

function persistedPlanChoice(node: PlanNodeDto): ExecutionChoice | null {
  return persistedChoice(node);
}

function displayChoiceForNode(
  nodes: RunNode[],
  node: RunNode,
  packet: RunDetails["taskPacket"],
  routing: HarnessStatusDto["routing"],
): ExecutionChoice | null {
  const persisted = persistedChoice(node);
  if (persisted) return persisted;
  if (node.status !== "pending") return null;
  const workers = nodes
    .filter((item) => item.role === "worker")
    .sort((left, right) => left.ordinal - right.ordinal);
  const workerIndex = workers.findIndex((item) => item.id === node.id);
  const slot = routingSlotFor(node.phase, workerIndex >= 0 ? workerIndex : 0);
  return packet.routingOverrides?.[slot] ?? routing[slot];
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
  engine,
}: {
  phase: Phase;
  routing: HarnessStatusDto["routing"];
  engine?: "manual" | "milestone";
}) {
  const slots = [
    routing.explore,
    routing.plan,
    routing.workerFirst,
    routing.critic,
    routing.promote,
  ] as const;
  const labels =
    engine === "manual"
      ? (["explore", "plan", "worker*", "critic", "promote"] as const)
      : (["scout", "planner", "worker*", "reviewer", "promote"] as const);
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
        Role defaults from Settings. Later Worker nodes use Worker + Tester
        (later nodes)
        {routing.workerRest ? ` (${routing.workerRest.model})` : " (inherit)"}.
      </p>
    </div>
  );
}

function RunNodeRow({
  node,
  choice,
  packet,
  current,
  pending,
  onOpen,
  onSetRouting,
}: {
  node: RunNode;
  choice: ExecutionChoice | null;
  packet: Packet | undefined;
  current: boolean;
  pending: boolean;
  onOpen: (threadId: string) => void;
  onSetRouting: (nodeId: string, choice: ExecutionChoice | null) => void;
}) {
  const canOverride = node.status === "pending" || node.status === "failed";
  return (
    <li
      className={cn(
        "flex flex-col gap-1 px-3 py-2",
        current && "bg-state-hover/60",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 font-mono text-xs text-muted-foreground">
          {node.status === "done"
            ? "[x]"
            : node.status === "in_progress" || node.status === "starting"
              ? "[>]"
              : node.status === "failed"
                ? "[!]"
                : node.status === "skipped"
                  ? "[-]"
                  : "[ ]"}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">
            {ROLE_TITLE[node.role as AgentRole] ?? node.role}
            {current ? (
              <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                current
              </span>
            ) : null}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {node.phase} · {node.templateNodeKey} · {node.status}
            {node.deps.length > 0 ? ` · after ${node.deps.join(", ")}` : ""}
            {` · ${formatChoice(choice)}`}
            {persistedChoice(node) ? " · resolved" : ""}
          </p>
          {packet ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Packet {packet.kind}
              {packetSummary(packet.payload)
                ? ` · ${packetSummary(packet.payload)}`
                : ""}
            </p>
          ) : null}
          {node.child ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Child {node.child.status}
              {node.child.title ? ` · ${node.child.title}` : ""}
            </p>
          ) : null}
          {canOverride ? (
            <div className="mt-2">
              <SlotModelPicker
                choice={persistedChoice(node)}
                disabled={pending}
                onChange={(next) => onSetRouting(node.id, next)}
              />
            </div>
          ) : null}
        </div>
        {node.child ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpen(node.child!.id)}
          >
            Open
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function ActiveRunView({
  run,
  routing,
  pending,
  onApprovePlan,
  onApproveCorrection,
  onRetry,
  onStop,
  onSetRouting,
}: {
  run: RunDetails;
  routing: HarnessStatusDto["routing"];
  pending: boolean;
  onApprovePlan: () => void;
  onApproveCorrection: () => void;
  onRetry: () => void;
  onStop: () => void;
  onSetRouting: (nodeId: string, choice: ExecutionChoice | null) => void;
}) {
  const navigate = useBbNavigate();
  const phase = (run.currentNode?.phase ?? "explore") as Phase;
  const packetsByNode = new Map(
    run.packets.map((packet) => [packet.runNodeId, packet]),
  );
  const terminal = isTerminalRunStatus(run.status);
  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm font-medium">
        Harness · {RUN_STATUS_COPY[run.status]}
      </p>
      <p className="text-sm text-muted-foreground">{run.taskPacket.objective}</p>
      <ArcStrip phase={phase} />
      <RoutingBand phase={phase} routing={routing} engine="milestone" />
      {run.currentNode ? (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm">
          Current stage:{" "}
          <span className="font-medium">
            {ROLE_TITLE[run.currentNode.role as AgentRole] ??
              run.currentNode.role}
          </span>
          <span className="ml-2 font-mono text-xs text-muted-foreground">
            {run.currentNode.templateNodeKey}
          </span>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {run.controls.canApprovePlan ? (
          <Button size="sm" disabled={pending} onClick={onApprovePlan}>
            Approve Plan
          </Button>
        ) : null}
        {run.controls.canApproveCorrection ? (
          <Button size="sm" disabled={pending} onClick={onApproveCorrection}>
            Run Correction
          </Button>
        ) : null}
        {run.controls.canRetry ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={onRetry}
          >
            Retry
          </Button>
        ) : null}
        {run.controls.canStop ? (
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={onStop}
          >
            Stop
          </Button>
        ) : null}
      </div>
      {terminal ? (
        <p className="rounded-md border border-border px-3 py-2 text-sm">
          Run {RUN_STATUS_COPY[run.status]}. Terminal runs do not restart on
          their own.
        </p>
      ) : null}
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-3 py-2">
          <p className="text-sm font-medium">Run timeline</p>
        </div>
        <ul className="divide-y divide-border">
          {run.nodes.map((node) => (
            <RunNodeRow
              key={node.id}
              node={node}
              choice={displayChoiceForNode(
                run.nodes,
                node,
                run.taskPacket,
                routing,
              )}
              packet={packetsByNode.get(node.id)}
              current={run.currentNode?.id === node.id}
              pending={pending}
              onOpen={(childId) => navigate.toThread(childId)}
              onSetRouting={onSetRouting}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function ManualHarnessView({
  status,
  pending,
  onAdvance,
  onRewind,
  onStop,
  onStartNode,
  onCompleteNode,
  onAddWorker,
  onSetRouting,
}: {
  status: HarnessStatusDto;
  pending: boolean;
  onAdvance: () => void;
  onRewind: () => void;
  onStop: () => void;
  onStartNode: (nodeId: string) => void;
  onCompleteNode: (nodeId: string) => void;
  onAddWorker: (title: string) => void;
  onSetRouting: (nodeId: string, choice: ExecutionChoice | null) => void;
}) {
  const navigate = useBbNavigate();
  const [workerTitle, setWorkerTitle] = useState("");
  const plan = status.plan;
  const phase = status.arc.phase;
  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm font-medium">
        Harness · {status.harness?.name ?? "Standard Harness"}
      </p>
      <p className="text-sm text-muted-foreground">{status.arc.note || status.harness?.description}</p>
      <ArcStrip phase={phase} />
      <RoutingBand phase={phase} routing={status.routing} engine="manual" />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending} onClick={onAdvance}>
          Advance
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={onRewind}>
          Rewind
        </Button>
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
                    : node.status === "in_progress"
                      ? "[>]"
                      : node.status === "skipped"
                        ? "[-]"
                        : "[ ]"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{node.title}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {node.phase} · {node.id} · {node.status}
                    {` · ${formatChoice(persistedPlanChoice(node) ?? status.routing[routingSlotFor(node.phase, 0)])}`}
                  </p>
                  {node.child ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Child {node.child.status}
                      {node.child.title ? ` · ${node.child.title}` : ""}
                    </p>
                  ) : !isSpawnablePhase(node.phase) ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Stays on the parent thread
                    </p>
                  ) : null}
                  {node.status === "pending" || node.status === "in_progress" ? (
                    <div className="mt-2">
                      <SlotModelPicker
                        choice={persistedPlanChoice(node)}
                        disabled={pending}
                        onChange={(next) => onSetRouting(node.id, next)}
                      />
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1">
                  {node.status === "pending" || (node.status === "in_progress" && !node.childThreadId) ? (
                    <Button size="sm" disabled={pending} onClick={() => onStartNode(node.id)}>
                      Start
                    </Button>
                  ) : null}
                  {node.status === "in_progress" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => onCompleteNode(node.id)}
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
  const { rpc, status, error, pending, run, refetch } = useHarness(threadId, projectId);
  const live = status?.run ? isLiveRunStatus(status.run.status) : false;
  const manual = Boolean(status?.harness && status.harness.engine === "manual" && !status.run);

  const startForm = (
    <StartHarnessForm
      pending={pending}
      customHarnesses={status?.customHarnesses ?? []}
      onRefresh={refetch}
      onStart={(input) => {
        void run(() =>
          rpc.call("startRun", {
            threadId: threadId!,
            projectId: projectId ?? undefined,
            ...input,
          }),
        );
      }}
    />
  );

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">
          Ordinary chats stay ordinary until you start a Harness run. Then
          isolate Explore, Plan, Worker, Critic, and Promote — one node at a
          time. Standard Harness is the default. Milestone Pipeline is optional.
          Auditable output lives in <code>artifacts/</code>.
        </p>

        {!threadId ? (
          <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Open a thread to start a Harness run.
          </div>
        ) : !status ? (
          <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Loading harness…
          </div>
        ) : (
          <>
            {status.run ? (
              <ActiveRunView
                run={status.run}
                routing={status.routing}
                pending={pending}
                onApprovePlan={() => {
                  void run(() =>
                    rpc.call("approvePlan", {
                      threadId,
                      projectId: projectId ?? undefined,
                    }),
                  );
                }}
                onApproveCorrection={() => {
                  void run(() =>
                    rpc.call("approveCorrection", {
                      threadId,
                      projectId: projectId ?? undefined,
                    }),
                  );
                }}
                onRetry={() => {
                  void run(() =>
                    rpc.call("retryStage", {
                      threadId,
                      projectId: projectId ?? undefined,
                    }),
                  );
                }}
                onStop={() => {
                  void run(() =>
                    rpc.call("stopRun", {
                      threadId,
                      projectId: projectId ?? undefined,
                    }),
                  );
                }}
                onSetRouting={(nodeId, choice) => {
                  void run(() =>
                    rpc.call("setRunNodeRouting", {
                      threadId,
                      projectId: projectId ?? undefined,
                      nodeId,
                      choice,
                    }),
                  );
                }}
              />
            ) : manual ? (
              <ManualHarnessView
                status={status}
                pending={pending}
                onAdvance={() => {
                  void run(() =>
                    rpc.call("advance", {
                      threadId,
                      projectId: projectId ?? undefined,
                    }),
                  );
                }}
                onRewind={() => {
                  void run(() =>
                    rpc.call("rewind", {
                      threadId,
                      projectId: projectId ?? undefined,
                    }),
                  );
                }}
                onStop={() => {
                  void run(() =>
                    rpc.call("stopRun", {
                      threadId,
                      projectId: projectId ?? undefined,
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
                    }),
                  );
                }}
                onCompleteNode={(nodeId) => {
                  if (!status.plan) return;
                  void run(() =>
                    rpc.call("completeNode", {
                      planId: status.plan!.id,
                      nodeId,
                    }),
                  );
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
                    }),
                  );
                }}
              />
            ) : (
              <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-5">
                <p className="text-sm font-medium">Harness is inactive</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Starting requires an explicit task. No arc, banner, or role
                  child is created until you start.
                </p>
                {startForm}
              </div>
            )}
            {status.run && !live ? startForm : null}
          </>
        )}

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
  const run = status?.run;
  if (run && isLiveRunStatus(run.status)) {
    const role = run.currentNode
      ? ROLE_TITLE[run.currentNode.role as AgentRole]
      : null;
    const next = role ? ` · ${role}` : "";
    return (
      <p className="px-1 text-xs text-muted-foreground">
        Harness · {PHASE_COPY[status.arc.phase].label}
        {next}
      </p>
    );
  }
  if (status?.harness?.engine === "manual") {
    return (
      <p className="px-1 text-xs text-muted-foreground">
        Harness · {PHASE_COPY[status.arc.phase].label}
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
