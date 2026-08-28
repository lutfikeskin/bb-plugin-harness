export const CRITIC_VERDICTS = ["APPROVE", "REWORK", "BLOCK"] as const;
export type CriticVerdict = (typeof CRITIC_VERDICTS)[number];

export const ARTIFACT_POLICIES = ["off", "advisory", "required"] as const;
export type ArtifactPolicy = (typeof ARTIFACT_POLICIES)[number];

export const PROMOTE_MODES = ["always", "off"] as const;
export type PromoteMode = (typeof PROMOTE_MODES)[number];

export const PLUGIN_SKILL_NAME = "harness-arc";
export const MAX_PHASE_SKILLS = 16;
export const MAX_SKILL_NAME_LENGTH = 80;
export const MAX_CORRECTIONS = 99;
export const MAX_ARTIFACT_PATHS = 32;
export const MAX_ARTIFACT_PATH_LENGTH = 500;
export const MAX_RESULT_SUMMARY = 8000;

export type TokenCounters = {
  input: number | null;
  cached: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
};

export type NodeAttemptTelemetry = {
  providerId: string | null;
  model: string | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  tokens: TokenCounters;
  source: string;
};

export function isCriticVerdict(value: string): value is CriticVerdict {
  return (CRITIC_VERDICTS as readonly string[]).includes(value);
}

export function isArtifactPolicy(value: string): value is ArtifactPolicy {
  return (ARTIFACT_POLICIES as readonly string[]).includes(value);
}

export function isPromoteMode(value: string): value is PromoteMode {
  return (PROMOTE_MODES as readonly string[]).includes(value);
}

/** `ask` is a retired alias of `always`. Unknown values are not promote modes. */
export function parsePromoteMode(value: unknown): PromoteMode {
  if (value === "off") return "off";
  return "always";
}

export function isSafeArtifactRef(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, "/");
  if (!normalized || normalized.length > MAX_ARTIFACT_PATH_LENGTH) return false;
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
  if (normalized.includes("://")) return false;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  return parts[0] === "artifacts";
}

export function parseSkillNames(_value: unknown): string[] {
  return [];
}

export function parseMaxCorrections(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < 0 || value > MAX_CORRECTIONS) return undefined;
  return value;
}

export function parseArtifactPaths(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_ARTIFACT_PATHS) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const path = item.trim().replace(/\\/g, "/");
    if (path.length === 0) continue;
    if (!isSafeArtifactRef(path)) return null;
    if (out.includes(path)) continue;
    out.push(path);
  }
  return out;
}

export function artifactDirForPlan(planId: string): string {
  return `artifacts/harness/${planId}`;
}

export function artifactManifestPath(planId: string): string {
  return `${artifactDirForPlan(planId)}/manifest.json`;
}

function readTokenGroup(value: unknown): TokenCounters | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const numberOrNull = (key: string): number | null => {
    const item = record[key];
    return typeof item === "number" && Number.isFinite(item) ? item : null;
  };
  return {
    input: numberOrNull("inputTokens") ?? numberOrNull("input"),
    cached: numberOrNull("cachedInputTokens") ?? numberOrNull("cached"),
    output: numberOrNull("outputTokens") ?? numberOrNull("output"),
    reasoning: numberOrNull("reasoningOutputTokens") ?? numberOrNull("reasoning"),
    total: numberOrNull("totalTokens") ?? numberOrNull("total"),
  };
}

/** Read counters from a BB `thread/tokenUsage/updated` event or its stored row. Missing usage stays null. */
export function parseTokenUsageEvent(value: unknown): TokenCounters | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nested =
    record.tokenUsage ??
    (record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>).tokenUsage
      : undefined);
  if (!nested || typeof nested !== "object") return null;
  const usage = nested as Record<string, unknown>;
  return readTokenGroup(usage.total) ?? readTokenGroup(usage.last) ?? readTokenGroup(usage);
}

export function emptyTokenCounters(): TokenCounters {
  return { input: null, cached: null, output: null, reasoning: null, total: null };
}

export function addTokenCounters(left: TokenCounters, right: TokenCounters): TokenCounters {
  const add = (a: number | null, b: number | null): number | null => {
    if (a == null && b == null) return null;
    return (a ?? 0) + (b ?? 0);
  };
  return {
    input: add(left.input, right.input),
    cached: add(left.cached, right.cached),
    output: add(left.output, right.output),
    reasoning: add(left.reasoning, right.reasoning),
    total: add(left.total, right.total),
  };
}

export function durationMs(startedAt: number | null, endedAt: number | null): number | null {
  if (startedAt == null || endedAt == null || endedAt < startedAt) return null;
  return endedAt - startedAt;
}

export function canRework(correctionCount: number, maxCorrections: number | null): boolean {
  if (maxCorrections == null) return true;
  return correctionCount < maxCorrections;
}
