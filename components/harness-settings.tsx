import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  useBbContext,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import {
  ROUTING_SLOTS,
  ROUTING_SLOT_COPY,
  type ExecutionChoice,
  type RoleRouting,
  type RoutingSlot,
  emptyRoleRouting,
} from "../lib/harness";
import { V3_ROLES, type V3Role } from "../lib/v3/types";
import { Button } from "@/components/ui/button";

type V3Choice = {
  providerId: string;
  model: string;
  reasoningLevel: string;
  serviceTier?: "default" | "fast";
};
type V3PresetDto = {
  id: string;
  name: string;
  scope: "global" | "project";
  projectId: string | null;
  roles: Record<V3Role, { choice: V3Choice | null; permissionMode: "accept-edits" | "auto" | null; skillHints: string[] }>;
  promotionMode: "ask" | "off" | "always";
  artifactPolicy: "advisory" | "required";
};

const V3_ROLE_LABELS: Record<V3Role, string> = {
  explorer: "Explorer",
  planner: "Planner",
  workerFirst: "First Worker",
  workerRest: "Later Workers",
  critic: "Critic",
  promoter: "Promoter",
};

function blankDraft(projectId: string | null): V3PresetDto {
  const roles = {} as V3PresetDto["roles"];
  for (const role of V3_ROLES) roles[role] = { choice: null, permissionMode: null, skillHints: [] };
  return { id: "", name: "", scope: "global", projectId, roles, promotionMode: "ask", artifactPolicy: "advisory" };
}

