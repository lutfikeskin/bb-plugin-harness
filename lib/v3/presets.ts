/**
 * v3 presets and routing resolution. Pure — no BB SDK.
 */
import type { V3Role, V3RoleExecution, V3RolePreset, V3WorkNode } from "./types";
import { V3_ROLES } from "./types";

export function emptyRoleExecution(): V3RoleExecution {
  return { choice: null, permissionMode: null, skillHints: [] };
}

export function inheritPreset(id = "default-inherit", name = "Inherit parent"): V3RolePreset {
  const roles = {} as Record<V3Role, V3RoleExecution>;
  for (const role of V3_ROLES) roles[role] = emptyRoleExecution();
  return { id, name, scope: "global", projectId: null, roles, promotionMode: "ask", artifactPolicy: "advisory" };
}

export function validatePreset(raw: unknown): { ok: true; preset: V3RolePreset } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Preset must be an object." };
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!id || id.length > 64) return { ok: false, error: "Preset id must be 1–64 chars." };
  if (!name || name.length > 80) return { ok: false, error: "Preset name must be 1–80 chars." };
  const scope = r.scope === "project" ? "project" : r.scope === "global" || r.scope === undefined ? "global" : null;
  if (!scope) return { ok: false, error: "Preset scope must be global or project." };
  const projectId = r.projectId === null || r.projectId === undefined ? null : typeof r.projectId === "string" ? r.projectId : null;
  if (scope === "project" && !projectId) return { ok: false, error: "Project presets need a projectId." };
  const promotionMode = r.promotionMode === "off" || r.promotionMode === "always" || r.promotionMode === "ask" ? r.promotionMode : "ask";
  const artifactPolicy = r.artifactPolicy === "required" ? "required" : "advisory";
  const rolesRaw = (r.roles ?? {}) as Record<string, unknown>;
  const roles = {} as Record<V3Role, V3RoleExecution>;
  for (const role of V3_ROLES) {
    const item = rolesRaw[role] as Record<string, unknown> | undefined;
    if (!item) {
      roles[role] = emptyRoleExecution();
      continue;
    }
    const choiceRaw = item.choice as Record<string, unknown> | null | undefined;
    let choice: V3RoleExecution["choice"] = null;
    if (choiceRaw) {
      const providerId = typeof choiceRaw.providerId === "string" ? choiceRaw.providerId.trim() : "";
      const model = typeof choiceRaw.model === "string" ? choiceRaw.model.trim() : "";
      const reasoningLevel = typeof choiceRaw.reasoningLevel === "string" ? choiceRaw.reasoningLevel.trim() : "";
      if (!providerId || !model || !reasoningLevel) return { ok: false, error: `Preset role ${role} has an incomplete choice.` };
      choice = {
        providerId,
        model,
        reasoningLevel,
        ...(choiceRaw.serviceTier === "default" || choiceRaw.serviceTier === "fast" ? { serviceTier: choiceRaw.serviceTier } : {}),
      };
    }
    const permissionMode = item.permissionMode === "accept-edits" || item.permissionMode === "auto" ? item.permissionMode : null;
    // Never widen beyond accept-edits/auto: reject anything else.
    if (item.permissionMode !== undefined && item.permissionMode !== null && permissionMode === null) {
      return { ok: false, error: `Preset role ${role} has an invalid permissionMode.` };
    }
    const hints = Array.isArray(item.skillHints) ? item.skillHints.filter((s): s is string => typeof s === "string").slice(0, 16) : [];
    roles[role] = { choice, permissionMode, skillHints: hints };
  }
  return { ok: true, preset: { id, name, scope, projectId, roles, promotionMode, artifactPolicy } };
}

/** Snapshot semantics: later settings edits affect future runs only. */
export function snapshotPreset(preset: V3RolePreset): V3RolePreset {
  return JSON.parse(JSON.stringify(preset)) as V3RolePreset;
}

export function workerRoleForIndex(index: number): V3Role {
  return index <= 0 ? "workerFirst" : "workerRest";
}

export function resolveNodeRouting(args: {
  preset: V3RolePreset;
  nodes: readonly V3WorkNode[];
  node: V3WorkNode;
  workerIndex: number;
}): { choice: V3RoleExecution["choice"]; source: "preset" | "node override" | "inherited"; skillHints: string[] } {
  if (args.node.routingOverride) {
    return { choice: args.node.routingOverride, source: "node override", skillHints: args.node.skillHints };
  }
  const role = workerRoleForIndex(args.workerIndex);
  const exec = args.preset.roles[role];
  if (exec?.choice) return { choice: exec.choice, source: "preset", skillHints: [...(exec.skillHints ?? []), ...args.node.skillHints] };
  return { choice: null, source: "inherited", skillHints: args.node.skillHints };
}

export function resolveRoleRouting(args: {
  preset: V3RolePreset;
  role: V3Role;
}): { choice: V3RoleExecution["choice"]; source: "preset" | "inherited"; permissionMode: V3RoleExecution["permissionMode"]; skillHints: string[] } {
  const exec = args.preset.roles[args.role];
  if (exec?.choice) return { choice: exec.choice, source: "preset", permissionMode: exec.permissionMode, skillHints: exec.skillHints };
  return { choice: null, source: "inherited", permissionMode: exec?.permissionMode ?? null, skillHints: exec?.skillHints ?? [] };
}

/** Migrate legacy six-slot routing into a named v3 preset. */
export function migrateLegacyRouting(legacy: Record<string, { providerId: string; model: string; reasoningLevel: string; serviceTier?: string } | null>): V3RolePreset {
  const map = (slot: string): V3RoleExecution => {
    const item = legacy[slot];
    if (!item) return emptyRoleExecution();
    return { choice: { providerId: item.providerId, model: item.model, reasoningLevel: item.reasoningLevel, ...(item.serviceTier === "default" || item.serviceTier === "fast" ? { serviceTier: item.serviceTier } : {}) }, permissionMode: null, skillHints: [] };
  };
  return {
    id: "migrated-role-routing",
    name: "Migrated role routing",
    scope: "global",
    projectId: null,
    roles: {
      explorer: map("explore"),
      planner: map("plan"),
      workerFirst: map("workerFirst"),
      workerRest: map("workerRest"),
      critic: map("critic"),
      promoter: map("promote"),
    },
    promotionMode: "ask",
    artifactPolicy: "advisory",
  };
}
