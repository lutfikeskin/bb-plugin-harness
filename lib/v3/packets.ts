/**
 * v3 task packets — bounded JSON/Markdown slices generated from DB state.
 * Pure — no BB SDK.
 */
import type {
  V3ArtifactRef,
  V3Decision,
  V3ExplorationReport,
  V3NodeResult,
  V3TaskPacket,
  V3VerificationResult,
  V3WorkNode,
} from "./types";
import { TASK_PACKET_SCHEMA_VERSION } from "./types";

export const MAX_PACKET_BYTES = 24_000;
export const MAX_PACKET_TEXT = 6_000;

function boundText(value: string, max = MAX_PACKET_TEXT): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars; full report in artifacts]`;
}

function boundList(items: string[], maxItems = 12, maxChars = 2_000): string[] {
  const out: string[] = [];
  let budget = maxChars;
  for (const item of items) {
    if (out.length >= maxItems) break;
    const clipped = item.length > 400 ? `${item.slice(0, 400)}…` : item;
    if (clipped.length > budget) break;
    out.push(clipped);
    budget -= clipped.length;
  }
  return out;
}

export type PacketProject = {
  id: string;
  name: string;
  environmentId: string;
  workspacePath: string;
};

export function buildTaskPacket(args: {
  runId: string;
  packetVersion: number;
  objective: string;
  project: PacketProject;
  constraints: string[];
  exploration: V3ExplorationReport | null;
  approvedPlan: { revision: number; nodes: V3WorkNode[] } | null;
  currentNode: V3WorkNode | null;
  dependencyResults: V3NodeResult[];
  decisions: V3Decision[];
  artifactIndex: V3ArtifactRef[];
  verificationSummary: V3VerificationResult[];
}): V3TaskPacket {
  const clipNode = (n: V3WorkNode): V3WorkNode => ({
    ...n,
    objective: boundText(n.objective, 1_500),
    acceptanceCriteria: boundList(n.acceptanceCriteria, 12),
    verificationCommands: boundList(n.verificationCommands, 8),
    expectedArtifacts: boundList(n.expectedArtifacts, 8),
    skillHints: boundList(n.skillHints, 8),
  });
  const packet: V3TaskPacket = {
    schemaVersion: TASK_PACKET_SCHEMA_VERSION,
    runId: args.runId,
    packetVersion: args.packetVersion,
    objective: boundText(args.objective, 2_000),
    project: args.project,
    constraints: boundList(args.constraints, 12),
    exploration: args.exploration
      ? {
          ...args.exploration,
          summary: boundText(args.exploration.summary, 2_000),
          findings: boundList(args.exploration.findings, 12),
          risks: boundList(args.exploration.risks, 8),
          artifactRefs: boundList(args.exploration.artifactRefs, 8),
          suggestedNodes: args.exploration.suggestedNodes.slice(0, 12),
        }
      : null,
    approvedPlan: args.approvedPlan
      ? { revision: args.approvedPlan.revision, nodes: args.approvedPlan.nodes.map(clipNode) }
      : null,
    currentNode: args.currentNode ? clipNode(args.currentNode) : null,
    dependencyResults: args.dependencyResults.slice(-12).map((r) => ({
      ...r,
      summary: boundText(r.summary, 1_500),
      changedFiles: boundList(r.changedFiles, 16),
      artifactRefs: boundList(r.artifactRefs, 8),
      risks: boundList(r.risks, 8),
    })),
    decisions: args.decisions.slice(-24),
    artifactIndex: args.artifactIndex.slice(-32),
    verificationSummary: args.verificationSummary.slice(-16),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(packet)).length;
  if (bytes > MAX_PACKET_BYTES) {
    // Shed lowest-value bulk first: dependency summaries, then artifact index tail.
    const slim: V3TaskPacket = {
      ...packet,
      dependencyResults: packet.dependencyResults.slice(-6).map((r) => ({ ...r, summary: boundText(r.summary, 600) })),
      artifactIndex: packet.artifactIndex.slice(-12),
      verificationSummary: packet.verificationSummary.slice(-8),
    };
    const slimBytes = new TextEncoder().encode(JSON.stringify(slim)).length;
    if (slimBytes > MAX_PACKET_BYTES) {
      return {
        ...slim,
        exploration: slim.exploration ? { ...slim.exploration, findings: slim.exploration.findings.slice(0, 4) } : null,
        dependencyResults: slim.dependencyResults.slice(-3),
      };
    }
    return slim;
  }
  return packet;
}

export function packetBytes(packet: V3TaskPacket): number {
  return new TextEncoder().encode(JSON.stringify(packet)).length;
}

export function renderPacketMarkdown(packet: V3TaskPacket): string {
  const lines: string[] = [
    `# Task packet v${packet.packetVersion} — run ${packet.runId}`,
    "",
    `Objective: ${packet.objective}`,
    "",
    `Project: ${packet.project.name} (${packet.project.id}) · env ${packet.project.environmentId}`,
    `Workspace: ${packet.project.workspacePath}`,
    "",
  ];
  if (packet.constraints.length > 0) {
    lines.push("Constraints:", ...packet.constraints.map((c) => `- ${c}`), "");
  }
  if (packet.approvedPlan) {
    lines.push(`Approved plan rev ${packet.approvedPlan.revision}:`);
    for (const n of packet.approvedPlan.nodes) {
      lines.push(`- ${n.id}: ${n.title} [${n.status}] deps: ${n.dependencies.join(", ") || "none"}`);
    }
    lines.push("");
  }
  if (packet.currentNode) {
    const n = packet.currentNode;
    lines.push(`Current node ${n.id}: ${n.title}`, n.objective, "Acceptance:");
    for (const c of n.acceptanceCriteria) lines.push(`- [ ] ${c}`);
    if (n.verificationCommands.length > 0) {
      lines.push("Verify:", ...n.verificationCommands.map((c) => `- \`${c}\``));
    }
    lines.push("");
  }
  if (packet.decisions.length > 0) {
    lines.push("Decisions:", ...packet.decisions.map((d) => `- ${d.kind} (${d.actor})${d.reason ? `: ${d.reason}` : ""}`), "");
  }
  return lines.join("\n");
}

