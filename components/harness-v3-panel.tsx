// Harness v3 panel — one obvious primary action at a time, BB-native surfaces.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Markdown,
  ThreadChat,
  experimental_FileLink as FileLink,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Loose local types so the panel stays resilient to RPC shape drift.
type V3Node = {
  id: string;
  title: string;
  objective: string;
  dependencies: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  expectedArtifacts: string[];
  skillHints: string[];
  status: string;
  attemptId: string | null;
  routingOverride: { providerId: string; model: string; reasoningLevel: string } | null;
};
type V3ReportSummary = { summary: string };
type V3WorkerView = {
  nodeId: string;
  attemptId: string | null;
  outcome: string;
  summary: string;
  changedFiles: string[];
  acceptanceResults: Array<{ criterion: string; met: boolean; note: string }>;
  commands: Array<{ command: string; exitCode: number | null; output: string }>;
  artifactRefs: string[];
  risks: string[];
};
type V3CriticView = {
  recommendation: string;
  findings: Array<{ severity: string; title: string; detail: string }>;
  affectedNodeIds: string[];
  checksRerun: Array<{ command: string; exitCode: number | null; note: string }>;
  unsupportedClaims: string[];
  risks: string[];
};
type V3RunView = {
  run: {
    id: string;
    homeThreadId: string;
    objective: string;
    state: string;
    revision: number;
    planRevision: number;
    environmentId?: string | null;
    plannerThreadId: string | null;
    explorerThreadId: string | null;
    criticThreadId: string | null;
    promoterThreadId: string | null;
    activeWorkerNodeId: string | null;
    activeWorkerThreadId: string | null;
    preset: { roles: Record<string, { choice: { providerId: string; model: string; reasoningLevel: string } | null }> };
  } | null;
  nodes: V3Node[];
  nextNode: V3Node | null;
  doneCount: number;
  totalCount: number;
  stateCopy: { title: string; body: string; primary: string };
  skillWarnings: string[];
  providerWarnings: string[];
  decisions: Array<{ id: string; kind: string; actor: string; reason: string | null; createdAt?: number }>;
  artifacts: Array<{ path: string; kind: string; nodeId: string | null }>;
  currentReviewApproved?: boolean;
  promotionSkipped?: boolean;
  failedRoles?: Array<{ role: string; nodeId: string | null }>;
  exportWarnings?: string[];
  nextNodeRouting?: { choice: { providerId: string; model: string; reasoningLevel: string; serviceTier?: "default" | "fast" } | null; source: string } | null;
  evaluation: { outcome: string | null; reworkCount: number; acceptedAttempts: number; failedAttempts: number; elapsedMs: number | null; note: string | null } | null;
  latestReports?: {
    exploration: ({ summary: string; findings: string[]; risks: string[] } & V3ReportSummary) | null;
    worker: V3WorkerView[];
    critic: V3CriticView | null;
    promotion: { audience: string; channel: string; summary: string; claims: string[]; limitations: string[] } | null;
  };
};

type ChatRun = NonNullable<V3RunView["run"]>;

/** Chat follows the current state — never a stale priority order. */
export function selectChatThread(run: ChatRun | null): string | null {
  if (!run) return null;
  switch (run.state) {
    case "Exploring":
      return run.explorerThreadId ?? run.plannerThreadId;
    case "Planning":
    case "PlanApproval":
      return run.plannerThreadId;
    case "Executing":
    case "WorkerReview":
      return run.activeWorkerThreadId ?? run.plannerThreadId;
    case "Critiquing":
    case "FinalReview":
      return run.criticThreadId ?? run.plannerThreadId;
    case "Promoting":
      return run.promoterThreadId ?? run.plannerThreadId;
    case "Blocked":
      return run.plannerThreadId;
    default:
      return null;
  }
}

/** Workspace file target for an exported artifact (run-owned environment). */
export function artifactTarget(run: ChatRun, path: string): { kind: "workspace"; environmentId: string; path: string } {
  return { kind: "workspace", environmentId: run.environmentId ?? "", path };
}

