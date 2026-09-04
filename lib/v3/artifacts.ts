/**
 * v3 artifact policy — path safety, manifest, plan.md. Pure except for
 * content generation (file I/O lives server-side via bb.sdk.files).
 */
import type { V3WorkNode } from "./types";

export const MAX_V3_ARTIFACT_PATH = 500;

export function isSafeV3ArtifactRef(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, "/");
  if (!normalized || normalized.length > MAX_V3_ARTIFACT_PATH) return false;
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
  if (normalized.includes("://")) return false;
  // Reject malformed Unicode / control chars.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(normalized)) return false;
  const parts = normalized.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  return parts[0] === "artifacts";
}

export function parseV3ArtifactPaths(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > 32) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const p = item.trim().replace(/\\/g, "/");
    if (!p) continue;
    if (!isSafeV3ArtifactRef(p)) return null;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export function artifactDirForRun(runId: string): string {
  return `artifacts/harness/${runId}`;
}

export function runArtifactPath(runId: string, name: string): string {
  return `${artifactDirForRun(runId)}/${name}`;
}

export function workerReportPath(runId: string, nodeId: string): string {
  return `${artifactDirForRun(runId)}/nodes/${nodeId}/worker-report.md`;
}

export function generatePlanMarkdown(args: {
  runId: string;
  objective: string;
  revision: number;
  nodes: V3WorkNode[];
}): string {
  const lines: string[] = [
    `# Harness plan — run ${args.runId} (rev ${args.revision})`,
    "",
    `Objective: ${args.objective}`,
    "",
    "```mermaid",
    "flowchart TD",
  ];
  for (const n of args.nodes) {
    const safe = n.title.replace(/["#<>`]/g, "").slice(0, 60);
    lines.push(`    ${sanitizeMermaidId(n.id)}["${safe}"]`);
    for (const dep of n.dependencies) {
      lines.push(`    ${sanitizeMermaidId(dep)} --> ${sanitizeMermaidId(n.id)}`);
    }
  }
  lines.push("```", "", "| Node | Objective | Acceptance | Verify |", "| --- | --- | --- | --- |");
  for (const n of args.nodes) {
    lines.push(
      `| ${n.id} | ${oneLine(n.objective, 80)} | ${oneLine(n.acceptanceCriteria.join("; "), 80)} | ${oneLine(n.verificationCommands.join("; ") || "—", 60)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function sanitizeMermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48) || "node";
}

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function generateExplorationMarkdown(args: { summary: string; findings: string[]; risks: string[] }): string {
  return [`# Exploration`, "", args.summary, "", "## Findings", ...args.findings.map((f) => `- ${f}`), "", "## Risks", ...args.risks.map((r) => `- ${r}`), ""].join("\n");
}

export function generateWorkerMarkdown(args: {
  nodeId: string;
  title: string;
  summary: string;
  changedFiles: string[];
  acceptance: Array<{ criterion: string; met: boolean; note: string }>;
  commands: Array<{ command: string; exitCode: number | null; output: string }>;
  risks: string[];
}): string {
  const lines = [`# Worker report — ${args.nodeId}: ${args.title}`, "", args.summary, ""];
  if (args.changedFiles.length > 0) lines.push("## Changed files", ...args.changedFiles.map((f) => `- \`${f}\``), "");
  if (args.acceptance.length > 0) {
    lines.push("## Acceptance", ...args.acceptance.map((a) => `- [${a.met ? "x" : " "}] ${a.criterion}${a.note ? ` — ${a.note}` : ""}`), "");
  }
  if (args.commands.length > 0) {
    lines.push("## Commands", ...args.commands.map((c) => `- \`${c.command}\` → ${c.exitCode ?? "?"}${c.output ? ` — ${oneLine(c.output, 120)}` : ""}`), "");
  }
  if (args.risks.length > 0) lines.push("## Risks", ...args.risks.map((r) => `- ${r}`), "");
  return lines.join("\n");
}

export function generateCriticMarkdown(args: {
  recommendation: string;
  findings: Array<{ severity: string; title: string; detail: string }>;
  affectedNodeIds: string[];
  checksRerun: Array<{ command: string; exitCode: number | null; note: string }>;
  unsupportedClaims: string[];
  risks: string[];
}): string {
  const lines = [`# Critic report — ${args.recommendation}`, ""];
  if (args.findings.length > 0) {
    lines.push("## Findings", ...args.findings.map((f) => `- [${f.severity}] ${f.title}${f.detail ? ` — ${oneLine(f.detail, 200)}` : ""}`), "");
  }
  if (args.affectedNodeIds.length > 0) lines.push(`Affected nodes: ${args.affectedNodeIds.join(", ")}`, "");
  if (args.checksRerun.length > 0) {
    lines.push("## Checks rerun", ...args.checksRerun.map((c) => `- \`${c.command}\` → ${c.exitCode ?? "?"}${c.note ? ` — ${c.note}` : ""}`), "");
  }
  if (args.unsupportedClaims.length > 0) lines.push("## Unsupported claims", ...args.unsupportedClaims.map((c) => `- ${c}`), "");
  if (args.risks.length > 0) lines.push("## Risks", ...args.risks.map((r) => `- ${r}`), "");
  return lines.join("\n");
}

export function generatePromotionMarkdown(args: {
  audience: string;
  channel: string;
  summary: string;
  claims: string[];
  limitations: string[];
}): string {
  const lines = [`# Promotion`, "", args.summary, ""];
  if (args.audience || args.channel) lines.push(`Audience: ${args.audience || "—"} · Channel: ${args.channel || "—"}`, "");
  if (args.claims.length > 0) lines.push("## Verified claims", ...args.claims.map((c) => `- ${c}`), "");
  if (args.limitations.length > 0) lines.push("## Limitations", ...args.limitations.map((l) => `- ${l}`), "");
  return lines.join("\n");
}

export function generateManifest(args: {
  runId: string;
  revision: number;
  artifacts: Array<{ path: string; kind: string; nodeId: string | null }>;
}): string {
  return JSON.stringify({ runId: args.runId, revision: args.revision, artifacts: args.artifacts, exportedAt: Date.now() }, null, 2);
}