export type RoleSlice = "explorer" | "planner" | "worker" | "critic" | "promoter";

export function slicePacketForRole(packet: V3TaskPacket, role: RoleSlice): Record<string, unknown> {
  switch (role) {
    case "explorer":
      return { objective: packet.objective, project: packet.project, constraints: packet.constraints };
    case "planner":
      return { objective: packet.objective, project: packet.project, constraints: packet.constraints, exploration: packet.exploration, decisions: packet.decisions };
    case "worker":
      return {
        objective: packet.objective,
        constraints: packet.constraints,
        approvedPlan: packet.approvedPlan ? { revision: packet.approvedPlan.revision, outline: packet.approvedPlan.nodes.map((n) => ({ id: n.id, title: n.title, status: n.status, dependencies: n.dependencies })) } : null,
        currentNode: packet.currentNode,
        dependencyResults: packet.dependencyResults,
        artifactIndex: packet.artifactIndex,
      };
    case "critic":
      return {
        objective: packet.objective,
        constraints: packet.constraints,
        approvedPlan: packet.approvedPlan,
        dependencyResults: packet.dependencyResults,
        verificationSummary: packet.verificationSummary,
        decisions: packet.decisions,
      };
    case "promoter":
      return {
        objective: packet.objective,
        constraints: packet.constraints,
        approvedPlan: packet.approvedPlan,
        dependencyResults: packet.dependencyResults,
        artifactIndex: packet.artifactIndex,
        decisions: packet.decisions,
      };
    default:
      return { objective: packet.objective };
  }
}
