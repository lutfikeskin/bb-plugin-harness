/**
 * v3 DAG validation, readiness, and invalidation. Pure — no BB SDK.
 */
import type { V3WorkNode, V3WorkNodeDraft } from "./types";

export const MAX_V3_NODES = 64;
export const MAX_V3_TITLE = 200;
export const MAX_V3_OBJECTIVE = 4000;
export const MAX_V3_CRITERIA = 16;
export const MAX_V3_COMMANDS = 16;
export const MAX_V3_ARTIFACTS = 16;
export const MAX_V3_HINTS = 16;

function slug(title: string): string {
  const out = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return out || "task";
}

export function assignV3NodeIds(
  drafts: V3WorkNodeDraft[],
  unique: () => string,
): V3WorkNode[] {
  const taken = new Set<string>();
  return drafts.map((draft) => {
    const base = slug(draft.title);
    let id = base;
    while (taken.has(id)) id = `${base}-${unique().slice(0, 6)}`;
    taken.add(id);
    return {
      id,
      title: draft.title.trim(),
      objective: draft.objective.trim(),
      dependencies: [...(draft.dependencies ?? [])],
      acceptanceCriteria: [...draft.acceptanceCriteria],
      verificationCommands: [...(draft.verificationCommands ?? [])],
      expectedArtifacts: [...(draft.expectedArtifacts ?? [])],
      skillHints: [...(draft.skillHints ?? [])],
      status: "pending" as const,
      planRevision: 1,
      attemptId: null,
      routingOverride: null,
    };
  });
}

export function validateV3Draft(drafts: unknown): { ok: true; nodes: V3WorkNodeDraft[] } | { ok: false; error: string } {
  if (!Array.isArray(drafts)) return { ok: false, error: "Plan draft must be an array of task nodes." };
  if (drafts.length === 0) return { ok: false, error: "Plan draft must contain at least one task node." };
  if (drafts.length > MAX_V3_NODES) return { ok: false, error: `Plan draft exceeds ${MAX_V3_NODES} nodes.` };
  const out: V3WorkNodeDraft[] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    const raw = drafts[i] as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return { ok: false, error: `Node ${i + 1} must be an object.` };
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const objective = typeof raw.objective === "string" ? raw.objective.trim() : "";
    if (title.length < 1 || title.length > MAX_V3_TITLE) {
      return { ok: false, error: `Node ${i + 1} title must be 1–${MAX_V3_TITLE} characters.` };
    }
    if (objective.length < 1 || objective.length > MAX_V3_OBJECTIVE) {
      return { ok: false, error: `Node ${i + 1} objective must be 1–${MAX_V3_OBJECTIVE} characters.` };
    }
    const criteria = raw.acceptanceCriteria;
    if (!Array.isArray(criteria) || criteria.length === 0) {
      return { ok: false, error: `Node ${i + 1} needs at least one acceptance criterion.` };
    }
    if (criteria.length > MAX_V3_CRITERIA) return { ok: false, error: `Node ${i + 1} exceeds ${MAX_V3_CRITERIA} acceptance criteria.` };
    for (const c of criteria) {
      if (typeof c !== "string" || c.trim().length === 0 || c.length > 500) {
        return { ok: false, error: `Node ${i + 1} has an invalid acceptance criterion.` };
      }
    }
    const strList = (key: string, max: number): string[] | null => {
      const v = raw[key];
      if (v === undefined) return [];
      if (!Array.isArray(v)) return null;
      if (v.length > max) return null;
      const cleaned: string[] = [];
      for (const item of v) {
        if (typeof item !== "string") return null;
        const t = item.trim();
        if (!t) continue;
        if (t.length > 500) return null;
        cleaned.push(t);
      }
      return cleaned;
    };
    const verificationCommands = strList("verificationCommands", MAX_V3_COMMANDS);
    const expectedArtifacts = strList("expectedArtifacts", MAX_V3_ARTIFACTS);
    const skillHints = strList("skillHints", MAX_V3_HINTS);
    if (!verificationCommands || !expectedArtifacts || !skillHints) {
      return { ok: false, error: `Node ${i + 1} has an invalid list field.` };
    }
    const depsRaw = raw.dependencies;
    let dependencies: string[] = [];
    if (depsRaw !== undefined) {
      if (!Array.isArray(depsRaw)) return { ok: false, error: `Node ${i + 1} dependencies must be an array.` };
      for (const d of depsRaw) {
        if (typeof d !== "string" || d.trim().length === 0) {
          return { ok: false, error: `Node ${i + 1} has an invalid dependency.` };
        }
        dependencies.push(d.trim());
      }
    }
    // Reject legacy phase-node shapes explicitly.
    const phase = (raw as Record<string, unknown>).phase;
    if (typeof phase === "string" && ["explore", "plan", "critic", "promote"].includes(phase)) {
      return { ok: false, error: `Node ${i + 1} uses a legacy phase role "${phase}". v3 DAG nodes are implementation tasks only (worker role).` };
    }
    out.push({
      title,
      objective,
      dependencies,
      acceptanceCriteria: (criteria as string[]).map((s) => s.trim()),
      verificationCommands,
      expectedArtifacts,
      skillHints,
    });
  }
  // Dependency target check by title or id (titles are unique-enforced at assign time by caller).
  // Here we validate that dependency strings are non-empty; exact resolution happens after id assignment
  // by matching title or id. Unknown targets are rejected there.
  return { ok: true, nodes: out };
}

