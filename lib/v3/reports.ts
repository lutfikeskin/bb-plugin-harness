/**
 * v3 role report schemas. Pure validation — no BB SDK.
 */
import type { V3CriticReport, V3ExplorationReport, V3NodeResult, V3PromotionReport } from "./types";

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (t.length === 0 || t.length > max) return null;
  return t;
}

function strList(value: unknown, maxItems: number, maxChars: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const t = item.trim().replace(/\\/g, "/");
    if (!t) continue;
    if (t.length > maxChars) return null;
    out.push(t);
  }
  return out;
}

export function validateExplorationReport(raw: unknown): { ok: true; report: Omit<V3ExplorationReport, "createdAt"> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Exploration report must be an object." };
  const r = raw as Record<string, unknown>;
  const summary = str(r.summary, 8000);
  if (!summary) return { ok: false, error: "Exploration summary is required (1–8000 chars)." };
  const findings = strList(r.findings, 32, 2000);
  const risks = strList(r.risks, 16, 1000);
  const artifactRefs = strList(r.artifactRefs, 16, 500);
  if (!findings || !risks || !artifactRefs) return { ok: false, error: "Exploration findings/risks/artifactRefs are invalid." };
  const suggested = Array.isArray(r.suggestedNodes) ? r.suggestedNodes : [];
  if (suggested.length > 24) return { ok: false, error: "Too many suggested nodes." };
  const suggestedNodes: Array<{ title: string; objective: string; dependencies?: string[]; acceptanceCriteria: string[]; verificationCommands?: string[]; expectedArtifacts?: string[]; skillHints?: string[] }> = [];
  for (const item of suggested) {
    if (!item || typeof item !== "object") return { ok: false, error: "Suggested node must be an object." };
    const rec = item as Record<string, unknown>;
    const title = str(rec.title, 200);
    const objective = str(rec.objective, 4000);
    if (!title || !objective) return { ok: false, error: "Suggested nodes need title and objective." };
    const ac = strList(rec.acceptanceCriteria, 16, 500);
    if (!ac || ac.length === 0) return { ok: false, error: `Suggested node "${title}" needs acceptance criteria.` };
    suggestedNodes.push({
      title,
      objective,
      dependencies: strList(rec.dependencies, 16, 120) ?? [],
      acceptanceCriteria: ac,
      verificationCommands: strList(rec.verificationCommands, 16, 500) ?? [],
      expectedArtifacts: strList(rec.expectedArtifacts, 16, 500) ?? [],
      skillHints: strList(rec.skillHints, 16, 80) ?? [],
    });
  }
  return { ok: true, report: { summary, findings, suggestedNodes, risks, artifactRefs } };
}

export function validateWorkerReport(raw: unknown): { ok: true; report: Omit<V3NodeResult, "nodeId" | "attemptId" | "createdAt"> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Worker report must be an object." };
  const r = raw as Record<string, unknown>;
  const outcome = r.outcome;
  if (outcome !== "complete" && outcome !== "blocked" && outcome !== "plan-change-needed") {
    return { ok: false, error: "Worker outcome must be complete, blocked, or plan-change-needed." };
  }
  const summary = str(r.summary, 8000);
  if (!summary) return { ok: false, error: "Worker summary is required (1–8000 chars)." };
  const changedFiles = strList(r.changedFiles, 64, 500);
  const artifactRefs = strList(r.artifactRefs, 32, 500);
  const risks = strList(r.risks, 16, 1000);
  if (!changedFiles || !artifactRefs || !risks) return { ok: false, error: "Worker changedFiles/artifactRefs/risks are invalid." };
  const acceptanceResults: V3NodeResult["acceptanceResults"] = [];
  if (r.acceptanceResults !== undefined) {
    if (!Array.isArray(r.acceptanceResults)) return { ok: false, error: "acceptanceResults must be an array." };
    for (const item of r.acceptanceResults) {
      if (!item || typeof item !== "object") return { ok: false, error: "acceptance result must be an object." };
      const rec = item as Record<string, unknown>;
      const criterion = str(rec.criterion, 500);
      if (!criterion || typeof rec.met !== "boolean") return { ok: false, error: "acceptance result needs criterion and met." };
      acceptanceResults.push({ criterion, met: rec.met, note: typeof rec.note === "string" ? rec.note.slice(0, 1000) : "" });
    }
  }
  const commands: V3NodeResult["commands"] = [];
  if (r.commands !== undefined) {
    if (!Array.isArray(r.commands)) return { ok: false, error: "commands must be an array." };
    if (r.commands.length > 32) return { ok: false, error: "Too many commands." };
    for (const item of r.commands) {
      if (!item || typeof item !== "object") return { ok: false, error: "command must be an object." };
      const rec = item as Record<string, unknown>;
      const command = str(rec.command, 500);
      if (!command) return { ok: false, error: "command.command is required." };
      const exitCode = rec.exitCode === null || rec.exitCode === undefined ? null : typeof rec.exitCode === "number" && Number.isInteger(rec.exitCode) ? rec.exitCode : NaN;
      if (Number.isNaN(exitCode)) return { ok: false, error: "command.exitCode must be an integer or null." };
      commands.push({ command, exitCode, output: typeof rec.output === "string" ? rec.output.slice(0, 4000) : "" });
    }
  }
  return { ok: true, report: { outcome, summary, changedFiles, acceptanceResults, commands, artifactRefs, risks } };
}