function useV3(threadId: string | null, projectId: string | null) {
  const rpc = useRpc();
  const connection = useRealtimeConnectionState();
  const prev = useRef(connection);
  const seq = useRef(0);
  const [status, setStatus] = useState<{ threadId: string; value: V3RunView } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refetch = useCallback(() => {
    if (!threadId) {
      seq.current += 1;
      setStatus(null);
      setError(null);
      return;
    }
    const id = ++seq.current;
    (rpc.call as (m: string, i: unknown) => Promise<unknown>)("v3Status", { threadId, projectId: projectId ?? undefined }).then(
      (result) => {
        if (id !== seq.current) return;
        setStatus({ threadId, value: result as V3RunView });
        setError(null);
      },
      (cause: unknown) => {
        // Missing method or no run: treat as inactive, keep legacy panel functional.
        if (id !== seq.current) return;
        const msg = cause instanceof Error ? cause.message : String(cause);
        if (/unknown|not found|no method/i.test(msg)) {
          setStatus({ threadId, value: { run: null, nodes: [], nextNode: null, doneCount: 0, totalCount: 0, stateCopy: { title: "Harness is inactive", body: "Ordinary BB chat is the correct path for small, clear work.", primary: "Start Harness" }, skillWarnings: [], providerWarnings: [], decisions: [], artifacts: [], evaluation: null } });
          setError(null);
        } else {
          setError(msg);
        }
      },
    );
  }, [rpc, threadId, projectId]);

  useEffect(() => {
    setError(null);
    refetch();
  }, [refetch]);
  useRealtime("harness", refetch);
  useEffect(() => {
    const was = prev.current;
    prev.current = connection;
    if (was !== "connected" && connection === "connected") refetch();
  }, [connection, refetch]);

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      setPending(true);
      try {
        await work();
        refetch();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPending(false);
      }
    },
    [refetch],
  );

  const visible = threadId && status?.threadId === threadId ? status.value : null;
  return { rpc, status: visible, error, pending, run, refetch };
}

function reqId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, stripUndefined(v)]),
    );
  }
  return value;
}