function V3PresetEditor() {
  const ctx = useBbContext();
  const rpc = useRpc();
  // Stable caller: binding rpc.call inline creates a new function every
  // render and would retrigger the fetch effect endlessly.
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const call = useCallback(
    (method: string, input: unknown) =>
      (rpcRef.current.call as (m: string, i: unknown) => Promise<unknown>)(method, input),
    [],
  );
  const [presets, setPresets] = useState<V3PresetDto[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<V3PresetDto>(() => blankDraft(ctx.projectId));
  const [isNew, setIsNew] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectRef = useRef({ isNew, selectedId });
  selectRef.current = { isNew, selectedId };

  const refetch = useCallback(() => {
    call("v3PresetList", ctx.projectId ? { projectId: ctx.projectId } : {}).then(
      (r) => {
        const list = ((r as { presets: V3PresetDto[] }).presets ?? []);
        setPresets(list);
        setError(null);
        const { isNew: fresh, selectedId: sel } = selectRef.current;
        if (list.length === 0) {
          // No presets at all: start in New mode instead of a broken Save.
          setIsNew(true);
          setSelectedId("");
          setDraft(blankDraft(ctx.projectId));
          return;
        }
        if (!fresh) {
          const current = list.find((p) => p.id === sel) ?? list[0];
          if (current) {
            setSelectedId(current.id);
            setDraft(JSON.parse(JSON.stringify(current)) as V3PresetDto);
          }
        }
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [call, ctx.projectId]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("harness", refetch);

  const save = async () => {
    if (!draft.name.trim()) {
      setError("Preset name is required.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (isNew) {
        const created = (await call("v3PresetCreate", {
          name: draft.name.trim(),
          scope: draft.scope,
          projectId: draft.scope === "project" ? (draft.projectId || ctx.projectId) : null,
          roles: draft.roles,
          promotionMode: draft.promotionMode,
          artifactPolicy: draft.artifactPolicy,
        })) as { preset: V3PresetDto };
        setPresets((cur) => [...cur, created.preset]);
        setSelectedId(created.preset.id);
        setDraft(JSON.parse(JSON.stringify(created.preset)) as V3PresetDto);
        setIsNew(false);
      } else {
        const updated = (await call("v3PresetUpdate", {
          id: draft.id,
          name: draft.name.trim(),
          roles: draft.roles,
          promotionMode: draft.promotionMode,
          artifactPolicy: draft.artifactPolicy,
        })) as { preset: V3PresetDto };
        setPresets((cur) => cur.map((p) => (p.id === updated.preset.id ? updated.preset : p)));
        setDraft(JSON.parse(JSON.stringify(updated.preset)) as V3PresetDto);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (!draft.id || !window.confirm(`Delete preset "${draft.name}"? Future runs cannot use it.`)) return;
    setPending(true);
    try {
      await call("v3PresetDelete", { id: draft.id });
      setPresets((cur) => cur.filter((p) => p.id !== draft.id));
      setSelectedId("");
      setDraft(blankDraft(ctx.projectId));
      setIsNew(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  const setRoleChoice = (role: V3Role, choice: V3Choice | null) => {
    setDraft((d) => ({ ...d, roles: { ...d.roles, [role]: { ...d.roles[role], choice } } }));
  };
  const setRolePermission = (role: V3Role, permissionMode: "accept-edits" | "auto" | null) => {
    setDraft((d) => ({ ...d, roles: { ...d.roles, [role]: { ...d.roles[role], permissionMode } } }));
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">Role presets (v3)</h3>
        <p className="text-[11px] text-muted-foreground">
          Provider, model, and permission per role. Snapshotted at Start — edits affect future runs only.
          First Worker / Later Workers approximates model specialization; it is not true prewalk.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Role preset"
          value={isNew ? "__new" : selectedId}
          disabled={pending}
          onChange={(e) => {
            const id = e.target.value;
            if (id === "__new") {
              setIsNew(true);
              setSelectedId("");
              setDraft(blankDraft(ctx.projectId));
              return;
            }
            const found = presets.find((p) => p.id === id);
            if (found) {
              setIsNew(false);
              setSelectedId(id);
              setDraft(JSON.parse(JSON.stringify(found)) as V3PresetDto);
            }
          }}
          className="flex h-9 min-w-40 rounded-md border border-input bg-transparent px-3 text-sm"
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>{p.name}{p.scope === "project" ? " (project)" : ""}</option>
          ))}
          <option value="__new">+ New preset…</option>
        </select>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void save()}>Save preset</Button>
        {!isNew ? (
          <Button size="sm" variant="ghost" disabled={pending || draft.id === "migrated-role-routing"} onClick={() => void remove()}>Delete</Button>
        ) : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-[12px] text-muted-foreground" htmlFor="v3-preset-name">Name
          <input
            id="v3-preset-name"
            value={draft.name}
            disabled={pending}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground"
          />
        </label>
        <label className="block text-[12px] text-muted-foreground" htmlFor="v3-preset-scope">Scope
          <select
            id="v3-preset-scope"
            value={draft.scope}
            disabled={pending || !isNew}
            onChange={(e) => setDraft((d) => ({ ...d, scope: e.target.value as "global" | "project" }))}
            className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground"
          >
            <option value="global">Global</option>
            <option value="project">Project</option>
          </select>
        </label>
      </div>
      {V3_ROLES.map((role) => {
        const exec = draft.roles[role];
        return (
          <div key={role} className="space-y-1.5 border-b border-border pb-3 last:border-0">
            <p className="text-sm font-medium">{V3_ROLE_LABELS[role]}</p>
            {exec.choice ? (
              <div className="flex flex-wrap items-center gap-2">
                <ProviderModelPicker
                  value={exec.choice as never}
                  disabled={pending}
                  onChange={(v) => setRoleChoice(role, v as unknown as V3Choice)}
                />
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setRoleChoice(role, null)}>Clear</Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs text-muted-foreground">Inherits the parent thread</p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    // Seed from a real catalog default so the picker always
                    // opens on a valid provider/model, never a blank value.
                    setPending(true);
                    call("suggestChoice", {}).then(
                      (r) => {
                        const c = (r as { choice: V3Choice }).choice;
                        setRoleChoice(role, { providerId: c.providerId, model: c.model, reasoningLevel: c.reasoningLevel });
                        setPending(false);
                      },
                      (cause: unknown) => {
                        setError(cause instanceof Error ? cause.message : String(cause));
                        setPending(false);
                      },
                    );
                  }}
                >
                  Set
                </Button>
              </div>
            )}
            <label className="block text-[11px] text-muted-foreground" htmlFor={`v3-perm-${role}`}>Permission
              <select
                id={`v3-perm-${role}`}
                value={exec.permissionMode ?? ""}
                disabled={pending}
                onChange={(e) => setRolePermission(role, (e.target.value || null) as "accept-edits" | "auto" | null)}
                className="mt-1 flex h-8 w-44 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
              >
                <option value="">Inherit</option>
                <option value="accept-edits">accept-edits</option>
                <option value="auto">auto</option>
              </select>
            </label>
          </div>
        );
      })}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-[12px] text-muted-foreground" htmlFor="v3-promotion">Promotion
          <select
            id="v3-promotion"
            value={draft.promotionMode}
            disabled={pending}
            onChange={(e) => setDraft((d) => ({ ...d, promotionMode: e.target.value as V3PresetDto["promotionMode"] }))}
            className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground"
          >
            <option value="ask">Ask each run</option>
            <option value="always">Always offer</option>
            <option value="off">Off</option>
          </select>
        </label>
        <label className="block text-[12px] text-muted-foreground" htmlFor="v3-artifacts">Artifacts
          <select
            id="v3-artifacts"
            value={draft.artifactPolicy}
            disabled={pending}
            onChange={(e) => setDraft((d) => ({ ...d, artifactPolicy: e.target.value as V3PresetDto["artifactPolicy"] }))}
            className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground"
          >
            <option value="advisory">Advisory</option>
            <option value="required">Required</option>
          </select>
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

export function SlotModelPicker({
  choice,
  disabled,
  onChange,
}: {
  choice: ExecutionChoice | null;
  disabled?: boolean;
  onChange: (choice: ExecutionChoice | null) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setDefault = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("suggestChoice", {});
      onChange(result.choice);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {choice ? (
          <>
            <ProviderModelPicker
              value={choice}
              disabled={disabled || busy}
              onChange={onChange}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || busy}
              onClick={() => onChange(null)}
            >
              Clear
            </Button>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Not set — inherits the parent thread
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || busy}
              onClick={() => void setDefault()}
            >
              Set
            </Button>
          </>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function NodeRoutingControl({
  effective,
  override,
  editable,
  disabled,
  onChange,
}: {
  effective: ExecutionChoice | null;
  override: ExecutionChoice | null;
  editable: boolean;
  disabled?: boolean;
  onChange: (choice: ExecutionChoice | null) => void;
}) {
  if (!editable) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Model: {effective ? `${effective.providerId}/${effective.model} (${effective.reasoningLevel})` : "inherits the parent thread"}
        {override ? " · node override" : effective ? " · role default" : ""}
      </p>
    );
  }
  if (override) {
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <ProviderModelPicker
            value={override}
            disabled={disabled}
            onChange={onChange}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            Revert to role default
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Node override — role default is{" "}
          {effective ? `${effective.providerId}/${effective.model} (${effective.reasoningLevel})` : "unset"}.
        </p>
      </div>
    );
  }
  if (effective) {
    return (
      <div className="space-y-1.5">
        <p className="text-[11px] text-muted-foreground">
          Model: {effective.providerId}/{effective.model} ({effective.reasoningLevel}) · role default
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange(effective)}
        >
          Override for this node
        </Button>
      </div>
    );
  }
  return (
    <SlotModelPicker choice={null} disabled={disabled} onChange={onChange} />
  );
}

export function HarnessSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [routing, setRouting] = useState<RoleRouting>(emptyRoleRouting);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refetch = useCallback(() => {
    rpc.call("getRouting", {}).then(
      (result) => {
        setRouting(result.routing);
        setError(null);
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [rpc]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("harness", refetch);

  const save = async (slot: RoutingSlot, choice: ExecutionChoice | null) => {
    setPending(true);
    try {
      const result = await rpc.call("setRouting", { slot, choice });
      setRouting(result.routing);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-6">
      <V3PresetEditor />
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">Legacy routing (v0.1/v2)</h3>
          <p className="text-[11px] text-muted-foreground">
            Read-compatible defaults for legacy runs. Migrated once into the “Migrated role routing” v3 preset; new runs use v3 presets above.
          </p>
        </div>
        {ROUTING_SLOTS.map((slot) => (
          <div key={slot} className="space-y-1.5 border-b border-border pb-3 last:border-0">
            <p className="text-sm font-medium">{ROUTING_SLOT_COPY[slot].label}</p>
            <p className="text-[11px] text-muted-foreground">
              {ROUTING_SLOT_COPY[slot].hint}
            </p>
            <SlotModelPicker
              choice={routing[slot]}
              disabled={pending}
              onChange={(choice) => void save(slot, choice)}
            />
          </div>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
