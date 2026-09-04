/**
 * v3 backend — article-aligned Harness Arc.
 *
 * Self-contained so legacy server.ts stays regression-safe. Uses only public
 * BB SDK surfaces (threads, environments, files, providers, skills,
 * projects). Database state is authoritative; workspace files are exports.
 */
import { createHash, randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  V3_RUN_STATES,
  type V3Role,
  type V3RolePreset,
  type V3RunState,
  type V3WorkNode,
} from "./v3/types";
import { V3_ROLES } from "./v3/types";
import { allRequiredDone, assignV3NodeIds, downstreamV3, readyV3Nodes, validateV3Draft, wouldCycleV3 } from "./v3/dag";
import { assertTransitionV3, v3StateCopy } from "./v3/state";
import { buildTaskPacket, slicePacketForRole } from "./v3/packets";
import { validateCriticReport, validateExplorationReport, validatePromotionReport, validateWorkerReport } from "./v3/reports";
import { inheritPreset, migrateLegacyRouting, resolveNodeRouting, resolveRoleRouting, snapshotPreset, validatePreset, workerRoleForIndex } from "./v3/presets";
import {
  artifactDirForRun,
  generateCriticMarkdown,
  generateExplorationMarkdown,
  generateManifest,
  generatePlanMarkdown,
  generatePromotionMarkdown,
  generateWorkerMarkdown,
  isSafeV3ArtifactRef,
  parseV3ArtifactPaths,
  runArtifactPath,
  workerReportPath,
} from "./v3/artifacts";
import { criticPrompt, explorerPrompt, plannerPrompt, promoterPrompt, workerPrompt } from "./v3/prompts";
import { sumDistinctThreadTokens } from "./v3/tokens";

/**
 * Deferred first dispatch for role threads (ms). spawnRoleThread passes
 * sendAt: Date.now() + ROLE_SPAWN_DISPATCH_DELAY_MS on every spawn, so the
 * thread is created and returned while its first message stays queued; the
 * attempt/run mapping persisted right after spawn returns is therefore
 * always in place before the host constructs the child's provider session
 * (which runs bb.agents.configure to resolve role tools). One second dwarfs
 * the synchronous better-sqlite3 writes involved, with negligible UX cost.
 */
export const ROLE_SPAWN_DISPATCH_DELAY_MS = 1000;