export function validateCriticReport(raw: unknown): { ok: true; report: Omit<V3CriticReport, "createdAt"> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Critic report must be an object." };
  const r = raw as Record<string, unknown>;
  if (r.recommendation !== "APPROVE" && r.recommendation !== "REWORK" && r.recommendation !== "BLOCK") {
    return { ok: false, error: "Critic recommendation must be APPROVE, REWORK, or BLOCK." };
  }
  const findings: V3CriticReport["findings"] = [];
  if (r.findings !== undefined) {
    if (!Array.isArray(r.findings)) return { ok: false, error: "findings must be an array." };
    if (r.findings.length > 32) return { ok: false, error: "Too many findings." };
    for (const item of r.findings) {
      if (!item || typeof item !== "object") return { ok: false, error: "finding must be an object." };
      const rec = item as Record<string, unknown>;
      if (rec.severity !== "high" && rec.severity !== "medium" && rec.severity !== "low") {
        return { ok: false, error: "finding.severity must be high, medium, or low." };
      }
      const title = str(rec.title, 300);
      const detail = typeof rec.detail === "string" ? rec.detail.slice(0, 4000) : "";
      if (!title) return { ok: false, error: "finding.title is required." };
      findings.push({ severity: rec.severity, title, detail });
    }
  }
  const affectedNodeIds = strList(r.affectedNodeIds, 32, 120);
  const unsupportedClaims = strList(r.unsupportedClaims, 32, 1000);
  const risks = strList(r.risks, 16, 1000);
  if (!affectedNodeIds || !unsupportedClaims || !risks) {
    return { ok: false, error: "affectedNodeIds/unsupportedClaims/risks are invalid." };
  }
  if (r.recommendation !== "APPROVE" && affectedNodeIds.length === 0) {
    return { ok: false, error: `${r.recommendation} must name affected node IDs.` };
  }
  const checksRerun: V3CriticReport["checksRerun"] = [];
  if (r.checksRerun !== undefined) {
    if (!Array.isArray(r.checksRerun)) return { ok: false, error: "checksRerun must be an array." };
    for (const item of r.checksRerun) {
      if (!item || typeof item !== "object") return { ok: false, error: "check must be an object." };
      const rec = item as Record<string, unknown>;
      const command = str(rec.command, 500);
      if (!command) return { ok: false, error: "check.command is required." };
      const exitCode = rec.exitCode === null || rec.exitCode === undefined ? null : typeof rec.exitCode === "number" && Number.isInteger(rec.exitCode) ? rec.exitCode : NaN;
      if (Number.isNaN(exitCode)) return { ok: false, error: "check.exitCode must be an integer or null." };
      checksRerun.push({ command, exitCode, note: typeof rec.note === "string" ? rec.note.slice(0, 2000) : "" });
    }
  }
  return { ok: true, report: { recommendation: r.recommendation, findings, affectedNodeIds, checksRerun, unsupportedClaims, risks } };
}

export function validatePromotionReport(raw: unknown): { ok: true; report: Omit<V3PromotionReport, "createdAt"> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Promotion report must be an object." };
  const r = raw as Record<string, unknown>;
  const summary = str(r.summary, 8000);
  if (!summary) return { ok: false, error: "Promotion summary is required." };
  const audience = typeof r.audience === "string" ? r.audience.slice(0, 500) : "";
  const channel = typeof r.channel === "string" ? r.channel.slice(0, 500) : "";
  const claims = strList(r.claims, 32, 1000);
  const limitations = strList(r.limitations, 32, 1000);
  const artifactRefs = strList(r.artifactRefs, 16, 500);
  if (!claims || !limitations || !artifactRefs) return { ok: false, error: "claims/limitations/artifactRefs are invalid." };
  return { ok: true, report: { audience, channel, summary, claims, limitations, artifactRefs } };
}