function PhaseStepper({ state }: { state: string }) {
  const steps = ["Exploring", "Planning", "Building", "Review", "Share", "Done"];
  const map: Record<string, number> = {
    Exploring: 0, Planning: 1, PlanApproval: 1, Executing: 2, WorkerReview: 2, Critiquing: 3, FinalReview: 3, Promoting: 4, Complete: 5, Done: 5, Blocked: 3, Cancelled: 5,
  };
  const active = map[state] ?? 0;
  return (
    <ol aria-label="Harness progress" className="grid grid-cols-6 gap-1">
      {steps.map((label, i) => (
        <li key={label}>
          <div className={cn("flex flex-col items-center gap-1 rounded-md px-1 py-2 text-center", i === active ? "bg-foreground text-background" : "bg-transparent")}>
            <span aria-hidden className={cn("size-2.5 rounded-full", i === active ? "bg-background" : i < active ? "bg-foreground" : "bg-border")} />
            <span className="text-[11px] font-medium leading-none">{label}</span>
            <span className="sr-only">{i === active ? "(current)" : i < active ? "(done)" : "(upcoming)"}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function NodeList({ nodes }: { nodes: V3Node[] }) {
  if (nodes.length === 0) return <p className="text-sm text-muted-foreground">No tasks yet. Planner will propose a DAG.</p>;
  return (
    <ul aria-label="Work tasks" className="divide-y divide-border rounded-lg border border-border">
      {nodes.map((n) => (
        <li key={n.id} className="px-3 py-2">
          <p className="truncate text-sm font-medium" title={n.title}>
            <span aria-hidden className="mr-2 font-mono text-xs text-muted-foreground">
              {n.status === "done" ? "[x]" : n.status === "running" || n.status === "awaiting_review" ? "[>]" : n.status === "skipped" ? "[-]" : "[ ]"}
            </span>
            {n.title}
            <span className="sr-only">, status {n.status}</span>
          </p>
          <p className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">{n.objective}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {n.status} · deps: {n.dependencies.join(", ") || "none"} · {n.acceptanceCriteria.length} checks
            {n.routingOverride ? ` · override ${n.routingOverride.providerId}/${n.routingOverride.model}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}

function ExplorationView({ report }: { report: NonNullable<NonNullable<V3RunView["latestReports"]>["exploration"]> }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <h3 className="text-sm font-medium">Explorer report</h3>
      <Markdown content={report.summary} />
      {report.findings.length > 0 ? (
        <ul className="mt-1 list-disc pl-5 text-[12px] text-muted-foreground">
          {report.findings.slice(0, 6).map((f, i) => <li key={i}>{f}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

function WorkerReportView({ report, title }: { report: V3WorkerView; title?: string }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <h3 className="text-sm font-medium">{title ?? `Worker report · ${report.nodeId}`} · {report.outcome}</h3>
      <Markdown content={report.summary} />
      {report.acceptanceResults.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-[12px]">
          {report.acceptanceResults.map((a, i) => (
            <li key={i} className="text-muted-foreground">
              [{a.met ? "x" : " "}] {a.criterion}{a.note ? ` — ${a.note}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {report.commands.length > 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Checks: {report.commands.map((c) => `\`${c.command}\` → ${c.exitCode ?? "?"}`).join(" · ")}
        </p>
      ) : null}
      {report.risks.length > 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground">Risks: {report.risks.join("; ")}</p>
      ) : null}
    </div>
  );
}

function CriticReportView({ report }: { report: NonNullable<NonNullable<V3RunView["latestReports"]>["critic"]> }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <h3 className="text-sm font-medium">Critic recommends {report.recommendation}</h3>
      {report.findings.length > 0 ? (
        <ul className="mt-1 space-y-1 text-[12px] text-muted-foreground">
          {report.findings.slice(0, 8).map((f, i) => (
            <li key={i}>[{f.severity}] {f.title}{f.detail ? ` — ${f.detail}` : ""}</li>
          ))}
        </ul>
      ) : null}
      {report.affectedNodeIds.length > 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground">Affected: {report.affectedNodeIds.join(", ")}</p>
      ) : null}
      {report.checksRerun.length > 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Reran: {report.checksRerun.map((c) => `\`${c.command}\` → ${c.exitCode ?? "?"}`).join(" · ")}
        </p>
      ) : null}
      {report.unsupportedClaims.length > 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground">Unsupported: {report.unsupportedClaims.join("; ")}</p>
      ) : null}
    </div>
  );
}

function OverrideEditor({
  run,
  node,
  routing,
  pending,
  onChange,
}: {
  run: NonNullable<V3RunView["run"]>;
  node: V3Node;
  routing: NonNullable<NonNullable<V3RunView["nextNodeRouting"]>>;
  pending: boolean;
  onChange: (choice: { providerId: string; model: string; reasoningLevel: string; serviceTier?: "default" | "fast" } | null) => void;
}) {
  // Local draft so opening the picker never writes an override before the
  // operator picks a real provider/model. Hooks stay above all branches.
  const [drafting, setDrafting] = useState(false);
  const editable = node.status === "pending" || node.status === "ready" || node.status === "invalidated";
  const shown = routing.choice ?? (drafting ? { providerId: "", model: "", reasoningLevel: "medium" } : null);
  // Claimed nodes lock their routing; only the next pending node is editable.
  if (!editable) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Model locked{routing.choice ? ` to ${routing.choice.providerId}/${routing.choice.model}` : ""} ({routing.source}).
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">
        Next task model · source: {routing.source}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {shown ? (
          <>
            <ProviderModelPicker
              value={shown as never}
              disabled={pending}
              onChange={(v) => {
                setDrafting(false);
                onChange(v as unknown as NonNullable<typeof routing.choice>);
              }}
              routing={run.environmentId ? { kind: "environment", environmentId: run.environmentId } : undefined}
            />
            {routing.choice ? (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => onChange(null)}>Revert to preset</Button>
            ) : (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDrafting(false)}>Cancel</Button>
            )}
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">Inherits preset / parent thread</p>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setDrafting(true)}>
              Override for this node
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function PromotionView({ report }: { report: NonNullable<NonNullable<V3RunView["latestReports"]>["promotion"]> }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <h3 className="text-sm font-medium">Promotion · {report.channel || "unspecified channel"}</h3>
      <Markdown content={report.summary} />
      {report.limitations.length > 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground">Limitations: {report.limitations.join("; ")}</p>
      ) : null}
    </div>
  );
}

export function HarnessV3Panel({ threadId: propThreadId }: { threadId?: string | null }) {
  const ctx = useBbContext();
  const threadId = propThreadId ?? ctx.threadId;
  const projectId = ctx.projectId;
  const navigate = useBbNavigate();
  const { rpc, status, error, pending, run } = useV3(threadId, projectId);
  const [task, setTask] = useState("");
  const [presetId, setPresetId] = useState("");
  const [presets, setPresets] = useState<Array<{ id: string; name: string }>>([]);
  const [reason, setReason] = useState("");
  const [reworkNodes, setReworkNodes] = useState<string[]>([]);
  const [audience, setAudience] = useState("");
  const [channel, setChannel] = useState("");
  const [skipReason, setSkipReason] = useState("");
  const [newTask, setNewTask] = useState("");

  useEffect(() => {
    (rpc.call as (m: string, i: unknown) => Promise<unknown>)("v3PresetList", projectId ? { projectId } : {}).then(
      (r) => setPresets(((r as { presets: Array<{ id: string; name: string }> }).presets ?? []).map((p) => ({ id: p.id, name: p.name }))),
      () => setPresets([]),
    );
  }, [rpc, projectId]);

  // The RPC layer requires strict JSON: omit undefined fields (including
  // nested ones) instead of sending them explicitly.
  const call = (method: string, input: Record<string, unknown>) =>
    run(() => (rpc.call as (m: string, i: unknown) => Promise<unknown>)(method, stripUndefined(input)));

  if (!threadId) {
    return <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Open a thread to use Harness.</div>;
  }
  if (!status) {
    return <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Loading Harness v3…</div>;
  }

  const chatThreadId = selectChatThread(status.run);
  const reports = status.latestReports;
  // Backend-derived freshness; fall back to any-approval for older servers.
  const approved = status.currentReviewApproved ?? status.decisions.some((d) => d.kind === "critic_approved");
  const skipped = status.promotionSkipped ?? false;
  const activeNode = status.run?.activeWorkerNodeId
    ? status.nodes.find((n) => n.id === status.run!.activeWorkerNodeId) ?? null
    : null;
  // Never show stale evidence: the report must belong to the live attempt.
  const activeWorkerReport = activeNode
    ? reports?.worker.find((w) => w.nodeId === activeNode.id && w.attemptId != null && w.attemptId === activeNode.attemptId) ?? null
    : null;
  const dagTerminal = status.run != null && status.totalCount > 0 && status.doneCount === status.totalCount && !status.nextNode;
  const canComplete =
    status.run != null &&
    (status.run.state === "FinalReview" || status.run.state === "Promoting") &&
    approved &&
    (status.run.state !== "Promoting" || reports?.promotion != null);

  const primaryAction = (): React.ReactNode => {
    if (!status.run) {
      const canStart = task.trim() !== "" && !pending;
      // Omit unset fields: the RPC layer rejects undefined as non-JSON.
      const startInput: Record<string, unknown> = { threadId, objective: task.trim() };
      if (projectId) startInput.projectId = projectId;
      if (presetId) startInput.presetId = presetId;
      return (
        <Button disabled={!canStart} onClick={() => void call("v3Start", startInput)}>
          Start v3 Harness
        </Button>
      );
    }
    const rev = status.run.revision;
    const hasExplorerReport = reports?.exploration != null;
    switch (status.run.state) {
      case "Exploring":
        // Accept unlocks only when a report exists; rerun is hidden while a
        // child is active (use Stop first); Skip always needs a reason.
        return (
          <div className="flex flex-wrap gap-2">
            {!status.run.explorerThreadId && !hasExplorerReport ? (
              <Button size="sm" disabled={pending} onClick={() => void call("v3RunExplorer", { threadId, projectId: projectId ?? undefined })}>Run Explorer</Button>
            ) : null}
            {status.run.explorerThreadId && !hasExplorerReport ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void call("v3StopRole", { threadId, projectId: projectId ?? undefined, role: "explorer", expectedRevision: rev, requestId: reqId() })}>Stop Explorer</Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={pending || !hasExplorerReport} onClick={() => void call("v3AcceptExploration", { threadId, projectId: projectId ?? undefined, expectedRevision: rev, requestId: reqId() })}>Accept exploration</Button>
          </div>
        );
      case "PlanApproval":
        return (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending} onClick={() => void call("v3ApprovePlan", { threadId, projectId: projectId ?? undefined, expectedRevision: rev, requestId: reqId() })}>Approve plan</Button>
            <Button size="sm" variant="outline" disabled={pending || !reason.trim()} onClick={() => void call("v3RequestPlanRevision", { threadId, projectId: projectId ?? undefined, reason: reason.trim(), expectedRevision: rev, requestId: reqId() })}>Request revision</Button>
          </div>
        );
      case "Executing":
        if (dagTerminal) {
          return <Button size="sm" disabled={pending} onClick={() => void call("v3StartCritic", { threadId, projectId: projectId ?? undefined, expectedRevision: rev, requestId: reqId() })}>Start Critic</Button>;
        }
        return <Button size="sm" disabled={pending || !status.nextNode} aria-label={!status.nextNode ? "No ready tasks — dependencies may be blocked" : "Run next task"} onClick={() => void call("v3RunNextWorker", { threadId, projectId: projectId ?? undefined, expectedRevision: rev, requestId: reqId() })}>Run next task</Button>;
      case "WorkerReview": {
        const nodeId = status.run.activeWorkerNodeId;
        if (!nodeId) return null;
        // Accept is only meaningful for a complete report on the live
        // attempt. Blocked/plan-change evidence routes to Request changes so
        // the operator never discovers that via a server error.
        const acceptable = activeWorkerReport?.outcome === "complete";
        return (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={pending || !acceptable} onClick={() => void call("v3ReviewWorker", { threadId, projectId: projectId ?? undefined, nodeId, approve: true, expectedRevision: rev, requestId: reqId() })}>Accept worker</Button>
              <Button size="sm" variant="outline" disabled={pending || !reason.trim()} onClick={() => void call("v3ReviewWorker", { threadId, projectId: projectId ?? undefined, nodeId, approve: false, changes: reason.trim(), expectedRevision: rev, requestId: reqId() })}>Request changes</Button>
            </div>
            {!acceptable ? (
              <p className="text-[11px] text-muted-foreground">
                {activeWorkerReport
                  ? `Worker reported “${activeWorkerReport.outcome}” — describe the needed changes and use Request changes.`
                  : "Waiting for the Worker report for this attempt…"}
              </p>
            ) : null}
          </div>
        );
      }
      case "Critiquing":
        return <Button size="sm" variant="outline" disabled={pending} onClick={() => void call("v3StartCritic", { threadId, projectId: projectId ?? undefined, expectedRevision: rev, requestId: reqId() })}>Start Critic</Button>;
      case "FinalReview":
        // One decision per Critic report: once approved, the decision buttons
        // hide and only share controls remain.
        if (status.currentReviewApproved) return null;
        return (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending || !reason.trim()} onClick={() => void call("v3ReviewCritic", { threadId, projectId: projectId ?? undefined, decision: "APPROVE", reason: reason.trim(), expectedRevision: rev, requestId: reqId() })}>Approve</Button>
            <Button size="sm" variant="outline" disabled={pending || reworkNodes.length === 0 || !reason.trim()} onClick={() => void call("v3ReviewCritic", { threadId, projectId: projectId ?? undefined, decision: "REWORK", nodeIds: reworkNodes, reason: reason.trim(), expectedRevision: rev, requestId: reqId() })}>Rework selected</Button>
            <Button size="sm" variant="destructive" disabled={pending || !reason.trim()} onClick={() => void call("v3ReviewCritic", { threadId, projectId: projectId ?? undefined, decision: "BLOCK", reason: reason.trim(), expectedRevision: rev, requestId: reqId() })}>Block</Button>
          </div>
        );
      case "Promoting":
        return <p className="text-sm text-muted-foreground">Promoter is preparing communication. Complete when accepted.</p>;
      case "Blocked":
        return <Button size="sm" variant="outline" disabled={pending} onClick={() => void call("v3RetryRole", { threadId, projectId: projectId ?? undefined, role: "critic", expectedRevision: rev, requestId: reqId() })}>Retry</Button>;
      default:
        return null;
    }
  };

  return (
    <div className="mt-4 space-y-3" aria-live="polite">
      {!status.run ? (
        <div className="rounded-lg border border-border px-4 py-5">
          <h2 className="text-sm font-medium">Harness v3 (article-aligned arc)</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Planner-led orchestration with an explicit implementation DAG, versioned task packets, and operator gates.
          </p>
          <label className="mt-3 block text-sm font-medium" htmlFor="v3-task">Task</label>
          <textarea
            id="v3-task"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="What should this Harness accomplish?"
            rows={3}
            className="mt-1 flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          />
          <label className="mt-3 block text-sm font-medium" htmlFor="v3-preset">Role preset</label>
          <select id="v3-preset" value={presetId} onChange={(e) => setPresetId(e.target.value)} className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm">
            <option value="">Inherit parent (default)</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-muted-foreground">Artifacts export to <code>artifacts/harness/&lt;run-id&gt;/</code>. Database state stays authoritative.</p>
          <div className="mt-3">{primaryAction()}</div>
        </div>
      ) : (
        <>
          <div>
            <h2 className="truncate text-sm font-medium" title={status.run.objective}>{status.run.objective}</h2>
            <PhaseStepper state={status.run.state} />
          </div>
          <p className="text-sm text-muted-foreground">{status.stateCopy.body}</p>
          {status.run.state === "Executing" || status.run.state === "WorkerReview" ? (
            <p role="status" className="text-[12px] text-muted-foreground">{status.doneCount}/{status.totalCount} tasks complete{status.nextNode ? ` · next: ${status.nextNode.title}` : ""}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">{primaryAction()}</div>
          {status.providerWarnings.map((w) => (
            <p key={w} role="alert" className="text-[12px] text-destructive">{w} <Button size="sm" variant="outline" onClick={() => navigate.openThreadPanel({ actionId: "arc", title: "Harness" })}>Repair routing</Button></p>
          ))}
          {status.skillWarnings.map((w) => (
            <p key={w} className="text-[11px] text-muted-foreground">{w}</p>
          ))}
          {status.run.state === "Exploring" && status.run.explorerThreadId && !reports?.exploration ? (
            <p className="text-[12px] text-muted-foreground">Explorer is working… Accept unlocks when its report lands.</p>
          ) : null}
          {(status.run.state === "Exploring" || status.run.state === "Planning") && reports?.exploration ? (
            <ExplorationView report={reports.exploration} />
          ) : null}
          {status.run.state === "Exploring" ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="block text-[12px] text-muted-foreground" htmlFor="v3-skip">Skip exploration (reason required)
                <input id="v3-skip" value={skipReason} onChange={(e) => setSkipReason(e.target.value)} placeholder="Why skip?" className="mt-1 flex h-9 w-full min-w-52 rounded-md border border-input bg-transparent px-3 text-sm" />
              </label>
              <Button size="sm" variant="outline" disabled={pending || !skipReason.trim()} onClick={() => void call("v3SkipExploration", { threadId, projectId: projectId ?? undefined, reason: skipReason.trim(), expectedRevision: status.run!.revision, requestId: reqId() })}>Skip exploration</Button>
            </div>
          ) : null}
          {(status.failedRoles?.length ?? 0) > 0 ? (
            <div className="rounded-lg border border-border px-3 py-2" role="alert">
              <h3 className="text-sm font-medium">Recovery needed</h3>
              <ul className="mt-1 space-y-1">
                {status.failedRoles!.map((f) => (
                  <li key={`${f.role}-${f.nodeId ?? "-"}`} className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                    <span>{f.role}{f.nodeId ? ` (${f.nodeId})` : ""} failed.</span>
                    {f.role === "worker" ? (
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => void call("v3RunNextWorker", { threadId, projectId: projectId ?? undefined, expectedRevision: status.run!.revision, requestId: reqId() })}>Retry worker</Button>
                    ) : (
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => void call("v3RetryRole", { threadId, projectId: projectId ?? undefined, role: f.role, nodeId: f.nodeId ?? undefined, expectedRevision: status.run!.revision, requestId: reqId() })}>Retry {f.role}</Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {(status.exportWarnings?.length ?? 0) > 0 ? (
            <div className="rounded-lg border border-border px-3 py-2" role="alert">
              <h3 className="text-sm font-medium">Artifact export pending</h3>
              <ul className="mt-1 space-y-0.5 text-[12px] text-muted-foreground">
                {status.exportWarnings!.map((w) => <li key={w}>{w}</li>)}
              </ul>
              <div className="mt-2">
                <Button size="sm" variant="outline" disabled={pending} onClick={() => void call("v3RetryExport", { threadId, projectId: projectId ?? undefined, expectedRevision: status.run!.revision, requestId: reqId() })}>Retry export</Button>
              </div>
            </div>
          ) : null}
          {status.run.state === "WorkerReview" && activeWorkerReport ? (
            <WorkerReportView report={activeWorkerReport} />
          ) : null}
          {status.run.state === "WorkerReview" && !activeWorkerReport ? (
            <p className="text-[12px] text-muted-foreground">Waiting for the Worker report…</p>
          ) : null}
          {(status.run.state === "Critiquing" || status.run.state === "FinalReview") && reports?.critic ? (
            <CriticReportView report={reports.critic} />
          ) : null}
          {status.run.state === "Critiquing" && !reports?.critic ? (
            <p className="text-[12px] text-muted-foreground">Critic is reviewing. Its recommendation will appear here.</p>
          ) : null}
          {(status.run.state === "Executing" || status.run.state === "WorkerReview") && status.nextNode && status.nextNodeRouting ? (
            <OverrideEditor
              run={status.run}
              node={status.nextNode}
              routing={status.nextNodeRouting}
              pending={pending}
              onChange={(choice) => void call("v3SetNodeRouting", { threadId, projectId: projectId ?? undefined, nodeId: status.nextNode!.id, choice, expectedRevision: status.run!.revision, requestId: reqId() })}
            />
          ) : null}
          {status.run.state === "FinalReview" && approved && !skipped ? (
            <div className="rounded-lg border border-border px-3 py-2">
              <h3 className="text-sm font-medium">Share (optional)</h3>
              <p className="text-[12px] text-muted-foreground">Critic approved. Start Promoter or skip communication.</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="block text-[12px] text-muted-foreground" htmlFor="v3-audience">Audience
                  <input id="v3-audience" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="team, review…" className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" />
                </label>
                <label className="block text-[12px] text-muted-foreground" htmlFor="v3-channel">Channel
                  <input id="v3-channel" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="notes, chat…" className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" />
                </label>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" disabled={pending} onClick={() => void call("v3Promote", { threadId, projectId: projectId ?? undefined, start: true, audience: audience || undefined, channel: channel || undefined, expectedRevision: status.run!.revision, requestId: reqId() })}>Start Promoter</Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => void call("v3Promote", { threadId, projectId: projectId ?? undefined, start: false, expectedRevision: status.run!.revision, requestId: reqId() })}>Skip communication</Button>
              </div>
            </div>
          ) : null}
          {status.run.state === "Promoting" && reports?.promotion ? (
            <PromotionView report={reports.promotion} />
          ) : null}
          {status.run.state === "Promoting" && !reports?.promotion ? (
            <p className="text-[12px] text-muted-foreground">Promoter is preparing communication. Completion unlocks when its report lands.</p>
          ) : null}
          {chatThreadId ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="border-b border-border px-3 py-2">
                <p className="text-sm font-medium">Working conversation</p>
              </div>
              <div className="h-72">
                <ThreadChat threadId={chatThreadId} variant="compact" layout="contained" />
              </div>
              <div className="flex gap-2 border-t border-border px-3 py-2">
                <Button size="sm" variant="ghost" onClick={() => navigate.toThread(chatThreadId)}>Open thread</Button>
              </div>
            </div>
          ) : null}
          {(status.run.state === "PlanApproval" || status.run.state === "Executing" || status.run.state === "WorkerReview" || status.run.state === "FinalReview") ? (
            <div>
              <h3 className="mb-1 text-sm font-medium">Implementation tasks</h3>
              <NodeList nodes={status.nodes} />
              {status.run.state === "FinalReview" && !approved ? (
                <fieldset className="mt-2">
                  <legend className="text-[12px] text-muted-foreground">Rework targets</legend>
                  <div className="flex flex-wrap gap-2">
                    {status.nodes.map((n) => (
                      <label key={n.id} className="flex items-center gap-1 text-[12px]">
                        <input
                          type="checkbox"
                          checked={reworkNodes.includes(n.id)}
                          onChange={(e) => setReworkNodes((cur) => (e.target.checked ? [...cur, n.id] : cur.filter((x) => x !== n.id)))}
                        />
                        {n.id}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              <label className="mt-2 block text-[12px] text-muted-foreground" htmlFor="v3-reason">Reason / changes (required for revision, changes, decisions)</label>
              <input id="v3-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason…" className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" />
            </div>
          ) : null}
          {status.decisions.length > 0 ? (
            <div>
              <h3 className="mb-1 text-sm font-medium">Decisions</h3>
              <ul className="space-y-1">
                {status.decisions.map((d) => (
                  <li key={d.id} className="text-[12px] text-muted-foreground">{d.kind} · {d.actor}{d.reason ? ` · ${d.reason}` : ""}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {status.artifacts.length > 0 ? (
            <div>
              <h3 className="mb-1 text-sm font-medium">Artifacts</h3>
              <ul className="space-y-1">
                {status.artifacts.slice(0, 12).map((a) => (
                  <li key={a.path} className="text-[12px]">
                    <FileLink target={artifactTarget(status.run!, a.path)}>{a.path}</FileLink>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {status.run.state === "FinalReview" && skipped ? (
            <p className="text-[12px] text-muted-foreground">Communication skipped. Mark complete when ready.</p>
          ) : null}
          {(status.run.state === "Complete" || status.run.state === "Cancelled") ? (
            <div className="rounded-lg border border-border px-3 py-2">
              <h3 className="text-sm font-medium">Start another run</h3>
              <p className="text-[12px] text-muted-foreground">This run is terminal. A fresh run starts clean.</p>
              <label className="mt-2 block text-[12px] text-muted-foreground" htmlFor="v3-task-again">Task
                <input id="v3-task-again" value={newTask} onChange={(e) => setNewTask(e.target.value)} placeholder="Next task…" className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" />
              </label>
              <div className="mt-2">
                <Button size="sm" disabled={pending || !newTask.trim()} onClick={() => {
                  const again: Record<string, unknown> = { threadId, objective: newTask.trim() };
                  if (projectId) again.projectId = projectId;
                  if (presetId) again.presetId = presetId;
                  void call("v3Start", again);
                }}>Start v3 Harness</Button>
              </div>
            </div>
          ) : null}
          {status.run.state === "Complete" && status.evaluation ? (
            <div className="rounded-lg border border-border px-3 py-2">
              <h3 className="text-sm font-medium">Run evaluation</h3>
              <p className="text-[12px] text-muted-foreground">
                {status.evaluation.outcome ?? "unrated"} · rework {status.evaluation.reworkCount} · accepted {status.evaluation.acceptedAttempts} · failed {status.evaluation.failedAttempts}
              </p>
            </div>
          ) : null}
          <details>
            <summary className="cursor-pointer text-[12px] text-muted-foreground">Audit details</summary>
            <div className="mt-1 space-y-1 text-[11px] text-muted-foreground">
              <p>Run {status.run.id} · plan rev {status.run.planRevision} · {status.run.state}</p>
              <p>Planner {status.run.plannerThreadId ?? "—"} · Explorer {status.run.explorerThreadId ?? "—"} · Critic {status.run.criticThreadId ?? "—"} · Promoter {status.run.promoterThreadId ?? "—"}</p>
              <p>Active worker: {status.run.activeWorkerNodeId ?? "none"} · decisions: {status.decisions.length} · worker reports: {reports?.worker.length ?? 0}</p>
            </div>
          </details>
          <div className="flex flex-wrap gap-2">
            {status.run.state !== "Complete" && status.run.state !== "Cancelled" ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => {
                  if (!window.confirm(`Cancel Harness "${status.run!.objective}"? Active role threads will be stopped first.`)) return;
                  void call("v3Cancel", { threadId, projectId: projectId ?? undefined, reason: "Operator cancelled from panel.", expectedRevision: status.run!.revision, requestId: reqId() });
                }}
              >
                Cancel run
              </Button>
            ) : null}
            {canComplete ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void call("v3Complete", { threadId, projectId: projectId ?? undefined, expectedRevision: status.run!.revision, requestId: reqId() })}>Mark complete</Button>
            ) : null}
          </div>
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