export const V3_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS harness_v3_runs (
     id TEXT PRIMARY KEY,
     home_thread_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT,
     objective TEXT NOT NULL,
     state TEXT NOT NULL,
     revision INTEGER NOT NULL DEFAULT 0,
     plan_revision INTEGER NOT NULL DEFAULT 0,
     draft_revision INTEGER NOT NULL DEFAULT 0,
     planner_thread_id TEXT,
     explorer_thread_id TEXT,
     critic_thread_id TEXT,
     promoter_thread_id TEXT,
     active_worker_node_id TEXT,
     active_worker_thread_id TEXT,
     preset_snapshot TEXT NOT NULL,
     promotion_choice TEXT NOT NULL DEFAULT 'ask',
     evaluation TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS harness_v3_one_active_per_home
     ON harness_v3_runs(home_thread_id) WHERE state NOT IN ('Complete','Cancelled')`,
  `CREATE INDEX IF NOT EXISTS harness_v3_runs_home_idx ON harness_v3_runs(home_thread_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS harness_v3_packets (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES harness_v3_runs(id) ON DELETE CASCADE,
     packet_version INTEGER NOT NULL,
     role TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE(run_id, packet_version)
   )`,
  `CREATE TABLE IF NOT EXISTS harness_v3_work_nodes (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES harness_v3_runs(id) ON DELETE CASCADE,
     node_id TEXT NOT NULL,
     title TEXT NOT NULL,
     objective TEXT NOT NULL,
     dependencies TEXT NOT NULL DEFAULT '[]',
     acceptance TEXT NOT NULL DEFAULT '[]',
     verification TEXT NOT NULL DEFAULT '[]',
     artifacts TEXT NOT NULL DEFAULT '[]',
     hints TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'pending',
     plan_revision INTEGER NOT NULL DEFAULT 0,
     attempt_id TEXT,
     routing_override TEXT,
     sort_order INTEGER NOT NULL,
     UNIQUE(run_id, node_id)
   )`,
  `CREATE TABLE IF NOT EXISTS harness_v3_node_dependencies (
     run_id TEXT NOT NULL REFERENCES harness_v3_runs(id) ON DELETE CASCADE,
     node_id TEXT NOT NULL,
     dep_id TEXT NOT NULL,
     PRIMARY KEY (run_id, node_id, dep_id)
   )`,
  `CREATE INDEX IF NOT EXISTS harness_v3_nodes_run_idx ON harness_v3_work_nodes(run_id, sort_order)`,
  `CREATE TABLE IF NOT EXISTS harness_v3_attempts (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES harness_v3_runs(id) ON DELETE CASCADE,
     node_id TEXT,
     role TEXT NOT NULL,
     child_thread_id TEXT,
     provider_id TEXT,
     model TEXT,
     reasoning TEXT,
     service_tier TEXT,
     permission_mode TEXT,
     status TEXT NOT NULL DEFAULT 'running',
     output_hash TEXT,
     tokens_json TEXT NOT NULL DEFAULT '{}',
     started_at INTEGER NOT NULL,
     ended_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS harness_v3_attempts_run_idx ON harness_v3_attempts(run_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS harness_v3_attempts_child_idx ON harness_v3_attempts(child_thread_id)`,
  `CREATE TABLE IF NOT EXISTS harness_v3_reports (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES harness_v3_runs(id) ON DELETE CASCADE,
     node_id TEXT,
     kind TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     attempt_id TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS harness_v3_reports_run_idx ON harness_v3_reports(run_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS harness_v3_decisions (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES harness_v3_runs(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     actor TEXT NOT NULL,
     reason TEXT,
     node_ids TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS harness_v3_artifacts (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES harness_v3_runs(id) ON DELETE CASCADE,
     node_id TEXT,
     path TEXT NOT NULL,
     kind TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS harness_v3_role_presets (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     scope TEXT NOT NULL DEFAULT 'global',
     project_id TEXT,
     payload_json TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS harness_v3_mutations (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES harness_v3_runs(id) ON DELETE CASCADE,
     action TEXT NOT NULL,
     actor TEXT NOT NULL,
     source TEXT NOT NULL,
     request_id TEXT NOT NULL UNIQUE,
     reason TEXT,
     expected_revision INTEGER,
     resulting_revision INTEGER NOT NULL,
     attempt_id TEXT,
     child_thread_id TEXT,
     output_hash TEXT,
     detail_json TEXT NOT NULL DEFAULT '{}',
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS harness_v3_mutations_run_idx ON harness_v3_mutations(run_id, created_at)`,
  `ALTER TABLE harness_v3_runs ADD COLUMN constraints_json TEXT NOT NULL DEFAULT '[]'`,
  `CREATE TABLE IF NOT EXISTS harness_v3_pending_exports (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES harness_v3_runs(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     node_id TEXT,
     reason TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS harness_v3_pending_exports_run_idx ON harness_v3_pending_exports(run_id)`,
  `ALTER TABLE harness_v3_decisions ADD COLUMN report_id TEXT`,
  `CREATE INDEX IF NOT EXISTS harness_v3_decisions_report_idx ON harness_v3_decisions(report_id)`,
];

const executionChoiceSchema = z.object({
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningLevel: z.string().trim().min(1),
  serviceTier: z.enum(["default", "fast"]).optional(),
  permissionMode: z.enum(["accept-edits", "auto"]).nullable().optional(),
});
const roleExecutionSchema = z.object({
  choice: executionChoiceSchema.nullable(),
  permissionMode: z.enum(["accept-edits", "auto"]).nullable(),
  skillHints: z.array(z.string()).default([]),
});
const presetSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.enum(["global", "project"]),
  projectId: z.string().nullable(),
  roles: z.object({
    explorer: roleExecutionSchema,
    planner: roleExecutionSchema,
    workerFirst: roleExecutionSchema,
    workerRest: roleExecutionSchema,
    critic: roleExecutionSchema,
    promoter: roleExecutionSchema,
  }),
  promotionMode: z.enum(["ask", "off", "always"]),
  artifactPolicy: z.enum(["advisory", "required"]),
});
const workNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  objective: z.string(),
  dependencies: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  verificationCommands: z.array(z.string()),
  expectedArtifacts: z.array(z.string()),
  skillHints: z.array(z.string()),
  status: z.enum(["pending", "ready", "running", "awaiting_review", "done", "failed", "invalidated", "skipped"]),
  planRevision: z.number(),
  attemptId: z.string().nullable(),
  routingOverride: executionChoiceSchema.nullable(),
});
const runSchema = z.object({
  id: z.string(),
  homeThreadId: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  objective: z.string(),
  state: z.enum(V3_RUN_STATES),
  revision: z.number(),
  planRevision: z.number(),
  draftRevision: z.number(),
  plannerThreadId: z.string().nullable(),
  explorerThreadId: z.string().nullable(),
  criticThreadId: z.string().nullable(),
  promoterThreadId: z.string().nullable(),
  activeWorkerNodeId: z.string().nullable(),
  activeWorkerThreadId: z.string().nullable(),
  preset: presetSchema,
  promotionChoice: z.string(),
  packetVersion: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const v3StatusSchema = z.object({
  run: runSchema.nullable(),
  nodes: z.array(workNodeSchema),
  nextNode: workNodeSchema.nullable(),
  doneCount: z.number(),
  totalCount: z.number(),
  stateCopy: z.object({ title: z.string(), body: z.string(), primary: z.string() }),
  skillWarnings: z.array(z.string()),
  providerWarnings: z.array(z.string()),
  decisions: z.array(z.object({ id: z.string(), kind: z.string(), actor: z.string(), reason: z.string().nullable(), nodeIds: z.array(z.string()), createdAt: z.number() })),
  artifacts: z.array(z.object({ path: z.string(), kind: z.string(), nodeId: z.string().nullable() })),
  evaluation: z.object({ outcome: z.string().nullable(), reworkCount: z.number(), acceptedAttempts: z.number(), failedAttempts: z.number(), elapsedMs: z.number().nullable(), note: z.string().nullable() }).nullable(),
  legacyNote: z.string().nullable(),
  currentReviewApproved: z.boolean(),
  promotionSkipped: z.boolean(),
  failedRoles: z.array(z.object({ role: z.string(), nodeId: z.string().nullable() })),
  exportWarnings: z.array(z.string()),
  nextNodeRouting: z.object({
    choice: executionChoiceSchema.nullable(),
    source: z.enum(["preset", "node override", "inherited"]),
  }).nullable(),
  latestReports: z.object({
    exploration: z.object({ summary: z.string(), findings: z.array(z.string()), risks: z.array(z.string()), createdAt: z.number() }).nullable(),
    worker: z.array(z.object({
      nodeId: z.string(), attemptId: z.string().nullable(), outcome: z.string(), summary: z.string(),
      changedFiles: z.array(z.string()),
      acceptanceResults: z.array(z.object({ criterion: z.string(), met: z.boolean(), note: z.string() })),
      commands: z.array(z.object({ command: z.string(), exitCode: z.number().nullable(), output: z.string() })),
      artifactRefs: z.array(z.string()), risks: z.array(z.string()), createdAt: z.number(),
    })),
    critic: z.object({
      recommendation: z.string(),
      findings: z.array(z.object({ severity: z.string(), title: z.string(), detail: z.string() })),
      affectedNodeIds: z.array(z.string()),
      checksRerun: z.array(z.object({ command: z.string(), exitCode: z.number().nullable(), note: z.string() })),
      unsupportedClaims: z.array(z.string()), risks: z.array(z.string()), createdAt: z.number(),
    }).nullable(),
    promotion: z.object({
      audience: z.string(), channel: z.string(), summary: z.string(),
      claims: z.array(z.string()), limitations: z.array(z.string()), createdAt: z.number(),
    }).nullable(),
  }),
});

export const v3RpcContract = defineRpcContract({
  v3Status: {
    input: z.object({ threadId: z.string(), projectId: z.string().optional() }),
    output: v3StatusSchema,
  },
  v3Start: {
    input: z.object({
      threadId: z.string(),
      projectId: z.string().optional(),
      objective: z.string().trim().min(1).max(8000),
      presetId: z.string().trim().min(1).max(64).optional(),
      constraints: z.array(z.string().max(1000)).max(24).optional(),
      promotionChoice: z.enum(["ask", "off", "always"]).optional(),
    }),
    output: v3StatusSchema,
  },
  v3RunExplorer: {
    input: z.object({ threadId: z.string(), projectId: z.string().optional(), questions: z.array(z.string().max(1000)).max(12).optional() }),
    output: v3StatusSchema,
  },
  v3AcceptExploration: {
    input: z.object({ threadId: z.string(), projectId: z.string().optional(), expectedRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100) }),
    output: v3StatusSchema,
  },
  v3SkipExploration: {
    input: z.object({ threadId: z.string(), projectId: z.string().optional(), reason: z.string().trim().min(1).max(500), expectedRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100) }),
    output: v3StatusSchema,
  },
  v3ApprovePlan: {
    input: z.object({ threadId: z.string(), projectId: z.string().optional(), expectedRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100) }),
    output: v3StatusSchema,
  },
  v3RequestPlanRevision: {
    input: z.object({ threadId: z.string(), projectId: z.string().optional(), reason: z.string().trim().min(1).max(1000), expectedRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100) }),
    output: v3StatusSchema,
  },
  v3RunNextWorker: {
    input: z.object({ threadId: z.string(), projectId: z.string().optional(), expectedRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100) }),
    output: v3StatusSchema,
  },
  v3ReviewWorker: {
    input: z.object({
      threadId: z.string(), projectId: z.string().optional(), nodeId: z.string().min(1),
      approve: z.boolean(), changes: z.string().max(4000).optional(),
      expectedRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100),
    }),
    output: v3StatusSchema,
  },
  v3SetNodeRouting: {
    input: z.object({
      threadId: z.string(), projectId: z.string().optional(), nodeId: z.string().min(1),
      choice: executionChoiceSchema.nullable(),
      expectedRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100),
    }),
    output: v3StatusSchema,
  },
  v3StartCritic: {
    input: z.object({ threadId: z.string(), projectId: z.string().optional(), expectedRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100) }),
    output: v3StatusSchema,
  },
  v3ReviewCritic: {
    input: z.object({
      threadId: z.string(), projectId: z.string().optional(),
      decision: z.enum(["APPROVE", "REWORK", "BLOCK"]),
      nodeIds: z.array(z.string()).max(32).optional(),
      reason: z.string().trim().min(1).max(2000),
      expectedRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100),
    }),
    output: v3StatusSchema,
  },
  v3Promote: {
    input: z.object({
      threadId: z.string(), projectId: z.string().optional(),
      start: z.boolean(), audience: z.string().max(500).optional(), channel: z.string().max(500).optional(),
      expectedRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100),
    }),
    output: v3StatusSchema,
  },
  v3Complete: {
    input: z.object({
      threadId: z.string(), projectId: z.string().optional(),
      outcome: z.enum(["useful", "neutral", "costly"]).optional(), note: z.string().max(1000).optional(),
      expectedRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100),
    }),
    output: v3StatusSchema,
  },
  v3Cancel: {
    input: z.object({ threadId: z.string(), projectId: z.string().optional(), reason: z.string().trim().min(1).max(500), expectedRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100) }),
    output: v3StatusSchema,
  },
  v3RetryRole: {
    input: z.object({ threadId: z.string(), projectId: z.string().optional(), role: z.enum(["explorer", "planner", "worker", "workerFirst", "workerRest", "critic", "promoter"]), nodeId: z.string().optional(), expectedRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100) }),
    output: v3StatusSchema,
  },
  v3StopRole: {
    input: z.object({ threadId: z.string(), projectId: z.string().optional(), role: z.enum(["explorer", "planner", "worker", "workerFirst", "workerRest", "critic", "promoter"]), nodeId: z.string().optional(), expectedRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100), reason: z.string().max(500).optional() }),
    output: v3StatusSchema,
  },
  v3Export: {
    input: z.object({ threadId: z.string(), projectId: z.string().optional() }),
    output: z.object({ artifacts: z.array(z.string()), manifest: z.string() }),
  },
  v3RetryExport: {
    input: z.object({ threadId: z.string(), projectId: z.string().optional(), expectedRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(100) }),
    output: z.object({ status: v3StatusSchema, exported: z.array(z.string()), warnings: z.array(z.string()) }),
  },
  v3PresetList: {
    input: z.object({ projectId: z.string().optional() }),
    output: z.object({ presets: z.array(presetSchema) }),
  },
  v3PresetShow: {
    input: z.object({ id: z.string() }),
    output: z.object({ preset: presetSchema.nullable() }),
  },
  v3PresetCreate: {
    input: z.object({ name: z.string().trim().min(1).max(80), scope: z.enum(["global", "project"]).optional(), projectId: z.string().nullable().optional(), roles: z.record(z.string(), roleExecutionSchema).optional(), promotionMode: z.enum(["ask", "off", "always"]).optional(), artifactPolicy: z.enum(["advisory", "required"]).optional() }),
    output: z.object({ preset: presetSchema }),
  },
  v3PresetUpdate: {
    input: z.object({ id: z.string(), name: z.string().trim().min(1).max(80).optional(), roles: z.record(z.string(), roleExecutionSchema).optional(), promotionMode: z.enum(["ask", "off", "always"]).optional(), artifactPolicy: z.enum(["advisory", "required"]).optional() }),
    output: z.object({ preset: presetSchema }),
  },
  v3PresetDelete: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  v3LegacyList: {
    input: z.object({ projectId: z.string(), threadId: z.string().optional() }),
    output: z.object({ plans: z.array(z.object({ id: z.string(), name: z.string(), updatedAt: z.number() })) }),
  },
});

export type V3Db = ReturnType<BbPluginApi["storage"]["database"]>;

type V3RunRow = {
  id: string;
  home_thread_id: string;
  project_id: string;
  environment_id: string | null;
  objective: string;
  state: string;
  revision: number;
  plan_revision: number;
  draft_revision: number;
  planner_thread_id: string | null;
  explorer_thread_id: string | null;
  critic_thread_id: string | null;
  promoter_thread_id: string | null;
  active_worker_node_id: string | null;
  active_worker_thread_id: string | null;
  preset_snapshot: string;
  promotion_choice: string;
  evaluation: string | null;
  constraints_json: string | null;
  created_at: number;
  updated_at: number;
};

type V3NodeRow = {
  id: string;
  run_id: string;
  node_id: string;
  title: string;
  objective: string;
  dependencies: string;
  acceptance: string;
  verification: string;
  artifacts: string;
  hints: string;
  status: string;
  plan_revision: number;
  attempt_id: string | null;
  routing_override: string | null;
  sort_order: number;
};

function shortId(): string {
  return randomUUID().slice(0, 8);
}

function parseJsonArray(raw: string | null, fallback: string[] = []): string[] {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fallback;
  } catch {
    return fallback;
  }
}

function toWorkNode(row: V3NodeRow): V3WorkNode {
  return {
    id: row.node_id,
    title: row.title,
    objective: row.objective,
    dependencies: parseJsonArray(row.dependencies),
    acceptanceCriteria: parseJsonArray(row.acceptance),
    verificationCommands: parseJsonArray(row.verification),
    expectedArtifacts: parseJsonArray(row.artifacts),
    skillHints: parseJsonArray(row.hints),
    status: (["pending", "ready", "running", "awaiting_review", "done", "failed", "invalidated", "skipped"] as const).includes(row.status as never)
      ? (row.status as V3WorkNode["status"])
      : "pending",
    planRevision: row.plan_revision,
    attemptId: row.attempt_id,
    routingOverride: row.routing_override ? (JSON.parse(row.routing_override) as V3WorkNode["routingOverride"]) : null,
  };
}

export function registerV3Backend(
  bb: BbPluginApi,
  db: V3Db,
  deps: {
    publish: () => void;
    resolveProjectId: (threadId: string, claimed?: string) => Promise<string>;
    pluginId: string;
  },
): {
  getV3Status: (threadId: string, projectId: string) => Promise<z.infer<typeof v3StatusSchema>>;
  isV3RoleThread: (
    threadId: string,
    opts?: { parentThreadId?: string | null; title?: string | null; originPluginId?: string | null },
  ) => { runId: string; role: V3Role; nodeId: string | null } | null;
  v3RolePrompt: (threadId: string) => Promise<string | null>;
  v3Cli: (argv: string[], ctx: { threadId?: string; projectId?: string }) => Promise<{ exitCode: number; stdout?: string; stderr?: string } | null>;
  handlers: Record<string, (input: never) => Promise<unknown>>;
  ensureMigratedPreset: (legacyRouting: unknown) => void;
  packetSliceFor: (runId: string, role: "explorer" | "planner" | "worker" | "critic" | "promoter", nodeId: string | null) => Promise<Record<string, unknown>>;
  deliverExplorationToPlanner: (runId: string, summary: string, findings: string[]) => Promise<void>;
} {
  const { publish, resolveProjectId, pluginId: ownPluginId } = deps;

  // Pre-spawn intent bridge for the dispatch race: the host may construct a
  // role child's provider session (running bb.agents.configure) while its
  // first dispatch is queued, before the attempt/run mapping below is
  // persisted. The intent is noted synchronously immediately before the
  // spawn call and removed in a finally once spawn + attempt insert settle,
  // so a configure that runs mid-flight still resolves the child's role
  // while persisted DB mappings always win once written.
  type PendingRoleSpawn = {
    parentThreadId: string;
    title: string;
    role: V3Role;
    runId: string;
    nodeId: string | null;
  };
  const pendingRoleSpawns = new Map<string, PendingRoleSpawn>();
  const PENDING_SPAWN_MAX = 50;

  function pendingSpawnKey(parentThreadId: string, title: string): string {
    return `${parentThreadId}\0${title}`;
  }

  function notePendingRoleSpawn(entry: PendingRoleSpawn): void {
    pendingRoleSpawns.set(pendingSpawnKey(entry.parentThreadId, entry.title), entry);
    while (pendingRoleSpawns.size > PENDING_SPAWN_MAX) {
      const oldest = pendingRoleSpawns.keys().next();
      if (oldest.done) break;
      pendingRoleSpawns.delete(oldest.value);
    }
  }

  function unnotePendingRoleSpawn(parentThreadId: string, title: string): void {
    pendingRoleSpawns.delete(pendingSpawnKey(parentThreadId, title));
  }

  // Strict fallback: only a thread whose origin plugin is us, whose parent
  // matches, and whose EXACT title matches a live intent resolves. Anything
  // else (legacy children, user threads, other plugins) gets no tools.
  function matchPendingRoleSpawn(opts: {
    parentThreadId?: string | null;
    title?: string | null;
    originPluginId?: string | null;
  }): { runId: string; role: V3Role; nodeId: string | null } | null {
    if (opts.originPluginId !== ownPluginId) return null;
    if (!opts.parentThreadId || !opts.title) return null;
    const hit = pendingRoleSpawns.get(pendingSpawnKey(opts.parentThreadId, opts.title));
    return hit ? { runId: hit.runId, role: hit.role, nodeId: hit.nodeId } : null;
  }

  const selRunByHome = db.prepare("SELECT * FROM harness_v3_runs WHERE home_thread_id = ? AND state NOT IN ('Complete','Cancelled') ORDER BY updated_at DESC LIMIT 1");
  const selAnyRunByHome = db.prepare("SELECT * FROM harness_v3_runs WHERE home_thread_id = ? ORDER BY updated_at DESC LIMIT 1");
  const selRunById = db.prepare("SELECT * FROM harness_v3_runs WHERE id = ?");
  const selNodes = db.prepare("SELECT * FROM harness_v3_work_nodes WHERE run_id = ? ORDER BY sort_order ASC");
  const selDecisions = db.prepare("SELECT * FROM harness_v3_decisions WHERE run_id = ? ORDER BY created_at ASC");
  const selArtifacts = db.prepare("SELECT * FROM harness_v3_artifacts WHERE run_id = ? ORDER BY created_at ASC");
  const selReports = db.prepare("SELECT * FROM harness_v3_reports WHERE run_id = ? ORDER BY created_at ASC");
  const selAttempts = db.prepare("SELECT * FROM harness_v3_attempts WHERE run_id = ? ORDER BY started_at ASC");
  const selPackets = db.prepare("SELECT * FROM harness_v3_packets WHERE run_id = ? ORDER BY packet_version DESC LIMIT 1");
  const selPreset = db.prepare("SELECT * FROM harness_v3_role_presets WHERE id = ?");
  const selPresets = db.prepare("SELECT * FROM harness_v3_role_presets ORDER BY updated_at DESC");
  const selAttemptByChild = db.prepare("SELECT * FROM harness_v3_attempts WHERE child_thread_id = ? ORDER BY started_at DESC LIMIT 1");

  function getActiveRun(homeThreadId: string): V3RunRow | null {
    return (selRunByHome.get(homeThreadId) as V3RunRow | undefined) ?? null;
  }

  // Home-resolved active run: operator handlers accept the home thread id,
  // but resolving participants keeps behavior correct if ever called elsewhere.
  function activeRunFor(threadId: string): V3RunRow | null {
    return getActiveRun(homeOf(threadId) ?? threadId);
  }

  function requireRevision(run: V3RunRow, expected: number): void {
    if (run.revision !== expected) {
      throw new Error(`Stale Harness state: expected run revision ${expected}, current is ${run.revision}. Refresh before retrying.`);
    }
  }

  // Serialize direct v3 mutations per home thread so concurrent duplicate
  // calls cannot interleave between revision check and commit.
  const runLocks = new Map<string, Promise<void>>();
  async function withRunLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prev = runLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    runLocks.set(key, mine);
    await prev;
    try {
      return await work();
    } finally {
      release();
      if (runLocks.get(key) === mine) runLocks.delete(key);
    }
  }

  // Request IDs are replay-safe: a repeated requestId returns current state
  // without re-applying the mutation.
  function seenRequest(requestId: string): boolean {
    try {
      return !!db.prepare("SELECT id FROM harness_v3_mutations WHERE request_id = ?").get(requestId);
    } catch {
      return false;
    }
  }

  function readConstraints(run: V3RunRow): string[] {
    if (!run.constraints_json) return [];
    try {
      const v = JSON.parse(run.constraints_json) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  // Resolve any participant thread (home, Planner, or role child) to the
  // run's home thread id. Returns null when the thread is not in a v3 run.
  function homeOf(threadId: string): string | null {
    const direct = (selRunByHome.get(threadId) as V3RunRow | undefined)
      ?? (selAnyRunByHome.get(threadId) as V3RunRow | undefined);
    if (direct) return direct.home_thread_id;
    const attempt = selAttemptByChild.get(threadId) as { run_id: string } | undefined;
    if (attempt) {
      const run = selRunById.get(attempt.run_id) as V3RunRow | undefined;
      if (run) return run.home_thread_id;
    }
    try {
      const run = db.prepare(
        "SELECT home_thread_id FROM harness_v3_runs WHERE planner_thread_id = ? OR explorer_thread_id = ? OR critic_thread_id = ? OR promoter_thread_id = ? OR active_worker_thread_id = ?"
      ).get(threadId, threadId, threadId, threadId, threadId) as { home_thread_id: string } | undefined;
      if (run) return run.home_thread_id;
    } catch {}
    return null;
  }

  function recordV3Mutation(args: {
    runId: string; action: string; actor: string; source: string; requestId: string;
    reason?: string | null; expectedRevision?: number | null; attemptId?: string | null;
    childThreadId?: string | null; outputHash?: string | null; detail?: Record<string, unknown>;
  }): void {
    const run = selRunById.get(args.runId) as V3RunRow;
    db.prepare(
      `INSERT INTO harness_v3_mutations (id, run_id, action, actor, source, request_id, reason, expected_revision, resulting_revision, attempt_id, child_thread_id, output_hash, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), args.runId, args.action, args.actor, args.source, args.requestId,
      args.reason ?? null, args.expectedRevision ?? null, run.revision,
      args.attemptId ?? null, args.childThreadId ?? null, args.outputHash ?? null,
      JSON.stringify(args.detail ?? {}), Date.now(),
    );
  }

  function transition(run: V3RunRow, to: V3RunState, expectedRevision: number): V3RunRow {
    requireRevision(run, expectedRevision);
    assertTransitionV3(run.state as V3RunState, to);
    db.prepare("UPDATE harness_v3_runs SET state = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?").run(to, Date.now(), run.id, expectedRevision);
    const next = selRunById.get(run.id) as V3RunRow;
    if (!next || next.revision !== expectedRevision + 1) throw new Error("Run revision claim was lost. Refresh and retry.");
    return next;
  }

  function presetOf(run: V3RunRow): V3RolePreset {
    return JSON.parse(run.preset_snapshot) as V3RolePreset;
  }

  type CatalogModel = {
    id?: string;
    model: string;
    routeProviderId?: string;
    supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
  };

  // Validate one routing choice against the live catalog for an environment.
  // Returns an error string, or null when the choice is usable. An empty
  // model catalog means the host cannot verify: provider presence is still
  // enforced, model/reasoning checks are skipped as unverifiable.
  async function validateChoiceAgainstCatalog(
    choice: { providerId: string; model: string; reasoningLevel: string },
    environmentId: string | undefined,
    roleLabel: string,
  ): Promise<string | null> {
    let catalog: { providers: Array<{ id: string; available?: boolean }>; models: CatalogModel[] };
    try {
      const raw = environmentId
        ? await bb.sdk.providers.models({ environmentId, providerId: choice.providerId })
        : await bb.sdk.providers.models({ providerId: choice.providerId });
      catalog = {
        providers: (raw.providers ?? []) as Array<{ id: string; available?: boolean }>,
        models: (raw.models ?? []) as CatalogModel[],
      };
    } catch {
      return null;
    }
    // The call is already filtered by providerId; a listed entry that is
    // unavailable (signed out, errored) still blocks routing.
    const provider = catalog.providers.find((p) => p.id === choice.providerId);
    if (!provider || provider.available === false) {
      return `${roleLabel} provider ${choice.providerId} is unavailable in this environment.`;
    }
    if (catalog.models.length === 0) return null;
    // routeProviderId names the upstream route behind a BB provider (e.g.
    // opencode/openai-codex behind pi) — never equate it with the BB
    // provider id when matching the selected model.
    const model = catalog.models.find((m) => m.model === choice.model || m.id === choice.model);
    if (!model) {
      return `${roleLabel} model ${choice.providerId}/${choice.model} is stale or unknown in this environment.`;
    }
    const efforts = model.supportedReasoningEfforts ?? [];
    if (efforts.length > 0 && !efforts.some((e) => e.reasoningEffort === choice.reasoningLevel)) {
      return `${roleLabel} reasoning level "${choice.reasoningLevel}" is unsupported by ${choice.model} (supports: ${efforts.map((e) => e.reasoningEffort).join(", ")}).`;
    }
    return null;
  }

  async function validatePresetChoices(
    preset: V3RolePreset,
    environmentId: string | undefined,
  ): Promise<string[]> {
    const warnings: string[] = [];
    for (const role of V3_ROLES) {
      const choice = preset.roles[role]?.choice;
      if (!choice) continue;
      const problem = await validateChoiceAgainstCatalog(choice, environmentId, role);
      if (problem) warnings.push(`${problem} Repair in Settings → Role presets or update the preset.`);
    }
    return warnings;
  }

  type DecisionRow = { id: string; kind: string; actor: string; reason: string | null; created_at: number };

  function decisionsOf(runId: string): DecisionRow[] {
    return selDecisions.all(runId) as DecisionRow[];
  }

  type CriticReportRow = { id: string; created_at: number };

  // Newest Critic report by (created_at, rowid): deterministic even when
  // rows share a millisecond.
  function latestCriticReport(runId: string): CriticReportRow | null {
    try {
      return (db.prepare(
        "SELECT id, created_at FROM harness_v3_reports WHERE run_id = ? AND kind = 'critic' ORDER BY created_at DESC, rowid DESC LIMIT 1"
      ).get(runId) as CriticReportRow | undefined) ?? null;
    } catch {
      let best: CriticReportRow | null = null;
      for (const r of selReports.all(runId) as Array<{ id: string; kind: string; created_at: number }>) {
        if (r.kind === "critic" && (!best || r.created_at >= best.created_at)) best = { id: r.id, created_at: r.created_at };
      }
      return best;
    }
  }

  // Freshness is by report IDENTITY, never wall-clock: an approval answers
  // the exact Critic report it was recorded against. Legacy decisions with a
  // NULL report_id never count as fresh. Returns the approval timestamp for
  // display, or 0 when no current approval exists.
  function freshApprovalAt(runId: string): number {
    const latest = latestCriticReport(runId);
    if (!latest) return 0;
    let at = 0;
    for (const d of decisionsOf(runId) as Array<DecisionRow & { report_id?: string | null }>) {
      if (d.kind === "critic_approved" && d.report_id === latest.id && d.created_at > at) at = d.created_at;
    }
    return at;
  }

  function decidedForCurrentReport(runId: string): boolean {
    const latest = latestCriticReport(runId);
    if (!latest) return false;
    return decisionsOf(runId).some(
      (d: DecisionRow & { report_id?: string | null }) =>
        (d.kind === "critic_approved" || d.kind === "critic_rework" || d.kind === "critic_blocked") &&
        d.report_id === latest.id,
    );
  }

  function promotionSkippedForApproval(runId: string): boolean {
    const latest = latestCriticReport(runId);
    if (!latest || !freshApprovalAt(runId)) return false;
    return decisionsOf(runId).some(
      (d: DecisionRow & { report_id?: string | null }) => d.kind === "promotion_skipped" && d.report_id === latest.id,
    );
  }

  // Roles whose latest attempt failed and have not been restarted since.
  function failedRolesFor(run: V3RunRow): Array<{ role: string; nodeId: string | null }> {
    const out: Array<{ role: string; nodeId: string | null }> = [];
    for (const role of ["planner", "explorer", "critic", "promoter"] as const) {
      const row = db.prepare(
        "SELECT status FROM harness_v3_attempts WHERE run_id = ? AND role = ? ORDER BY started_at DESC LIMIT 1"
      ).get(run.id, role) as { status: string } | undefined;
      if (row?.status === "failed") out.push({ role, nodeId: null });
    }
    const wrow = db.prepare(
      "SELECT status, node_id FROM harness_v3_attempts WHERE run_id = ? AND role IN ('worker','workerFirst','workerRest') ORDER BY started_at DESC LIMIT 1"
    ).get(run.id) as { status: string; node_id: string | null } | undefined;
    if (wrow?.status === "failed") out.push({ role: "worker", nodeId: wrow.node_id });
    return out;
  }

  function exportWarningsFor(runId: string): string[] {
    try {
      return (db.prepare("SELECT kind, node_id, reason FROM harness_v3_pending_exports WHERE run_id = ?").all(runId) as Array<{ kind: string; node_id: string | null; reason: string }>)
        .map((r) => `${r.kind}${r.node_id ? ` (${r.node_id})` : ""} export failed: ${r.reason}`);
    } catch {
      return [];
    }
  }

  function notePendingExport(runId: string, kind: string, nodeId: string | null, reason: string): void {
    try {
      db.prepare(
        `INSERT INTO harness_v3_pending_exports (id, run_id, kind, node_id, reason, attempts, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(id) DO NOTHING`
      ).run(`${runId}:${kind}:${nodeId ?? "-"}`, runId, kind, nodeId, reason.slice(0, 500), Date.now());
      db.prepare("UPDATE harness_v3_pending_exports SET reason = ?, updated_at = ? WHERE id = ?").run(reason.slice(0, 500), Date.now(), `${runId}:${kind}:${nodeId ?? "-"}`);
    } catch {}
  }

  // Export one accepted structured report to its promised artifact path.
  // Throws on file failure so callers record a pending export instead of
  // claiming success.
  async function exportReportArtifact(runId: string, kind: "exploration" | "worker" | "critic" | "promotion", nodeId: string | null): Promise<string> {
    const run = selRunById.get(runId) as V3RunRow;
    if (!run) throw new Error("Run not found.");
    const nodes = nodesOf(runId);
    if (kind === "exploration") {
      const row = (selReports.all(runId) as Array<{ kind: string; payload_json: string }>).filter((r) => r.kind === "exploration").at(-1);
      if (!row) throw new Error("No exploration report to export.");
      const p = JSON.parse(row.payload_json) as { summary: string; findings: string[]; risks: string[] };
      const path = runArtifactPath(runId, "exploration.md");
      await writeRunFile(runId, run.home_thread_id, path, `${generateExplorationMarkdown({ summary: p.summary ?? "", findings: p.findings ?? [], risks: p.risks ?? [] })}`, "exploration", null);
      return path;
    }
    if (kind === "worker") {
      if (!nodeId) throw new Error("Worker export needs a node id.");
      const node = nodes.find((n) => n.id === nodeId);
      const latest = newestWorkerReports(runId).find((w) => (w.node_id ?? String(w.payload.nodeId ?? "")) === nodeId);
      if (!latest) throw new Error(`No worker report for ${nodeId}.`);
      const p = latest.payload as Record<string, unknown>;
      const path = workerReportPath(runId, nodeId);
      await writeRunFile(runId, run.home_thread_id, path, `${generateWorkerMarkdown({
        nodeId,
        title: node?.title ?? nodeId,
        summary: String(p.summary ?? ""),
        changedFiles: Array.isArray(p.changedFiles) ? (p.changedFiles as string[]) : [],
        acceptance: Array.isArray(p.acceptanceResults) ? (p.acceptanceResults as Array<{ criterion: string; met: boolean; note: string }>) : [],
        commands: Array.isArray(p.commands) ? (p.commands as Array<{ command: string; exitCode: number | null; output: string }>) : [],
        risks: Array.isArray(p.risks) ? (p.risks as string[]) : [],
      })}`, "worker-report", nodeId);
      return path;
    }
    if (kind === "critic") {
      const row = (selReports.all(runId) as Array<{ kind: string; payload_json: string }>).filter((r) => r.kind === "critic").at(-1);
      if (!row) throw new Error("No critic report to export.");
      const p = JSON.parse(row.payload_json) as {
        recommendation: string; findings: Array<{ severity: string; title: string; detail: string }>;
        affectedNodeIds: string[]; checksRerun: Array<{ command: string; exitCode: number | null; note: string }>;
        unsupportedClaims: string[]; risks: string[];
      };
      const path = runArtifactPath(runId, "critic.md");
      await writeRunFile(runId, run.home_thread_id, path, `${generateCriticMarkdown({
        recommendation: p.recommendation ?? "", findings: p.findings ?? [], affectedNodeIds: p.affectedNodeIds ?? [],
        checksRerun: p.checksRerun ?? [], unsupportedClaims: p.unsupportedClaims ?? [], risks: p.risks ?? [],
      })}`, "critic", null);
      return path;
    }
    const row = (selReports.all(runId) as Array<{ kind: string; payload_json: string }>).filter((r) => r.kind === "promotion").at(-1);
    if (!row) throw new Error("No promotion report to export.");
    const p = JSON.parse(row.payload_json) as { audience: string; channel: string; summary: string; claims: string[]; limitations: string[] };
    const path = runArtifactPath(runId, "promotion.md");
    await writeRunFile(runId, run.home_thread_id, path, `${generatePromotionMarkdown({
      audience: p.audience ?? "", channel: p.channel ?? "", summary: p.summary ?? "",
      claims: p.claims ?? [], limitations: p.limitations ?? [],
    })}`, "promotion", null);
    return path;
  }

  async function exportReportOrPend(runId: string, kind: "exploration" | "worker" | "critic" | "promotion", nodeId: string | null): Promise<string | null> {
    try {
      const path = await exportReportArtifact(runId, kind, nodeId);
      try {
        db.prepare("DELETE FROM harness_v3_pending_exports WHERE id = ?").run(`${runId}:${kind}:${nodeId ?? "-"}`);
      } catch {}
      return path;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      notePendingExport(runId, kind, nodeId, reason);
      bb.log.warn(`harness v3 export failed (${kind}): ${reason}`);
      return null;
    }
  }

  async function retryPendingExports(runId: string): Promise<{ exported: string[]; warnings: string[] }> {
    const exported: string[] = [];
    let pending: Array<{ kind: string; node_id: string | null }> = [];
    try {
      pending = db.prepare("SELECT kind, node_id FROM harness_v3_pending_exports WHERE run_id = ?").all(runId) as Array<{ kind: string; node_id: string | null }>;
    } catch {
      return { exported, warnings: [] };
    }
    for (const item of pending) {
      const kind = item.kind as "exploration" | "worker" | "critic" | "promotion";
      const path = await exportReportOrPend(runId, kind, item.node_id);
      if (path) exported.push(path);
    }
    return { exported, warnings: exportWarningsFor(runId) };
  }

  function nodesOf(runId: string): V3WorkNode[] {
    return (selNodes.all(runId) as V3NodeRow[]).map(toWorkNode);
  }

  // Legacy provider-only check kept for callers without an environment.
  async function validatePresetProviders(preset: V3RolePreset): Promise<string[]> {
    return validatePresetChoices(preset, undefined);
  }

  async function validateSkillHints(hints: string[]): Promise<string[]> {
    if (hints.length === 0) return [];
    try {
      const listed = await bb.sdk.skills.list({} as never);
      const available = new Set(
        ((listed as unknown as { skills?: Array<{ name?: string; id?: string }> }).skills ?? []).map((s) => s.name ?? s.id ?? ""),
      );
      // Always-available bundled role skills.
      for (const owned of ["harness-planner", "harness-worker", "harness-critic", "harness-promoter"]) available.add(owned);
      return hints.filter((h) => !available.has(h)).map((h) => `Skill hint "${h}" was not found in BB discovery; it is a requested capability, not guaranteed activation.`);
    } catch {
      return [];
    }
  }

  async function resolveWorkspace(threadId: string): Promise<{ hostId: string | undefined; path: string; environmentId: string; projectId: string }> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) throw new Error("Thread has no environment.");
    const env = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (!env.path) throw new Error("Environment has no workspace path.");
    return { hostId: (env as { hostId?: string }).hostId, path: env.path, environmentId: thread.environmentId, projectId: thread.projectId };
  }

  async function writeRunFile(runId: string, homeThreadId: string, relative: string, content: string, kind: string, nodeId: string | null): Promise<string> {
    if (!isSafeV3ArtifactRef(relative)) throw new Error(`Unsafe artifact path ${relative}. Must stay under artifacts/.`);
    const ws = await resolveWorkspace(homeThreadId);
    const fullPath = `${ws.path}/${relative}`;
    let expected: string | null | undefined;
    try {
      const existing = await bb.sdk.files.read({ hostId: ws.hostId, path: fullPath });
      expected = (existing as { sha256?: string }).sha256 ?? undefined;
    } catch {
      expected = null;
    }
    const result = await bb.sdk.files.write({
      hostId: ws.hostId,
      path: fullPath,
      rootPath: ws.path,
      content,
      createParents: true,
      ...(expected === null ? { expectedSha256: null } : expected ? { expectedSha256: expected } : {}),
    });
    if ((result as { outcome?: string }).outcome === "conflict") {
      throw new Error(`Artifact ${relative} changed concurrently. Re-read and retry.`);
    }
    db.prepare("INSERT INTO harness_v3_artifacts (id, run_id, node_id, path, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), runId, nodeId, relative, kind, Date.now());
    return relative;
  }

  type WorkerReportRow = {
    nodeId: string;
    outcome: "complete" | "blocked" | "plan-change-needed";
    summary: string;
    commands: Array<{ command: string; exitCode: number | null; output: string }>;
    createdAt: number;
  };

  function readWorkerReports(runId: string): WorkerReportRow[] {
    const out: WorkerReportRow[] = [];
    for (const r of selReports.all(runId) as Array<{ kind: string; node_id: string | null; payload_json: string; created_at: number }>) {
      if (r.kind !== "worker") continue;
      try {
        const p = JSON.parse(r.payload_json) as Record<string, unknown>;
        out.push({
          nodeId: (r.node_id ?? (p.nodeId as string) ?? "") as string,
          outcome: p.outcome as WorkerReportRow["outcome"],
          summary: String(p.summary ?? ""),
          commands: Array.isArray(p.commands) ? (p.commands as WorkerReportRow["commands"]) : [],
          createdAt: r.created_at,
        });
      } catch {}
    }
    return out;
  }

  // Assemble a task packet without persisting (reads stay side-effect free).
  async function assemblePacket(run: V3RunRow, role: "explorer" | "planner" | "worker" | "critic" | "promoter", nodeId: string | null): Promise<ReturnType<typeof buildTaskPacket>> {
    const nodes = nodesOf(run.id);
    const reports = selReports.all(run.id) as Array<{ kind: string; node_id: string | null; payload_json: string }>;
    const decisions = (selDecisions.all(run.id) as Array<{ id: string; kind: string; actor: string; reason: string | null; node_ids: string }>)
      .map((d) => ({ id: d.id, kind: d.kind as never, actor: d.actor, reason: d.reason, nodeIds: parseJsonArray(d.node_ids), createdAt: 0 }));
    const artifacts = (selArtifacts.all(run.id) as Array<{ path: string; kind: string; node_id: string | null; created_at: number }>)
      .map((a) => ({ path: a.path, kind: a.kind as never, nodeId: a.node_id, createdAt: a.created_at }));
    const explorationRow = reports.filter((r) => r.kind === "exploration").at(-1);
    const exploration = explorationRow ? (JSON.parse(explorationRow.payload_json) as never) : null;
    const workerRows = reports.filter((r) => r.kind === "worker").map((r) => JSON.parse(r.payload_json) as Record<string, unknown>);
    const current = nodeId ? nodes.find((n) => n.id === nodeId) ?? null : null;
    // Workers see dependency-only results; Critic/Promoter see every report.
    const depResults = (role === "critic" || role === "promoter")
      ? workerRows
      : workerRows.filter((r) => typeof r.nodeId === "string" && (current?.dependencies.includes(r.nodeId as string) ?? false));
    // Verification summary rolls up Worker command outcomes (newest first, bounded).
    const verificationSummary = readWorkerReports(run.id)
      .flatMap((r) =>
        (r.commands ?? []).map((c) => ({
          command: c.command,
          exitCode: c.exitCode,
          summary: (c.output ?? "").slice(0, 500),
          nodeId: r.nodeId,
          createdAt: r.createdAt,
        })),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 16);
    let project = { id: run.project_id, name: run.project_id, environmentId: run.environment_id ?? "", workspacePath: "" };
    try {
      const ws = await resolveWorkspace(run.home_thread_id);
      project = { id: run.project_id, name: run.project_id, environmentId: ws.environmentId, workspacePath: ws.path };
      try {
        const proj = await bb.sdk.projects.get({ projectId: run.project_id });
        project.name = (proj as { name?: string }).name ?? project.name;
      } catch {}
    } catch {}
    const packetVersion = ((selPackets.get(run.id) as { packet_version?: number } | undefined)?.packet_version ?? 0) + 1;
    const approvedPlan = run.plan_revision > 0 ? { revision: run.plan_revision, nodes } : null;
    return buildTaskPacket({
      runId: run.id,
      packetVersion,
      objective: run.objective,
      project,
      constraints: readConstraints(run),
      exploration,
      approvedPlan,
      currentNode: current,
      dependencyResults: depResults as never,
      decisions: decisions as never,
      artifactIndex: artifacts,
      verificationSummary: verificationSummary as never,
    });
  }

  async function buildPacketForRun(run: V3RunRow, role: "explorer" | "planner" | "worker" | "critic" | "promoter", nodeId: string | null): Promise<ReturnType<typeof buildTaskPacket>> {
    const packet = await assemblePacket(run, role, nodeId);
    try {
      db.prepare("INSERT INTO harness_v3_packets (id, run_id, packet_version, role, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), run.id, packet.packetVersion, role, JSON.stringify(slicePacketForRole(packet, role)), Date.now());
    } catch {}
    return packet;
  }

  // Best-effort delivery of a bounded agent-only note to the Planner thread.
  // Failures never block the mutation; the panel always shows the report.
  // NOTE: call bb.sdk.threads.send as a method (never detached via .call):
  // host SDKs stub/record by method path.
  async function deliverToPlanner(run: V3RunRow, text: string): Promise<void> {
    if (!run.planner_thread_id) return;
    const bounded = text.length > 4000 ? `${text.slice(0, 4000)}\n…[truncated; full report in panel]` : text;
    try {
      await bb.sdk.threads.send({
        threadId: run.planner_thread_id,
        input: [{ type: "text", text: bounded, visibility: "agent-only" }],
        mode: "auto",
      } as never);
    } catch {}
  }

  async function spawnRoleThread(args: {
    run: V3RunRow;
    role: V3Role;
    parentThreadId: string;
    prompt: string;
    nodeId?: string | null;
    choice?: { providerId: string; model: string; reasoningLevel: string; serviceTier?: "default" | "fast" } | null;
    permissionMode?: "accept-edits" | "auto" | null;
  }): Promise<{ threadId: string; attemptId: string }> {
    const preset = presetOf(args.run);
    const roleDefaults = resolveRoleRouting({ preset, role: args.role });
    const choice = args.choice !== undefined ? args.choice : roleDefaults.choice;
    const parent = await bb.sdk.threads.get({ threadId: args.parentThreadId });
    if (!parent.environmentId) throw new Error("Parent thread has no environment; cannot spawn a role thread.");
    if (choice) {
      const problem = await validateChoiceAgainstCatalog(choice, parent.environmentId, args.role);
      if (problem) throw new Error(`Stale routing for ${args.role}: ${problem} Repair in Settings → Role presets or override the node.`);
    }
    const permissionMode =
      args.permissionMode !== undefined
        ? args.permissionMode ?? undefined
        : (roleDefaults.permissionMode ??
          (args.role === "critic" || args.role === "promoter" ? "accept-edits" : undefined));
    // Never widen beyond parent/machine policy: only request accept-edits or inherit.
    const title = `Harness ${args.role}${args.nodeId ? `: ${args.nodeId}` : ""}`.slice(0, 80);
    // Dispatch race guard, belt (deferred first dispatch below) and
    // suspenders (pre-spawn intent): note the intent synchronously
    // immediately before dispatch, including the exact child title, so a
    // configure that runs before the attempt mapping is persisted still
    // resolves this child's role. Covers every role: all spawns flow here.
    notePendingRoleSpawn({
      parentThreadId: parent.id,
      title,
      role: args.role,
      runId: args.run.id,
      nodeId: args.nodeId ?? null,
    });
    let child: { id: string };
    try {
      child = await bb.sdk.threads.spawn({
        prompt: args.prompt,
        parentThreadId: parent.id,
        projectId: parent.projectId,
        title,
        visibility: "visible",
        origin: "plugin",
        // Deferred first dispatch: the thread is created and returned now;
        // its first message stays queued until sendAt. The attempt/run mapping
        // persisted below is therefore in place before dispatch in the common
        // case; the pending intent above covers a configure that runs earlier.
        sendAt: Date.now() + ROLE_SPAWN_DISPATCH_DELAY_MS,
        ...(permissionMode ? { permissionMode: permissionMode as "accept-edits" } : {}),
        environment: { type: "reuse", environmentId: parent.environmentId },
        ...(choice
          ? {
              providerId: choice.providerId,
              model: choice.model,
              reasoningLevel: choice.reasoningLevel as never,
              ...(choice.serviceTier ? { serviceTier: choice.serviceTier } : {}),
              executionInputSources: {
                providerId: "explicit" as const,
                model: "explicit" as const,
                reasoningLevel: "explicit" as const,
                ...(choice.serviceTier ? { serviceTier: "explicit" as const } : {}),
              },
            }
          : {}),
      });
      const attemptId = randomUUID();
      try {
        db.prepare(
          `INSERT INTO harness_v3_attempts (id, run_id, node_id, role, child_thread_id, provider_id, model, reasoning, service_tier, permission_mode, status, output_hash, tokens_json, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, '{}', ?, NULL)`,
        ).run(
          attemptId, args.run.id, args.nodeId ?? null, args.role, child.id,
          choice?.providerId ?? null, choice?.model ?? null, choice?.reasoningLevel ?? null,
          choice?.serviceTier ?? null, permissionMode ?? null, Date.now(),
        );
      } catch (e) {
        // Spawn succeeded but the mapping did not persist: stop the orphan
        // child so it cannot run tool-less, then rethrow.
        try {
          await bb.sdk.threads.stop({ threadId: child.id });
        } catch {}
        throw e;
      }
      return { threadId: child.id, attemptId };
    } finally {
      // Withdraw the intent once spawn + attempt insert settle (success or
      // failure). Repeated configures while in flight keep resolving because
      // the intent is only removed here, never on use.
      unnotePendingRoleSpawn(parent.id, title);
    }
  }

  async function stopThreadBestEffort(threadId: string | null): Promise<void> {
    if (!threadId) return;
    try {
      await bb.sdk.threads.stop({ threadId });
    } catch {
      // Best effort; caller decides whether failure blocks the mutation.
    }
    try {
      db.prepare("UPDATE harness_v3_attempts SET status = 'stopped', ended_at = ? WHERE child_thread_id = ? AND ended_at IS NULL").run(Date.now(), threadId);
    } catch {}
  }

  // Newest structured report per node: stale attempts never authorize or
  // display as current evidence.
  function newestWorkerReports(runId: string): Array<{ node_id: string | null; attempt_id: string | null; payload: Record<string, unknown>; created_at: number }> {
    const byNode = new Map<string, { node_id: string | null; attempt_id: string | null; payload: Record<string, unknown>; created_at: number }>();
    for (const r of selReports.all(runId) as Array<{ kind: string; node_id: string | null; attempt_id: string | null; payload_json: string; created_at: number }>) {
      if (r.kind !== "worker") continue;
      let p: Record<string, unknown>;
      try {
        p = JSON.parse(r.payload_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      const key = r.node_id ?? String(p.nodeId ?? "");
      const prev = byNode.get(key);
      if (!prev || r.created_at >= prev.created_at) {
        byNode.set(key, { node_id: r.node_id, attempt_id: r.attempt_id, payload: p, created_at: r.created_at });
      }
    }
    return [...byNode.values()];
  }

  function latestReportsFor(runId: string): z.infer<typeof v3StatusSchema>["latestReports"] {
    const clip = (v: string, max: number): string => (v.length > max ? `${v.slice(0, max)}…` : v);
    const strList = (v: unknown, maxItems: number, maxChars: number): string[] =>
      (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string").slice(0, maxItems).map((s) => clip(s, maxChars));
    let exploration: z.infer<typeof v3StatusSchema>["latestReports"]["exploration"] = null;
    const worker: z.infer<typeof v3StatusSchema>["latestReports"]["worker"] = [];
    let critic: z.infer<typeof v3StatusSchema>["latestReports"]["critic"] = null;
    let promotion: z.infer<typeof v3StatusSchema>["latestReports"]["promotion"] = null;
    for (const r of selReports.all(runId) as Array<{ kind: string; node_id: string | null; payload_json: string; created_at: number }>) {
      let p: Record<string, unknown>;
      try {
        p = JSON.parse(r.payload_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (r.kind === "exploration") {
        exploration = {
          summary: clip(String(p.summary ?? ""), 2000),
          findings: strList(p.findings, 12, 400),
          risks: strList(p.risks, 8, 400),
          createdAt: r.created_at,
        };
      } else if (r.kind === "worker") {
        continue; // newest-per-node handled below via newestWorkerReports
      } else if (r.kind === "critic") {
        critic = {
          recommendation: String(p.recommendation ?? ""),
          findings: (Array.isArray(p.findings) ? p.findings : []).slice(0, 16).map((f) => {
            const rec = (f ?? {}) as Record<string, unknown>;
            const sev = String(rec.severity ?? "");
            return {
              severity: sev === "high" || sev === "medium" || sev === "low" ? sev : "medium",
              title: clip(String(rec.title ?? ""), 300),
              detail: clip(String(rec.detail ?? ""), 800),
            };
          }),
          affectedNodeIds: strList(p.affectedNodeIds, 16, 120),
          checksRerun: (Array.isArray(p.checksRerun) ? p.checksRerun : []).slice(0, 16).map((c) => {
            const rec = (c ?? {}) as Record<string, unknown>;
            return {
              command: clip(String(rec.command ?? ""), 300),
              exitCode: typeof rec.exitCode === "number" ? rec.exitCode : null,
              note: clip(String(rec.note ?? ""), 300),
            };
          }),
          unsupportedClaims: strList(p.unsupportedClaims, 8, 400),
          risks: strList(p.risks, 8, 300),
          createdAt: r.created_at,
        };
      } else if (r.kind === "promotion") {
        promotion = {
          audience: clip(String(p.audience ?? ""), 300),
          channel: clip(String(p.channel ?? ""), 300),
          summary: clip(String(p.summary ?? ""), 2000),
          claims: strList(p.claims, 12, 400),
          limitations: strList(p.limitations, 12, 400),
          createdAt: r.created_at,
        };
      }
    }
    for (const w of newestWorkerReports(runId)) {
      const p = w.payload;
      worker.push({
        nodeId: w.node_id ?? String(p.nodeId ?? ""),
        attemptId: w.attempt_id,
        outcome: String(p.outcome ?? ""),
        summary: clip(String(p.summary ?? ""), 2000),
        changedFiles: strList(p.changedFiles, 16, 200),
        acceptanceResults: (Array.isArray(p.acceptanceResults) ? p.acceptanceResults : []).slice(0, 16).map((a) => {
          const rec = (a ?? {}) as Record<string, unknown>;
          return { criterion: clip(String(rec.criterion ?? ""), 300), met: rec.met === true, note: clip(String(rec.note ?? ""), 300) };
        }),
        commands: (Array.isArray(p.commands) ? p.commands : []).slice(0, 16).map((c) => {
          const rec = (c ?? {}) as Record<string, unknown>;
          return {
            command: clip(String(rec.command ?? ""), 300),
            exitCode: typeof rec.exitCode === "number" ? rec.exitCode : null,
            output: clip(String(rec.output ?? ""), 500),
          };
        }),
        artifactRefs: strList(p.artifactRefs, 8, 200),
        risks: strList(p.risks, 8, 300),
        createdAt: w.created_at,
      });
    }
    return { exploration, worker, critic, promotion };
  }

  async function getV3Status(threadId: string, projectId: string): Promise<z.infer<typeof v3StatusSchema>> {
    // Resolve role children (and the Planner thread) to the run's home thread.
    const home = homeOf(threadId) ?? threadId;
    const run = getActiveRun(home) ?? ((selAnyRunByHome.get(home) as V3RunRow | undefined) ?? null);
    if (!run) return emptyStatus();
    if (run.project_id !== projectId) {
      throw new Error(`projectId ${projectId} does not match thread ${threadId}.`);
    }
    const nodes = nodesOf(run.id);
    const next = readyV3Nodes(nodes)[0] ?? null;
    const doneCount = nodes.filter((n) => n.status === "done").length;
    const decisions = (selDecisions.all(run.id) as Array<{ id: string; kind: string; actor: string; reason: string | null; node_ids: string; created_at: number }>)
      .map((d) => ({ id: d.id, kind: d.kind, actor: d.actor, reason: d.reason, nodeIds: parseJsonArray(d.node_ids), createdAt: d.created_at }));
    const artifacts = (selArtifacts.all(run.id) as Array<{ path: string; kind: string; node_id: string | null }>)
      .map((a) => ({ path: a.path, kind: a.kind, nodeId: a.node_id }));
    const preset = presetOf(run);
    const skillWarnings: string[] = [];
    for (const n of nodes) {
      for (const w of await validateSkillHints(n.skillHints)) skillWarnings.push(`${n.id}: ${w}`);
    }
    const providerWarnings = await validatePresetChoices(preset, run.environment_id ?? undefined);
    const packetRow = selPackets.get(run.id) as { packet_version: number } | undefined;
    const workerIndex = nodes.filter((n) => n.status === "done").length;
    const nextNodeRouting = next
      ? (() => {
          const routing = resolveNodeRouting({ preset, nodes, node: next, workerIndex });
          return { choice: routing.choice, source: routing.source };
        })()
      : null;
    return {
      run: {
        id: run.id,
        homeThreadId: run.home_thread_id,
        projectId: run.project_id,
        environmentId: run.environment_id,
        objective: run.objective,
        state: run.state as V3RunState,
        revision: run.revision,
        planRevision: run.plan_revision,
        draftRevision: run.draft_revision,
        plannerThreadId: run.planner_thread_id,
        explorerThreadId: run.explorer_thread_id,
        criticThreadId: run.critic_thread_id,
        promoterThreadId: run.promoter_thread_id,
        activeWorkerNodeId: run.active_worker_node_id,
        activeWorkerThreadId: run.active_worker_thread_id,
        preset,
        promotionChoice: run.promotion_choice,
        packetVersion: packetRow?.packet_version ?? 0,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
      },
      nodes: nodes.map((n) => ({ ...n, routingOverride: n.routingOverride ?? null })),
      nextNode: next ? { ...next, routingOverride: next.routingOverride ?? null } : null,
      doneCount,
      totalCount: nodes.length,
      stateCopy: v3StateCopy(run.state as V3RunState),
      skillWarnings: skillWarnings.slice(0, 8),
      providerWarnings: providerWarnings.slice(0, 8),
      decisions,
      artifacts,
      evaluation: run.evaluation ? (JSON.parse(run.evaluation) as never) : null,
      legacyNote: null,
      currentReviewApproved: freshApprovalAt(run.id) > 0,
      promotionSkipped: promotionSkippedForApproval(run.id),
      failedRoles: failedRolesFor(run),
      exportWarnings: exportWarningsFor(run.id),
      nextNodeRouting,
      latestReports: latestReportsFor(run.id),
    };
  }

  function emptyStatus(): z.infer<typeof v3StatusSchema> {
    return {
      run: null, nodes: [], nextNode: null, doneCount: 0, totalCount: 0,
      stateCopy: { title: "Harness is inactive", body: "Ordinary BB chat is the correct path for small, clear work. Start Harness only for branchy, risky, or multi-step work.", primary: "Start Harness" },
      skillWarnings: [], providerWarnings: [], decisions: [], artifacts: [], evaluation: null, legacyNote: null,
      currentReviewApproved: false,
      promotionSkipped: false,
      failedRoles: [],
      exportWarnings: [],
      nextNodeRouting: null,
      latestReports: { exploration: null, worker: [], critic: null, promotion: null },
    };
  }

  function ensurePreset(id: string | undefined, projectId: string): V3RolePreset {
    if (id) {
      const row = selPreset.get(id) as { payload_json: string } | undefined;
      if (!row) throw new Error(`Unknown preset ${id}.`);
      const parsed = validatePreset(JSON.parse(row.payload_json));
      if (!parsed.ok) throw new Error(`Preset ${id} is invalid: ${parsed.error}`);
      // Project presets belong to exactly one project.
      if (parsed.preset.scope === "project" && parsed.preset.projectId !== projectId) {
        throw new Error(`Preset ${id} belongs to another project.`);
      }
      return snapshotPreset(parsed.preset);
    }
    // Prefer migrated routing when present, else inherit-all.
    const migrated = selPreset.get("migrated-role-routing") as { payload_json: string } | undefined;
    if (migrated) {
      const parsed = validatePreset(JSON.parse(migrated.payload_json));
      if (parsed.ok) return snapshotPreset(parsed.preset);
    }
    return inheritPreset();
  }

  async function doStart(threadId: string, projectId: string, objective: string, presetId?: string, constraints?: string[], promotionChoice?: string, requestId?: string): Promise<void> {
    if (getActiveRun(threadId)) throw new Error("A Harness run is already active on this thread. Complete or cancel it first.");
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.projectId !== projectId) throw new Error(`projectId ${projectId} does not match thread ${threadId}.`);
    const preset = ensurePreset(presetId, projectId);
    const providerWarnings = await validatePresetChoices(preset, thread.environmentId ?? undefined);
    if (providerWarnings.length > 0) {
      throw new Error(`Cannot start: ${providerWarnings.join(" ")}`);
    }
    const runId = shortId();
    const now = Date.now();
    try {
      db.prepare(
        `INSERT INTO harness_v3_runs (id, home_thread_id, project_id, environment_id, objective, state, revision, plan_revision, draft_revision, planner_thread_id, explorer_thread_id, critic_thread_id, promoter_thread_id, active_worker_node_id, active_worker_thread_id, preset_snapshot, promotion_choice, evaluation, constraints_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'Setup', 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?)`,
      ).run(runId, threadId, projectId, thread.environmentId ?? null, objective.trim(), JSON.stringify(preset), promotionChoice ?? preset.promotionMode, JSON.stringify((constraints ?? []).slice(0, 24)), now, now);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE")) throw new Error("A Harness run is already active on this thread.");
      throw e;
    }
    recordV3Mutation({ runId, action: "run.start", actor: "operator", source: requestId?.startsWith("tool:") ? "tool" : "rpc", requestId: requestId ?? `v3-start:${randomUUID()}`, reason: objective.trim() });
    // Start the actual flow: create the Planner workspace thread immediately.
    // A failed spawn compensates into Cancelled (retryable via a fresh Start)
    // instead of stranding the run in Setup with no action.
    let run = selRunById.get(runId) as V3RunRow;
    const packet = await buildPacketForRun(run, "planner", null);
    let plannerId: string;
    let attemptId: string;
    try {
      ({ threadId: plannerId, attemptId } = await spawnRoleThread({
        run,
        role: "planner",
        parentThreadId: threadId,
        prompt: plannerPrompt(packet),
      }));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      db.prepare("UPDATE harness_v3_runs SET state = 'Cancelled', revision = revision + 1, updated_at = ? WHERE id = ?").run(Date.now(), runId);
      db.prepare("INSERT INTO harness_v3_decisions (id, run_id, kind, actor, reason, node_ids, created_at) VALUES (?, ?, 'run_cancelled', 'system', ?, '[]', ?)").run(randomUUID(), runId, `Planner spawn failed: ${reason}`, Date.now());
      recordV3Mutation({ runId, action: "run.start_failed", actor: "system", source: "run", requestId: `v3-start-failed:${randomUUID()}`, reason });
      publish();
      throw new Error(`Harness start failed and was compensated: ${reason} Fix routing or provider state, then start again.`);
    }
    db.prepare("UPDATE harness_v3_runs SET planner_thread_id = ?, state = 'Exploring', revision = revision + 1, updated_at = ? WHERE id = ?").run(plannerId, Date.now(), runId);
    run = selRunById.get(runId) as V3RunRow;
    recordV3Mutation({ runId, action: "planner.spawn", actor: "operator", source: "run", requestId: `v3-planner:${randomUUID()}`, attemptId: attemptId!, childThreadId: plannerId! });
    // Export the initial task packet for handoff.
    try {
      await writeRunFile(runId, threadId, `${artifactDirForRun(runId)}/task-packet.json`, `${JSON.stringify(packet, null, 2)}\n`, "task-packet", null);
    } catch {}
    publish();
  }

  async function doRunExplorer(homeThreadId: string, questions: string[] | undefined, actor: string, source: string, requestId: string): Promise<void> {
    const run = getActiveRun(homeThreadId);
    if (!run) throw new Error("No active Harness run. Start one first.");
    if (run.state !== "Exploring") throw new Error(`Explorer can only run in Exploring (current: ${run.state}).`);
    if (!run.planner_thread_id) throw new Error("Planner thread is missing; cannot dispatch Explorer.");
    if (run.explorer_thread_id) throw new Error("Explorer is already running. Retry or stop it first.");
    await buildPacketForRun(run, "explorer", null);
    const prompt = explorerPrompt({ objective: run.objective, constraints: readConstraints(run), questions: questions ?? [] });
    // Spawn Explorer as a child of Planner so provider isolation holds.
    const { threadId: childId, attemptId } = await spawnRoleThread({
      run,
      role: "explorer",
      parentThreadId: run.planner_thread_id,
      prompt,
    });
    db.prepare("UPDATE harness_v3_runs SET explorer_thread_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(childId, Date.now(), run.id);
    recordV3Mutation({ runId: run.id, action: "explorer.spawn", actor, source, requestId, attemptId, childThreadId: childId });
    publish();
  }

  // ---- RPC handlers ----
  const handlers = {
    v3Status: async ({ threadId, projectId }: { threadId: string; projectId?: string }) => {
      const resolved = await resolveProjectId(threadId, projectId);
      return getV3Status(threadId, resolved);
    },
    v3Start: async (input: { threadId: string; projectId?: string; objective: string; presetId?: string; constraints?: string[]; promotionChoice?: "ask" | "off" | "always" }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      await doStart(input.threadId, resolved, input.objective, input.presetId, input.constraints, input.promotionChoice, `v3-start:${randomUUID()}`);
      return getV3Status(input.threadId, resolved);
    },
    v3RunExplorer: async (input: { threadId: string; projectId?: string; questions?: string[] }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      await doRunExplorer(input.threadId, input.questions, "operator", "rpc", `v3-explorer:${randomUUID()}`);
      return getV3Status(input.threadId, resolved);
    },
    v3AcceptExploration: async (input: { threadId: string; projectId?: string; expectedRevision: number; requestId: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const run = activeRunFor(input.threadId);
      if (!run) throw new Error("No active run.");
      requireRevision(run, input.expectedRevision);
      if (run.state !== "Exploring") throw new Error(`Exploration can only be accepted in Exploring (current: ${run.state}).`);
      const reports = selReports.all(run.id) as Array<{ kind: string }>;
      if (!reports.some((r) => r.kind === "exploration")) throw new Error("No exploration report yet. Wait for Explorer or skip with a reason.");
      const next = transition(run, "Planning", input.expectedRevision);
      db.prepare("INSERT INTO harness_v3_decisions (id, run_id, kind, actor, reason, node_ids, created_at) VALUES (?, ?, 'exploration_accepted', 'operator', NULL, '[]', ?)").run(randomUUID(), run.id, Date.now());
      recordV3Mutation({ runId: run.id, action: "exploration.accept", actor: "operator", source: "rpc", requestId: input.requestId, expectedRevision: input.expectedRevision });
      await exportReportOrPend(run.id, "exploration", null);
      void next;
      publish();
      return getV3Status(input.threadId, resolved);
    },
    v3SkipExploration: async (input: { threadId: string; projectId?: string; reason: string; expectedRevision: number; requestId: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const run = activeRunFor(input.threadId);
      if (!run) throw new Error("No active run.");
      requireRevision(run, input.expectedRevision);
      if (run.state !== "Exploring") throw new Error(`Can only skip in Exploring (current: ${run.state}).`);
      await stopThreadBestEffort(run.explorer_thread_id);
      const next = transition(run, "Planning", input.expectedRevision);
      db.prepare("INSERT INTO harness_v3_decisions (id, run_id, kind, actor, reason, node_ids, created_at) VALUES (?, ?, 'exploration_skipped', 'operator', ?, '[]', ?)").run(randomUUID(), run.id, input.reason, Date.now());
      recordV3Mutation({ runId: run.id, action: "exploration.skip", actor: "operator", source: "rpc", requestId: input.requestId, reason: input.reason, expectedRevision: input.expectedRevision });
      void next;
      publish();
      return getV3Status(input.threadId, resolved);
    },
    v3ApprovePlan: async (input: { threadId: string; projectId?: string; expectedRevision: number; requestId: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const run = activeRunFor(input.threadId);
      if (!run) throw new Error("No active run.");
      requireRevision(run, input.expectedRevision);
      if (run.state !== "PlanApproval") throw new Error(`Plan can only be approved in PlanApproval (current: ${run.state}).`);
      const nodes = nodesOf(run.id);
      if (nodes.length === 0) throw new Error("No draft DAG to approve.");
      const next = transition(run, "Executing", input.expectedRevision);
      db.prepare("UPDATE harness_v3_runs SET plan_revision = draft_revision WHERE id = ?").run(run.id);
      db.prepare("INSERT INTO harness_v3_decisions (id, run_id, kind, actor, reason, node_ids, created_at) VALUES (?, ?, 'plan_approved', 'operator', NULL, '[]', ?)").run(randomUUID(), run.id, Date.now());
      recordV3Mutation({ runId: run.id, action: "plan.approve", actor: "operator", source: "rpc", requestId: input.requestId, expectedRevision: input.expectedRevision, detail: { revision: next.plan_revision } });
      const fresh = selRunById.get(run.id) as V3RunRow;
      try {
        const packet = await buildPacketForRun(fresh, "planner", null);
        const ws = await resolveWorkspace(input.threadId).catch(() => null);
        if (ws) {
          await writeRunFile(run.id, input.threadId, `${artifactDirForRun(run.id)}/plan.md`, generatePlanMarkdown({ runId: run.id, objective: run.objective, revision: fresh.plan_revision || fresh.draft_revision, nodes }), "plan", null);
          void packet;
        }
      } catch {}
      publish();
      return getV3Status(input.threadId, resolved);
    },
    v3RequestPlanRevision: async (input: { threadId: string; projectId?: string; reason: string; expectedRevision: number; requestId: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const run = activeRunFor(input.threadId);
      if (!run) throw new Error("No active run.");
      requireRevision(run, input.expectedRevision);
      if (run.state !== "PlanApproval") throw new Error(`Can only request revision in PlanApproval (current: ${run.state}).`);
      transition(run, "Planning", input.expectedRevision);
      recordV3Mutation({ runId: run.id, action: "plan.request_revision", actor: "operator", source: "rpc", requestId: input.requestId, reason: input.reason, expectedRevision: input.expectedRevision });
      publish();
      return getV3Status(input.threadId, resolved);
    },
    v3RunNextWorker: async (input: { threadId: string; projectId?: string; expectedRevision: number; requestId: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const run = activeRunFor(input.threadId);
      if (!run) throw new Error("No active run.");
      requireRevision(run, input.expectedRevision);
      if (run.state !== "Executing") throw new Error(`Workers run in Executing (current: ${run.state}).`);
      if (run.active_worker_thread_id) throw new Error("A Worker is already active. Review it before starting another.");
      const nodes = nodesOf(run.id);
      const next = readyV3Nodes(nodes)[0];
      if (!next) {
        // No ready nodes: either all done (move to Critiquing) or blocked.
        if (allRequiredDone(nodes)) {
          transition(run, "Critiquing", input.expectedRevision);
          recordV3Mutation({ runId: run.id, action: "critic.ready", actor: "system", source: "run", requestId: input.requestId, expectedRevision: input.expectedRevision });
          publish();
          return getV3Status(input.threadId, resolved);
        }
        throw new Error("No ready Worker nodes. Unblocked dependencies are missing.");
      }
      const workerIndex = nodes.filter((n) => n.status === "done").length;
      const preset = presetOf(run);
      const role = workerRoleForIndex(workerIndex);
      const routing = resolveNodeRouting({ preset, nodes, node: next, workerIndex });
      const packet = await buildPacketForRun(run, "worker", next.id);
      const plannerParent = run.planner_thread_id ?? input.threadId;
      const rolePermission = preset.roles[role]?.permissionMode ?? null;
      const { threadId: childId, attemptId } = await spawnRoleThread({
        run,
        role,
        parentThreadId: plannerParent,
        prompt: workerPrompt(packet, next),
        nodeId: next.id,
        choice: routing.choice,
        permissionMode: rolePermission,
      });
      db.prepare("UPDATE harness_v3_work_nodes SET status = 'running', attempt_id = ? WHERE run_id = ? AND node_id = ?").run(attemptId, run.id, next.id);
      db.prepare("UPDATE harness_v3_runs SET active_worker_node_id = ?, active_worker_thread_id = ?, state = 'WorkerReview', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?").run(next.id, childId, Date.now(), run.id, input.expectedRevision);
      const check = selRunById.get(run.id) as V3RunRow;
      if (check.revision !== input.expectedRevision + 1) throw new Error("Run revision claim was lost. Refresh and retry.");
      recordV3Mutation({ runId: run.id, action: "worker.spawn", actor: "operator", source: "rpc", requestId: input.requestId, expectedRevision: input.expectedRevision, attemptId, childThreadId: childId, detail: { nodeId: next.id, role, routingSource: routing.source } });
      publish();
      return getV3Status(input.threadId, resolved);
    },
    v3ReviewWorker: async (input: { threadId: string; projectId?: string; nodeId: string; approve: boolean; changes?: string; expectedRevision: number; requestId: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const run = activeRunFor(input.threadId);
      if (!run) throw new Error("No active run.");
      requireRevision(run, input.expectedRevision);
      if (run.state !== "WorkerReview") throw new Error(`Worker review happens in WorkerReview (current: ${run.state}).`);
      const nodes = nodesOf(run.id);
      const node = nodes.find((n) => n.id === input.nodeId);
      if (!node) throw new Error(`Unknown node ${input.nodeId}.`);
      if (node.status !== "awaiting_review" && node.status !== "running") throw new Error(`Node ${node.id} is not awaiting review (status: ${node.status}).`);
      const newest = newestWorkerReports(run.id).find((w) => (w.node_id ?? String(w.payload.nodeId ?? "")) === node.id);
      if (input.approve) {
        // The report must belong to the CURRENT attempt: after REWORK/retry,
        // a historical report can never approve the new running attempt.
        if (!newest || newest.attempt_id !== node.attemptId) {
          throw new Error("No Worker report for the current attempt yet. Wait for harness_submit_worker_report.");
        }
        if (newest.payload.outcome !== "complete") {
          throw new Error(`Cannot accept: the worker reported "${newest.payload.outcome ?? "unknown"}". Request changes instead.`);
        }
        const remaining = nodes.filter((n) => n.id !== node.id && n.status !== "done" && n.status !== "skipped");
        // Accepting the final Worker moves straight to Critiquing so the run
        // never idles in Executing with no ready node and no Critic action.
        const nextState = remaining.length === 0 ? "Critiquing" : "Executing";
        db.prepare("UPDATE harness_v3_work_nodes SET status = 'done' WHERE run_id = ? AND node_id = ?").run(run.id, node.id);
        db.prepare("UPDATE harness_v3_runs SET active_worker_node_id = NULL, active_worker_thread_id = NULL, state = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(nextState, Date.now(), run.id);
        db.prepare("INSERT INTO harness_v3_decisions (id, run_id, kind, actor, reason, node_ids, created_at) VALUES (?, ?, 'worker_accepted', 'operator', NULL, ?, ?)").run(randomUUID(), run.id, JSON.stringify([node.id]), Date.now());
        recordV3Mutation({ runId: run.id, action: "worker.accept", actor: "operator", source: "rpc", requestId: input.requestId, expectedRevision: input.expectedRevision, detail: { nodeId: node.id, nextState } });
        await exportReportOrPend(run.id, "worker", node.id);
      } else {
        if (!input.changes?.trim()) throw new Error("Requesting changes requires a changes description.");
        // plan-change-needed returns to Planning so the DAG itself is revised;
        // other changes re-queue the node for another Worker attempt.
        const backToPlanning = newest?.payload.outcome === "plan-change-needed";
        const backState = backToPlanning ? "Planning" : "Executing";
        db.prepare("UPDATE harness_v3_work_nodes SET status = 'pending', attempt_id = NULL WHERE run_id = ? AND node_id = ?").run(run.id, node.id);
        db.prepare("UPDATE harness_v3_runs SET active_worker_node_id = NULL, active_worker_thread_id = NULL, state = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(backState, Date.now(), run.id);
        db.prepare("INSERT INTO harness_v3_decisions (id, run_id, kind, actor, reason, node_ids, created_at) VALUES (?, ?, 'worker_changes_requested', 'operator', ?, ?, ?)").run(randomUUID(), run.id, input.changes, JSON.stringify([node.id]), Date.now());
        recordV3Mutation({ runId: run.id, action: "worker.changes", actor: "operator", source: "rpc", requestId: input.requestId, reason: input.changes, expectedRevision: input.expectedRevision, detail: { nodeId: node.id, backState } });
      }
      publish();
      return getV3Status(input.threadId, resolved);
    },
    v3SetNodeRouting: async (input: { threadId: string; projectId?: string; nodeId: string; choice: { providerId: string; model: string; reasoningLevel: string; serviceTier?: "default" | "fast" } | null; expectedRevision: number; requestId: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const run = activeRunFor(input.threadId);
      if (!run) throw new Error("No active run.");
      requireRevision(run, input.expectedRevision);
      const nodes = nodesOf(run.id);
      const node = nodes.find((n) => n.id === input.nodeId);
      if (!node) throw new Error(`Unknown node ${input.nodeId}.`);
      if (node.status !== "pending" && node.status !== "ready" && node.status !== "invalidated") {
        throw new Error(`Node ${node.id} is already claimed (${node.status}); overrides lock after claim.`);
      }
      db.prepare("UPDATE harness_v3_work_nodes SET routing_override = ? WHERE run_id = ? AND node_id = ?").run(input.choice ? JSON.stringify(input.choice) : null, run.id, node.id);
      db.prepare("UPDATE harness_v3_runs SET revision = revision + 1, updated_at = ? WHERE id = ?").run(Date.now(), run.id);
      recordV3Mutation({ runId: run.id, action: "node.routing_set", actor: "operator", source: "rpc", requestId: input.requestId, expectedRevision: input.expectedRevision, detail: { nodeId: node.id } });
      publish();
      return getV3Status(input.threadId, resolved);
    },
    v3StartCritic: async (input: { threadId: string; projectId?: string; expectedRevision: number; requestId: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const run = activeRunFor(input.threadId);
      if (!run) throw new Error("No active run.");
      requireRevision(run, input.expectedRevision);
      const nodes = nodesOf(run.id);
      if (!allRequiredDone(nodes)) throw new Error("Critic cannot start until every required Worker node is done.");
      if (run.state !== "Executing" && run.state !== "Critiquing") throw new Error(`Critic starts from Executing (current: ${run.state}).`);
      if (run.critic_thread_id) {
        const attempt = db.prepare("SELECT status FROM harness_v3_attempts WHERE child_thread_id = ? ORDER BY started_at DESC LIMIT 1").get(run.critic_thread_id) as { status: string } | undefined;
        if (!attempt || attempt.status === "running") throw new Error("Critic is already running.");
      }
      // Idempotent when already Critiquing (e.g. after final Worker
      // acceptance): spawn the Critic without a self-transition.
      if (run.state !== "Critiquing") transition(run, "Critiquing", input.expectedRevision);
      const fresh = selRunById.get(run.id) as V3RunRow;
      const packet = await buildPacketForRun(fresh, "critic", null);
      const { threadId: childId, attemptId } = await spawnRoleThread({ run: fresh, role: "critic", parentThreadId: fresh.planner_thread_id ?? input.threadId, prompt: criticPrompt(packet) });
      db.prepare("UPDATE harness_v3_runs SET critic_thread_id = ? WHERE id = ?").run(childId, run.id);
      recordV3Mutation({ runId: run.id, action: "critic.spawn", actor: "operator", source: "rpc", requestId: input.requestId, expectedRevision: input.expectedRevision, attemptId, childThreadId: childId });
      publish();
      return getV3Status(input.threadId, resolved);
    },
    v3ReviewCritic: async (input: { threadId: string; projectId?: string; decision: "APPROVE" | "REWORK" | "BLOCK"; nodeIds?: string[]; reason: string; expectedRevision: number; requestId: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const run = activeRunFor(input.threadId);
      if (!run) throw new Error("No active run.");
      requireRevision(run, input.expectedRevision);
      if (run.state !== "FinalReview" && run.state !== "Critiquing") throw new Error(`Critic decision happens in FinalReview (current: ${run.state}).`);
      const latestReport = latestCriticReport(run.id);
      if (!latestReport) throw new Error("No Critic report yet. Wait for harness_submit_critic_report.");
      // One operator decision per Critic report: a recorded decision already
      // answers the current report. Retry the Critic for a new report first.
      if (decidedForCurrentReport(run.id)) {
        throw new Error("An operator decision is already recorded for the current Critic report. Retry the Critic role for a fresh report before deciding again.");
      }
      const nodes = nodesOf(run.id);
      if (input.decision === "APPROVE") {
        db.prepare("INSERT INTO harness_v3_decisions (id, run_id, kind, actor, reason, node_ids, created_at, report_id) VALUES (?, ?, 'critic_approved', 'operator', ?, '[]', ?, ?)").run(randomUUID(), run.id, input.reason, Date.now(), latestReport.id);
        recordV3Mutation({ runId: run.id, action: "critic.approve", actor: "operator", source: "rpc", requestId: input.requestId, reason: input.reason, expectedRevision: input.expectedRevision });
        // Stay in FinalReview; promotion start/skip and completion are
        // explicit operator steps (promotion 'always' still asks in v0.2).
        db.prepare("UPDATE harness_v3_runs SET state = 'FinalReview', revision = revision + 1, updated_at = ? WHERE id = ?").run(Date.now(), run.id);
        // Stay in FinalReview; Complete/Promote are explicit next steps.
      } else if (input.decision === "BLOCK") {
        db.prepare("UPDATE harness_v3_runs SET state = 'Blocked', revision = revision + 1, updated_at = ? WHERE id = ?").run(Date.now(), run.id);
        db.prepare("INSERT INTO harness_v3_decisions (id, run_id, kind, actor, reason, node_ids, created_at, report_id) VALUES (?, ?, 'critic_blocked', 'operator', ?, ?, ?, ?)").run(randomUUID(), run.id, input.reason, JSON.stringify(input.nodeIds ?? []), Date.now(), latestReport.id);
        recordV3Mutation({ runId: run.id, action: "critic.block", actor: "operator", source: "rpc", requestId: input.requestId, reason: input.reason, expectedRevision: input.expectedRevision });
      } else {
        const targets = input.nodeIds ?? [];
        if (targets.length === 0) throw new Error("REWORK must select affected node IDs.");
        for (const id of targets) {
          if (!nodes.some((n) => n.id === id)) throw new Error(`Unknown rework target ${id}.`);
        }
        const affected = downstreamV3(nodes, targets);
        const tx = db.transaction(() => {
          for (const n of nodes) {
            if (affected.has(n.id)) {
              db.prepare("UPDATE harness_v3_work_nodes SET status = 'invalidated', attempt_id = NULL WHERE run_id = ? AND node_id = ?").run(run.id, n.id);
            }
          }
          db.prepare("UPDATE harness_v3_runs SET state = 'Executing', active_worker_node_id = NULL, active_worker_thread_id = NULL, critic_thread_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(Date.now(), run.id);
          db.prepare("INSERT INTO harness_v3_decisions (id, run_id, kind, actor, reason, node_ids, created_at, report_id) VALUES (?, ?, 'critic_rework', 'operator', ?, ?, ?, ?)").run(randomUUID(), run.id, input.reason, JSON.stringify([...affected]), Date.now(), latestReport.id);
        });
        tx();
        // Unrelated completed nodes remain accepted: only affected/downstream invalidated.
        recordV3Mutation({ runId: run.id, action: "critic.rework", actor: "operator", source: "rpc", requestId: input.requestId, reason: input.reason, expectedRevision: input.expectedRevision, detail: { affected: [...affected] } });
      }
      await exportReportOrPend(run.id, "critic", null);
      publish();
      return getV3Status(input.threadId, resolved);
    },
    v3Promote: async (input: { threadId: string; projectId?: string; start: boolean; audience?: string; channel?: string; expectedRevision: number; requestId: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const run = activeRunFor(input.threadId);
      if (!run) throw new Error("No active run.");
      requireRevision(run, input.expectedRevision);
      if (run.state !== "FinalReview" && run.state !== "Promoting") throw new Error(`Promotion follows FinalReview (current: ${run.state}).`);
      // Promotion is authorized by a FRESH Critic approval only: an approval
      // from before the latest Critic report (e.g. pre-REWORK) authorizes nothing.
      if (!freshApprovalAt(run.id)) {
        throw new Error("Promotion needs a current Critic approval. Record an operator decision on the latest Critic report first.");
      }
      if (!input.start) {
        // Skip is idempotent and one-way per review: a repeat records nothing.
        if (promotionSkippedForApproval(run.id)) {
          return getV3Status(input.threadId, resolved);
        }
        const skipReport = latestCriticReport(run.id);
        db.prepare("INSERT INTO harness_v3_decisions (id, run_id, kind, actor, reason, node_ids, created_at, report_id) VALUES (?, ?, 'promotion_skipped', 'operator', NULL, '[]', ?, ?)").run(randomUUID(), run.id, Date.now(), skipReport?.id ?? null);
        recordV3Mutation({ runId: run.id, action: "promotion.skip", actor: "operator", source: "rpc", requestId: input.requestId, expectedRevision: input.expectedRevision });
        publish();
        return getV3Status(input.threadId, resolved);
      }
      if (run.promotion_choice === "off") throw new Error("Promotion is off for this run.");
      if (run.promoter_thread_id) {
        const attempt = db.prepare("SELECT status FROM harness_v3_attempts WHERE child_thread_id = ? ORDER BY started_at DESC LIMIT 1").get(run.promoter_thread_id) as { status: string } | undefined;
        if (!attempt || attempt.status === "running") throw new Error("Promoter is already running.");
      }
      if (run.state !== "Promoting") transition(run, "Promoting", input.expectedRevision);
      const fresh = selRunById.get(run.id) as V3RunRow;
      const packet = await buildPacketForRun(fresh, "promoter", null);
      const { threadId: childId, attemptId } = await spawnRoleThread({ run: fresh, role: "promoter", parentThreadId: fresh.planner_thread_id ?? input.threadId, prompt: promoterPrompt({ audience: input.audience ?? "", channel: input.channel ?? "", packet }) });
      db.prepare("UPDATE harness_v3_runs SET promoter_thread_id = ? WHERE id = ?").run(childId, run.id);
      db.prepare("INSERT INTO harness_v3_decisions (id, run_id, kind, actor, reason, node_ids, created_at) VALUES (?, ?, 'promotion_started', 'operator', ?, '[]', ?)").run(randomUUID(), run.id, input.audience ?? null, Date.now());
      recordV3Mutation({ runId: run.id, action: "promotion.start", actor: "operator", source: "rpc", requestId: input.requestId, expectedRevision: input.expectedRevision, attemptId, childThreadId: childId });
      publish();
      return getV3Status(input.threadId, resolved);
    },
    v3Complete: async (input: { threadId: string; projectId?: string; outcome?: "useful" | "neutral" | "costly"; note?: string; expectedRevision: number; requestId: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const run = activeRunFor(input.threadId);
      if (!run) throw new Error("No active run.");
      requireRevision(run, input.expectedRevision);
      const approvalDecisions = decisionsOf(run.id);
      if (!freshApprovalAt(run.id)) throw new Error("Completion requires a current Critic approval. Approvals do not carry over REWORK: decide on the latest Critic report first.");
      const nodes = nodesOf(run.id);
      if (!allRequiredDone(nodes)) throw new Error("Completion requires a terminal DAG (all nodes done/skipped).");
      if (run.state !== "FinalReview" && run.state !== "Promoting") throw new Error(`Complete from FinalReview/Promoting (current: ${run.state}).`);
      if (run.state === "Promoting") {
        const reports = selReports.all(run.id) as Array<{ kind: string }>;
        if (!reports.some((r) => r.kind === "promotion")) {
          throw new Error("Promotion started but no promotion report yet. Wait for harness_submit_promotion or skip promotion from FinalReview.");
        }
      }
      const attempts = selAttempts.all(run.id) as Array<{ status: string }>;
      const evaluation = {
        outcome: input.outcome ?? null,
        reworkCount: approvalDecisions.filter((d) => d.kind === "critic_rework").length,
        acceptedAttempts: attempts.filter((a) => a.status === "done" || a.status === "idle_with_output").length,
        failedAttempts: attempts.filter((a) => a.status === "failed").length,
        elapsedMs: Date.now() - run.created_at,
        note: input.note ?? null,
      };
      // Stop any lingering role threads before marking complete (no orphans).
      await stopThreadBestEffort(run.explorer_thread_id);
      await stopThreadBestEffort(run.active_worker_thread_id);
      await stopThreadBestEffort(run.critic_thread_id);
      await stopThreadBestEffort(run.promoter_thread_id);
      db.prepare("UPDATE harness_v3_runs SET state = 'Complete', evaluation = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(evaluation), Date.now(), run.id);
      db.prepare("INSERT INTO harness_v3_decisions (id, run_id, kind, actor, reason, node_ids, created_at) VALUES (?, ?, 'run_completed', 'operator', ?, '[]', ?)").run(randomUUID(), run.id, input.note ?? null, Date.now());
      recordV3Mutation({ runId: run.id, action: "run.complete", actor: "operator", source: "rpc", requestId: input.requestId, expectedRevision: input.expectedRevision, detail: { evaluation } });
      try {
        const artifacts = (selArtifacts.all(run.id) as Array<{ path: string; kind: string; node_id: string | null }>).map((a) => ({ path: a.path, kind: a.kind, nodeId: a.node_id }));
        await writeRunFile(run.id, input.threadId, `${artifactDirForRun(run.id)}/manifest.json`, `${generateManifest({ runId: run.id, revision: run.revision + 1, artifacts: artifacts.map((a) => ({ path: a.path, kind: a.kind, nodeId: a.nodeId })) })}\n`, "manifest", null).catch(() => undefined);
      } catch {}
      publish();
      return getV3Status(input.threadId, resolved);
    },
    v3Cancel: async (input: { threadId: string; projectId?: string; reason: string; expectedRevision: number; requestId: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const run = activeRunFor(input.threadId);
      if (!run) throw new Error("No active run.");
      requireRevision(run, input.expectedRevision);
      // Cancel whole run only after all children stop.
      const children = [run.planner_thread_id, run.explorer_thread_id, run.active_worker_thread_id, run.critic_thread_id, run.promoter_thread_id].filter(Boolean) as string[];
      for (const child of children) {
        try {
          await bb.sdk.threads.stop({ threadId: child });
        } catch (e) {
          throw new Error(`Cannot cancel: failed to stop child ${child}. ${(e as Error).message ?? e}`);
        }
      }
      db.prepare("UPDATE harness_v3_runs SET state = 'Cancelled', revision = revision + 1, updated_at = ? WHERE id = ?").run(Date.now(), run.id);
      db.prepare("INSERT INTO harness_v3_decisions (id, run_id, kind, actor, reason, node_ids, created_at) VALUES (?, ?, 'run_cancelled', 'operator', ?, '[]', ?)").run(randomUUID(), run.id, input.reason, Date.now());
      recordV3Mutation({ runId: run.id, action: "run.cancel", actor: "operator", source: "rpc", requestId: input.requestId, reason: input.reason, expectedRevision: input.expectedRevision });
      publish();
      return getV3Status(input.threadId, resolved);
    },
    v3RetryRole: async (input: { threadId: string; projectId?: string; role: string; nodeId?: string; expectedRevision: number; requestId: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const run = activeRunFor(input.threadId);
      if (!run) throw new Error("No active run.");
      requireRevision(run, input.expectedRevision);
      // Retry = stop current attempt (if any) and respawn for that role.
      if (input.role === "planner") {
        await stopThreadBestEffort(run.planner_thread_id);
        const fresh = selRunById.get(run.id) as V3RunRow;
        const packet = await buildPacketForRun(fresh, "planner", null);
        const { threadId: childId, attemptId } = await spawnRoleThread({
          run: fresh,
          role: "planner",
          parentThreadId: input.threadId,
          prompt: plannerPrompt(packet),
        });
        db.prepare("UPDATE harness_v3_runs SET planner_thread_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(childId, Date.now(), run.id);
        recordV3Mutation({ runId: run.id, action: "planner.retry", actor: "operator", source: "rpc", requestId: input.requestId, expectedRevision: input.expectedRevision, attemptId, childThreadId: childId });
        publish();
        return getV3Status(input.threadId, resolved);
      }
      if (input.role === "explorer") {
        await stopThreadBestEffort(run.explorer_thread_id);
        db.prepare("UPDATE harness_v3_runs SET explorer_thread_id = NULL, revision = revision + 1 WHERE id = ?").run(run.id);
        recordV3Mutation({ runId: run.id, action: "explorer.retry", actor: "operator", source: "rpc", requestId: input.requestId, expectedRevision: input.expectedRevision });
        publish();
        return getV3Status(input.threadId, resolved);
      }
      if (input.role === "worker" || input.role === "workerFirst" || input.role === "workerRest") {
        if (!input.nodeId) throw new Error("Retry worker needs a nodeId.");
        const nodes = nodesOf(run.id);
        const node = nodes.find((n) => n.id === input.nodeId);
        if (!node) throw new Error(`Unknown node ${input.nodeId}.`);
        await stopThreadBestEffort(run.active_worker_thread_id);
        db.prepare("UPDATE harness_v3_work_nodes SET status = 'pending', attempt_id = NULL WHERE run_id = ? AND node_id = ?").run(run.id, node.id);
        db.prepare("UPDATE harness_v3_runs SET active_worker_node_id = NULL, active_worker_thread_id = NULL, state = 'Executing', revision = revision + 1 WHERE id = ?").run(run.id);
        recordV3Mutation({ runId: run.id, action: "worker.retry", actor: "operator", source: "rpc", requestId: input.requestId, expectedRevision: input.expectedRevision, detail: { nodeId: node.id } });
        publish();
        return getV3Status(input.threadId, resolved);
      }
      if (input.role === "critic") {
        await stopThreadBestEffort(run.critic_thread_id);
        db.prepare("UPDATE harness_v3_runs SET critic_thread_id = NULL, state = 'Executing', revision = revision + 1 WHERE id = ?").run(run.id);
        recordV3Mutation({ runId: run.id, action: "critic.retry", actor: "operator", source: "rpc", requestId: input.requestId, expectedRevision: input.expectedRevision });
        publish();
        return getV3Status(input.threadId, resolved);
      }
      if (input.role === "promoter") {
        await stopThreadBestEffort(run.promoter_thread_id);
        db.prepare("UPDATE harness_v3_runs SET promoter_thread_id = NULL, revision = revision + 1 WHERE id = ?").run(run.id);
        recordV3Mutation({ runId: run.id, action: "promotion.retry", actor: "operator", source: "rpc", requestId: input.requestId, expectedRevision: input.expectedRevision });
        publish();
        return getV3Status(input.threadId, resolved);
      }
      throw new Error(`Unknown role "${input.role}". Retry explorer, planner, worker, critic, or promoter.`);
    },
    v3RetryExport: async (input: { threadId: string; projectId?: string; expectedRevision: number; requestId: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const run = activeRunFor(input.threadId);
      if (!run) throw new Error("No active run.");
      requireRevision(run, input.expectedRevision);
      const { exported, warnings } = await retryPendingExports(run.id);
      recordV3Mutation({ runId: run.id, action: "export.retry", actor: "operator", source: "rpc", requestId: input.requestId, expectedRevision: input.expectedRevision, detail: { exported } });
      publish();
      const status = await getV3Status(input.threadId, resolved);
      return { status, exported, warnings };
    },
    v3StopRole: async (input: { threadId: string; projectId?: string; role: string; nodeId?: string; expectedRevision: number; requestId: string; reason?: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const run = activeRunFor(input.threadId);
      if (!run) throw new Error("No active run.");
      requireRevision(run, input.expectedRevision);
      const normalizedRole = input.role === "workerFirst" || input.role === "workerRest" ? "worker" : input.role;
      const target =
        normalizedRole === "explorer" ? run.explorer_thread_id :
        normalizedRole === "worker" ? run.active_worker_thread_id :
        normalizedRole === "critic" ? run.critic_thread_id : run.promoter_thread_id;
      if (!target) throw new Error(`No active ${input.role} thread to stop.`);
      try {
        await bb.sdk.threads.stop({ threadId: target });
      } catch (e) {
        throw new Error(`Cannot stop ${input.role}: ${(e as Error).message ?? e}`);
      }
      if (normalizedRole === "worker" && input.nodeId) {
        db.prepare("UPDATE harness_v3_work_nodes SET status = 'pending', attempt_id = NULL WHERE run_id = ? AND node_id = ?").run(run.id, input.nodeId);
        db.prepare("UPDATE harness_v3_runs SET active_worker_node_id = NULL, active_worker_thread_id = NULL, state = 'Executing', revision = revision + 1 WHERE id = ?").run(run.id);
      } else if (normalizedRole === "explorer") {
        db.prepare("UPDATE harness_v3_runs SET explorer_thread_id = NULL, revision = revision + 1 WHERE id = ?").run(run.id);
      } else if (normalizedRole === "critic") {
        db.prepare("UPDATE harness_v3_runs SET critic_thread_id = NULL, revision = revision + 1 WHERE id = ?").run(run.id);
      } else {
        db.prepare("UPDATE harness_v3_runs SET promoter_thread_id = NULL, revision = revision + 1 WHERE id = ?").run(run.id);
      }
      recordV3Mutation({ runId: run.id, action: `${input.role}.stop`, actor: "operator", source: "rpc", requestId: input.requestId, reason: input.reason ?? null, expectedRevision: input.expectedRevision, childThreadId: target });
      publish();
      return getV3Status(input.threadId, resolved);
    },
    v3Export: async (input: { threadId: string; projectId?: string }) => {
      const resolved = await resolveProjectId(input.threadId, input.projectId);
      const home = homeOf(input.threadId) ?? input.threadId;
      const run = (selAnyRunByHome.get(home) as V3RunRow | undefined) ?? getActiveRun(home);
      if (!run) throw new Error("No run to export.");
      const artifacts = (selArtifacts.all(run.id) as Array<{ path: string }>).map((a) => a.path);
      const manifest = generateManifest({ runId: run.id, revision: run.revision, artifacts: artifacts.map((p) => ({ path: p, kind: "other", nodeId: null })) });
      void resolved;
      return { artifacts, manifest };
    },
    v3PresetList: async (input: { projectId?: string }) => {
      // Project presets are isolated: callers see globals plus their own project.
      const rows = selPresets.all() as Array<{ payload_json: string }>;
      const all = rows.map((r) => JSON.parse(r.payload_json) as V3RolePreset);
      return {
        presets: all.filter((p) => p.scope === "global" || (input.projectId != null && p.projectId === input.projectId)),
      };
    },
    v3PresetShow: async (input: { id: string }) => {
      const row = selPreset.get(input.id) as { payload_json: string } | undefined;
      return { preset: row ? (JSON.parse(row.payload_json) as V3RolePreset) : null };
    },
    v3PresetCreate: async (input: { name: string; scope?: "global" | "project"; projectId?: string | null; roles?: Record<string, unknown>; promotionMode?: "ask" | "off" | "always"; artifactPolicy?: "advisory" | "required" }) => {
      const base = inheritPreset(`preset-${shortId()}`, input.name);
      base.scope = input.scope ?? "global";
      base.projectId = input.projectId ?? null;
      base.promotionMode = input.promotionMode ?? "ask";
      base.artifactPolicy = input.artifactPolicy ?? "advisory";
      if (input.roles) {
        for (const role of V3_ROLES) {
          const item = (input.roles as Record<string, unknown>)[role] as Record<string, unknown> | undefined;
          if (item) {
            (base.roles as Record<string, unknown>)[role] = {
              choice: (item as Record<string, unknown>).choice ?? null,
              permissionMode: (item as Record<string, unknown>).permissionMode ?? null,
              skillHints: Array.isArray((item as Record<string, unknown>).skillHints) ? (item as Record<string, unknown>).skillHints : [],
            };
          }
        }
      }
      const parsed = validatePreset(base);
      if (!parsed.ok) throw new Error(parsed.error);
      const now = Date.now();
      db.prepare("INSERT INTO harness_v3_role_presets (id, name, scope, project_id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(base.id, base.name, base.scope, base.projectId, JSON.stringify(base), now, now);
      publish();
      return { preset: base };
    },
    v3PresetUpdate: async (input: { id: string; name?: string; roles?: Record<string, unknown>; promotionMode?: "ask" | "off" | "always"; artifactPolicy?: "advisory" | "required" }) => {
      const row = selPreset.get(input.id) as { payload_json: string } | undefined;
      if (!row) throw new Error(`Unknown preset ${input.id}.`);
      const current = JSON.parse(row.payload_json) as V3RolePreset;
      if (input.name) current.name = input.name;
      if (input.promotionMode) current.promotionMode = input.promotionMode;
      if (input.artifactPolicy) current.artifactPolicy = input.artifactPolicy;
      if (input.roles) {
        for (const role of V3_ROLES) {
          const item = (input.roles as Record<string, unknown>)[role] as Record<string, unknown> | undefined;
          if (item) {
            (current.roles as Record<string, unknown>)[role] = {
              choice: (item as Record<string, unknown>).choice ?? null,
              permissionMode: (item as Record<string, unknown>).permissionMode ?? null,
              skillHints: Array.isArray((item as Record<string, unknown>).skillHints) ? (item as Record<string, unknown>).skillHints : [],
            };
          }
        }
      }
      const parsed = validatePreset(current);
      if (!parsed.ok) throw new Error(parsed.error);
      db.prepare("UPDATE harness_v3_role_presets SET name = ?, payload_json = ?, updated_at = ? WHERE id = ?").run(current.name, JSON.stringify(current), Date.now(), current.id);
      publish();
      return { preset: current };
    },
    v3PresetDelete: async (input: { id: string }) => {
      if (input.id === "migrated-role-routing") throw new Error("The migrated preset is kept for audit; create a new preset instead.");
      db.prepare("DELETE FROM harness_v3_role_presets WHERE id = ?").run(input.id);
      publish();
      return { ok: true as const };
    },
    v3LegacyList: async (input: { projectId: string; threadId?: string }) => {
      const rows = db.prepare("SELECT id, name, updated_at FROM plans WHERE project_id = ? ORDER BY updated_at DESC LIMIT 50").all(input.projectId) as Array<{ id: string; name: string; updated_at: number }>;
      void input.threadId;
      return { plans: rows.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at })) };
    },
  };

  function isV3RoleThread(
    threadId: string,
    opts?: { parentThreadId?: string | null; title?: string | null; originPluginId?: string | null },
  ): { runId: string; role: V3Role; nodeId: string | null } | null {
    const attempt = selAttemptByChild.get(threadId) as { run_id: string; role: string; node_id: string | null } | undefined;
    if (!attempt) {
      // Planner thread is stored on the run, not as an attempt child? Actually planner spawn creates an attempt too.
      const run = db.prepare("SELECT id FROM harness_v3_runs WHERE planner_thread_id = ? OR explorer_thread_id = ? OR critic_thread_id = ? OR promoter_thread_id = ? OR active_worker_thread_id = ?").get(threadId, threadId, threadId, threadId, threadId) as { id: string } | undefined;
      if (run) {
        const full = selRunById.get(run.id) as V3RunRow;
        if (full.planner_thread_id === threadId) return { runId: run.id, role: "planner", nodeId: null };
        if (full.explorer_thread_id === threadId) return { runId: run.id, role: "explorer", nodeId: null };
        if (full.critic_thread_id === threadId) return { runId: run.id, role: "critic", nodeId: null };
        if (full.promoter_thread_id === threadId) return { runId: run.id, role: "promoter", nodeId: null };
        if (full.active_worker_thread_id === threadId) return { runId: run.id, role: "workerRest", nodeId: full.active_worker_node_id };
      }
      // Fallback for the dispatch race (see notePendingRoleSpawn): the child
      // was spawned but its attempt mapping is not persisted yet. Intents
      // are NOT consumed here — repeated configures while the spawn is in
      // flight must keep resolving — and are removed once spawn + attempt
      // insert settle. Persisted mappings above always win.
      return matchPendingRoleSpawn(opts ?? {});
    }
    const role = attempt.role === "workerFirst" || attempt.role === "workerRest" || attempt.role === "worker" ? "workerRest" : attempt.role;
    if (!["explorer", "planner", "workerFirst", "workerRest", "critic", "promoter"].includes(role)) return null;
    return { runId: attempt.run_id, role: role as V3Role, nodeId: attempt.node_id };
  }

  async function v3RolePrompt(threadId: string): Promise<string | null> {
    const info = isV3RoleThread(threadId);
    if (!info) return null;
    const run = selRunById.get(info.runId) as V3RunRow | undefined;
    if (!run) return null;
    if (info.role === "planner") {
      const packet = await buildPacketForRun(run, "planner", null);
      return plannerPrompt(packet);
    }
    if (info.role === "explorer") {
      return explorerPrompt({ objective: run.objective, constraints: [], questions: [] });
    }
    if (info.role === "critic") {
      const packet = await buildPacketForRun(run, "critic", null);
      return criticPrompt(packet);
    }
    if (info.role === "promoter") {
      const packet = await buildPacketForRun(run, "promoter", null);
      return promoterPrompt({ audience: "", channel: "", packet });
    }
    const nodes = nodesOf(run.id);
    const node = info.nodeId ? nodes.find((n) => n.id === info.nodeId) : readyV3Nodes(nodes)[0];
    if (!node) return null;
    const packet = await buildPacketForRun(run, "worker", node.id);
    return workerPrompt(packet, node);
  }

  async function v3Cli(argv: string[], ctx: { threadId?: string; projectId?: string }): Promise<{ exitCode: number; stdout?: string; stderr?: string } | null> {
    const [command, ...rest] = argv;
    const json = argv.includes("--json");
    const takeOption = (name: string): string | undefined => {
      const i = argv.indexOf(name);
      return i === -1 ? undefined : argv[i + 1];
    };
    const threadId = takeOption("--thread") ?? ctx.threadId;
    const reply = (value: unknown, text: string) => ({ exitCode: 0 as const, stdout: json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n` });
    const fail = (message: string) => ({ exitCode: 1 as const, stderr: `${message}\n` });
    const needThread = (): string | null => {
      if (!threadId) return "Pass --thread <id> or run this from a BB thread.";
      return null;
    };
    const requestId = () => `cli-v3:${randomUUID()}`;
    try {
      switch (command) {
        case "status": {
          const missing = needThread();
          if (missing) return fail(missing);
          const resolved = await resolveProjectId(threadId!, takeOption("--thread") ? undefined : ctx.projectId);
          const status = await getV3Status(threadId!, resolved);
          if (!status.run) return reply(status, "Harness: inactive. Ordinary BB chat is the correct path for small, clear work.");
          const text = [
            `Harness v3: ${status.run.objective} (${status.run.id})`,
            `${status.stateCopy.title}: ${status.stateCopy.body}`,
            `Progress: ${status.doneCount}/${status.totalCount} done · rev ${status.run.revision} · plan rev ${status.run.planRevision}`,
            status.nextNode ? `Next: ${status.nextNode.id} — ${status.nextNode.title}` : "No ready nodes.",
          ].join("\n");
          return reply(status, text);
        }
        case "start": {
          const missing = needThread();
          if (missing) return fail(missing);
          const task = takeOption("--task") ?? rest.join(" ").trim();
          if (!task) return fail("start needs --task <text>");
          const resolved = await resolveProjectId(threadId!, takeOption("--thread") ? undefined : ctx.projectId);
          await doStart(threadId!, resolved, task, takeOption("--preset"), undefined, undefined, requestId());
          const status = await getV3Status(threadId!, resolved);
          return reply(status, `Started Harness ${status.run?.id ?? ""} in Exploring. Planner is orchestrating.`);
        }
        case "approve-plan": {
          const missing = needThread();
          if (missing) return fail(missing);
          const resolved = await resolveProjectId(threadId!, takeOption("--thread") ? undefined : ctx.projectId);
          const run = getActiveRun(threadId!);
          if (!run) return fail("No active run.");
          await handlers.v3ApprovePlan({ threadId: threadId!, projectId: resolved, expectedRevision: run.revision, requestId: requestId() });
          return reply(await getV3Status(threadId!, resolved), "Plan approved. Workers can now run in dependency order.");
        }
        case "review-worker": {
          const missing = needThread();
          if (missing) return fail(missing);
          const nodeId = rest[0];
          if (!nodeId) return fail("review-worker <node-id> --approve|--changes <text>");
          const approve = argv.includes("--approve");
          const changesIdx = argv.indexOf("--changes");
          const changes = changesIdx === -1 ? undefined : argv[changesIdx + 1];
          if (!approve && !changes) return fail("review-worker needs --approve or --changes <text>");
          const resolved = await resolveProjectId(threadId!, takeOption("--thread") ? undefined : ctx.projectId);
          const run = getActiveRun(threadId!);
          if (!run) return fail("No active run.");
          await handlers.v3ReviewWorker({ threadId: threadId!, projectId: resolved, nodeId, approve, changes, expectedRevision: run.revision, requestId: requestId() });
          return reply(await getV3Status(threadId!, resolved), approve ? `Worker ${nodeId} accepted.` : `Changes requested on ${nodeId}.`);
        }
        case "review-critic": {
          const missing = needThread();
          if (missing) return fail(missing);
          const approve = argv.includes("--approve");
          const blockIdx = argv.indexOf("--block");
          const reworkIdx = argv.indexOf("--rework");
          const reasonIdx = argv.indexOf("--reason");
          const reason = reasonIdx === -1 ? undefined : argv[reasonIdx + 1];
          if (!reason) return fail("review-critic needs --reason <text>");
          const decision = approve ? "APPROVE" : blockIdx !== -1 ? "BLOCK" : reworkIdx !== -1 ? "REWORK" : null;
          if (!decision) return fail("review-critic needs --approve, --rework <nodes>, or --block <text>");
          const nodeIds = reworkIdx === -1 ? [] : String(argv[reworkIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
          const resolved = await resolveProjectId(threadId!, takeOption("--thread") ? undefined : ctx.projectId);
          const run = getActiveRun(threadId!);
          if (!run) return fail("No active run.");
          await handlers.v3ReviewCritic({ threadId: threadId!, projectId: resolved, decision: decision as never, nodeIds, reason, expectedRevision: run.revision, requestId: requestId() });
          return reply(await getV3Status(threadId!, resolved), `Critic decision recorded: ${decision}.`);
        }
        case "promote": {
          const missing = needThread();
          if (missing) return fail(missing);
          const start = argv.includes("--start");
          const skip = argv.includes("--skip");
          if (!start && !skip) return fail("promote needs --start or --skip");
          const resolved = await resolveProjectId(threadId!, takeOption("--thread") ? undefined : ctx.projectId);
          const run = getActiveRun(threadId!);
          if (!run) return fail("No active run.");
          await handlers.v3Promote({ threadId: threadId!, projectId: resolved, start, expectedRevision: run.revision, requestId: requestId() });
          return reply(await getV3Status(threadId!, resolved), start ? "Promoter started." : "Promotion skipped.");
        }
        case "cancel": {
          const missing = needThread();
          if (missing) return fail(missing);
          const reason = takeOption("--reason") ?? rest.join(" ").trim() ?? "Operator cancelled from CLI.";
          const resolved = await resolveProjectId(threadId!, takeOption("--thread") ? undefined : ctx.projectId);
          const run = getActiveRun(threadId!);
          if (!run) return fail("No active run.");
          await handlers.v3Cancel({ threadId: threadId!, projectId: resolved, reason, expectedRevision: run.revision, requestId: requestId() });
          return reply(await getV3Status(threadId!, resolved), "Run cancelled after stopping role threads.");
        }
        case "export": {
          const missing = needThread();
          if (missing) return fail(missing);
          const out = await handlers.v3Export({ threadId: threadId!, projectId: ctx.projectId });
          return reply(out, out.artifacts.join("\n"));
        }
        case "preset": {
          const sub = rest[0];
          if (sub === "list" || !sub) {
            const out = await handlers.v3PresetList({ projectId: ctx.projectId });
            return reply(out, out.presets.map((p) => `${p.id}  ${p.name}`).join("\n") || "No presets.");
          }
          return fail("Usage: bb harness preset list|show|create|update|delete");
        }
        case "legacy": {
          const sub = rest[0];
          if (sub === "list") {
            if (!ctx.projectId && !threadId) return fail("No project in context.");
            const projectId = ctx.projectId ?? (await resolveProjectId(threadId!));
            const out = await handlers.v3LegacyList({ projectId });
            return reply(out, out.plans.map((p) => `${p.id}  ${p.name}`).join("\n") || "No legacy plans.");
          }
          return fail("Usage: bb harness legacy list|show|cancel");
        }
        default:
          return null;
      }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  // One-time migration: legacy six-slot routing -> named v3 preset.
  function ensureMigratedPreset(legacyRouting: unknown): void {
    try {
      if (selPreset.get("migrated-role-routing")) return;
      if (!legacyRouting || typeof legacyRouting !== "object") return;
      const preset = migrateLegacyRouting(legacyRouting as Record<string, { providerId: string; model: string; reasoningLevel: string } | null>);
      // Only migrate when at least one slot was configured.
      const anySet = Object.values(preset.roles).some((r) => r.choice);
      if (!anySet) return;
      const now = Date.now();
      db.prepare("INSERT INTO harness_v3_role_presets (id, name, scope, project_id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        preset.id, preset.name, preset.scope, preset.projectId, JSON.stringify(preset), now, now,
      );
    } catch {}
  }

  // Serialize direct mutations per calling thread and short-circuit replayed
  // request IDs so duplicate/concurrent calls cannot apply twice. Reads and
  // preset/legacy/export paths stay unwrapped.
  const SERIALIZED = new Set([
    "v3Start", "v3RunExplorer", "v3AcceptExploration", "v3SkipExploration",
    "v3ApprovePlan", "v3RequestPlanRevision", "v3RunNextWorker", "v3ReviewWorker",
    "v3SetNodeRouting", "v3StartCritic", "v3ReviewCritic", "v3Promote",
    "v3Complete", "v3Cancel", "v3RetryRole", "v3StopRole", "v3RetryExport",
  ]);
  const wrappedHandlers: Record<string, (input: never) => Promise<unknown>> = {};
  for (const [name, fn] of Object.entries(handlers)) {
    if (!SERIALIZED.has(name)) {
      wrappedHandlers[name] = fn as (input: never) => Promise<unknown>;
      continue;
    }
    wrappedHandlers[name] = (async (input: { threadId?: string; projectId?: string; requestId?: string }) => {
      // Resolve role children to the home thread so home/child RPCs serialize.
      const key = (input.threadId && homeOf(input.threadId)) || input.threadId || "global";
      return withRunLock(key, async () => {
        if (input.requestId && seenRequest(input.requestId)) {
          const resolved = await resolveProjectId(input.threadId!, input.projectId);
          return getV3Status(homeOf(input.threadId!) ?? input.threadId!, resolved);
        }
        return (fn as (i: never) => Promise<unknown>)(input as never);
      });
    }) as (input: never) => Promise<unknown>;
  }
  async function packetSliceFor(
    runId: string,
    role: "explorer" | "planner" | "worker" | "critic" | "promoter",
    nodeId: string | null,
  ): Promise<Record<string, unknown>> {
    const run = selRunById.get(runId) as V3RunRow | undefined;
    if (!run) throw new Error("Run not found.");
    const packet = await assemblePacket(run, role, nodeId);
    return slicePacketForRole(packet, role) as Record<string, unknown>;
  }

  async function deliverExplorationToPlanner(runId: string, summary: string, findings: string[]): Promise<void> {
    const run = selRunById.get(runId) as V3RunRow | undefined;
    if (!run) return;
    const lines = [
      `[harness] Explorer report for "${run.objective.slice(0, 120)}":`,
      summary,
      ...findings.slice(0, 8).map((f) => `- ${f}`),
      "Full report is in the run packet (harness_get_run_context).",
    ];
    await deliverToPlanner(run, lines.join("\n"));
  }

  bb.rpc.register(v3RpcContract, wrappedHandlers as never);
  return { getV3Status, isV3RoleThread, v3RolePrompt, v3Cli, handlers: wrappedHandlers, ensureMigratedPreset, packetSliceFor, deliverExplorationToPlanner };
}

const draftLocks = new Map<string, Promise<void>>();

export async function submitPlanDraftFromTool(args: {
  db: V3Db;
  runId: string;
  drafts: unknown;
  actor: string;
  requestId: string;
  update: boolean;
}): Promise<{ revision: number; nodes: V3WorkNode[] }> {
  const validated = validateV3Draft(args.drafts);
  if (!validated.ok) throw new Error(validated.error);
  const prev = draftLocks.get(args.runId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  draftLocks.set(args.runId, mine);
  await prev;
  try {
    // Replay-safe: a repeated requestId returns current draft state.
    try {
      if (args.db.prepare("SELECT id FROM harness_v3_mutations WHERE request_id = ?").get(args.requestId)) {
        const run = args.db.prepare("SELECT * FROM harness_v3_runs WHERE id = ?").get(args.runId) as V3RunRow;
        const current = (args.db.prepare("SELECT * FROM harness_v3_work_nodes WHERE run_id = ? ORDER BY sort_order ASC").all(args.runId) as V3NodeRow[]).map(toWorkNode);
        return { revision: run.draft_revision, nodes: current };
      }
    } catch {}
    return await submitPlanDraftInner(args, validated.nodes);
  } finally {
    release();
    if (draftLocks.get(args.runId) === mine) draftLocks.delete(args.runId);
  }
}

async function submitPlanDraftInner(
  args: { db: V3Db; runId: string; actor: string; requestId: string; update: boolean },
  draftNodes: import("./v3/types").V3WorkNodeDraft[],
): Promise<{ revision: number; nodes: V3WorkNode[] }> {
  const validated = { nodes: draftNodes };
  const existing = args.db.prepare("SELECT * FROM harness_v3_work_nodes WHERE run_id = ? ORDER BY sort_order ASC").all(args.runId) as V3NodeRow[];
  const assigned = assignV3NodeIds(validated.nodes, () => randomUUID().slice(0, 6));
  // Resolve dependencies by title or id against the new set.
  const byTitle = new Map(assigned.map((n) => [n.title, n.id]));
  const byId = new Map(assigned.map((n) => [n.id, n.id]));
  for (let i = 0; i < assigned.length; i += 1) {
    const draftDeps = validated.nodes[i]!.dependencies ?? [];
    const resolved: string[] = [];
    for (const dep of draftDeps) {
      const hit = byId.get(dep) ?? byTitle.get(dep);
      if (!hit) throw new Error(`Unknown dependency ${dep} for "${assigned[i]!.title}".`);
      resolved.push(hit);
    }
    assigned[i]!.dependencies = resolved;
  }
  if (wouldCycleV3(assigned)) throw new Error("That dependency list would create a cycle.");
  const run = args.db.prepare("SELECT * FROM harness_v3_runs WHERE id = ?").get(args.runId) as V3RunRow;
  if (!run) throw new Error("Run not found.");
  if (run.state !== "Planning" && run.state !== "PlanApproval") {
    throw new Error(`Plan drafts are accepted in Planning/PlanApproval (current: ${run.state}).`);
  }
  const tx = args.db.transaction(() => {
    if (!args.update) {
      args.db.prepare("DELETE FROM harness_v3_work_nodes WHERE run_id = ?").run(args.runId);
      args.db.prepare("DELETE FROM harness_v3_node_dependencies WHERE run_id = ?").run(args.runId);
    } else {
      args.db.prepare("DELETE FROM harness_v3_work_nodes WHERE run_id = ?").run(args.runId);
      args.db.prepare("DELETE FROM harness_v3_node_dependencies WHERE run_id = ?").run(args.runId);
    }
    const draftRev = run.draft_revision + 1;
    assigned.forEach((n, idx) => {
      args.db.prepare(
        `INSERT INTO harness_v3_work_nodes (id, run_id, node_id, title, objective, dependencies, acceptance, verification, artifacts, hints, status, plan_revision, attempt_id, routing_override, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?)`,
      ).run(randomUUID(), args.runId, n.id, n.title, n.objective, JSON.stringify(n.dependencies), JSON.stringify(n.acceptanceCriteria), JSON.stringify(n.verificationCommands), JSON.stringify(n.expectedArtifacts), JSON.stringify(n.skillHints), draftRev, idx);
      for (const dep of n.dependencies) {
        args.db.prepare("INSERT INTO harness_v3_node_dependencies (run_id, node_id, dep_id) VALUES (?, ?, ?)").run(args.runId, n.id, dep);
      }
    });
    args.db.prepare("UPDATE harness_v3_runs SET draft_revision = ?, state = 'PlanApproval', revision = revision + 1, updated_at = ? WHERE id = ?").run(draftRev, Date.now(), args.runId);
    void existing;
  });
  tx();
  const fresh = args.db.prepare("SELECT * FROM harness_v3_runs WHERE id = ?").get(args.runId) as V3RunRow;
  args.db.prepare(
    `INSERT INTO harness_v3_mutations (id, run_id, action, actor, source, request_id, reason, expected_revision, resulting_revision, attempt_id, child_thread_id, output_hash, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, '{}', ?)`,
  ).run(randomUUID(), args.runId, args.update ? "plan.update_draft" : "plan.submit_draft", args.actor, "tool", args.requestId, run.revision, fresh.revision, Date.now());
  return { revision: fresh.draft_revision, nodes: assigned };
}

export function hashOutputText(output: string | null | undefined): string | null {
  if (!output?.trim()) return null;
  return createHash("sha256").update(output.trim()).digest("hex");
}

export async function readThreadOutput(bb: BbPluginApi, threadId: string): Promise<{ text: string | null; hash: string | null }> {
  try {
    const { output } = await bb.sdk.threads.output({ threadId });
    const text = output?.trim() ? output.trim() : null;
    return { text, hash: hashOutputText(text) };
  } catch {
    return { text: null, hash: null };
  }
}

export { validateCriticReport, validateExplorationReport, validatePromotionReport, validateWorkerReport };
export { isSafeV3ArtifactRef, parseV3ArtifactPaths };
export { sumDistinctThreadTokens };