export function resolveV3Dependencies(
  nodes: Array<{ id: string; title: string }>,
  drafts: V3WorkNodeDraft[],
): { ok: true; resolved: string[][] } | { ok: false; error: string } {
  const byId = new Map(nodes.map((n) => [n.id, n.id]));
  const byTitle = new Map(nodes.map((n) => [n.title, n.id]));
  const resolved: string[][] = [];
  for (const draft of drafts) {
    const deps: string[] = [];
    for (const dep of draft.dependencies ?? []) {
      const hit = byId.get(dep) ?? byTitle.get(dep);
      if (!hit) return { ok: false, error: `Unknown dependency ${dep} for "${draft.title}".` };
      if (hit === dep && !byId.has(dep)) return { ok: false, error: `Unknown dependency ${dep}.` };
      deps.push(hit);
    }
    resolved.push(deps);
  }
  return { ok: true, resolved };
}

export function wouldCycleV3(
  nodes: ReadonlyArray<{ id: string; dependencies: readonly string[] }>,
): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const node = byId.get(id);
    for (const dep of node?.dependencies ?? []) {
      if (!byId.has(dep)) continue;
      if (walk(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const n of nodes) {
    if (walk(n.id)) return true;
  }
  return false;
}

export function readyV3Nodes<T extends { status: string; dependencies: readonly string[] }>(
  nodes: readonly T[],
): T[] {
  const done = new Set(
    nodes.filter((n) => n.status === "done" || n.status === "skipped").map((n) => (n as unknown as { id: string }).id as string),
  );
  const byIdDone = (id: string) => done.has(id);
  return nodes.filter((n) => n.status === "pending" || n.status === "ready" || n.status === "invalidated").filter((n) => n.dependencies.every(byIdDone)) as T[];
}

export function nextReadyV3<T extends { status: string; dependencies: readonly string[] }>(
  nodes: readonly T[],
): T | null {
  return readyV3Nodes(nodes)[0] ?? null;
}

export function downstreamV3(
  nodes: ReadonlyArray<{ id: string; dependencies: readonly string[] }>,
  seeds: readonly string[],
): Set<string> {
  const affected = new Set<string>(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (affected.has(n.id)) continue;
      if (n.dependencies.some((d) => affected.has(d))) {
        affected.add(n.id);
        grew = true;
      }
    }
  }
  return affected;
}

export function allRequiredDone(
  nodes: ReadonlyArray<{ status: string }>,
): boolean {
  return nodes.every((n) => n.status === "done" || n.status === "skipped");
}
