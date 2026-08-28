import { useId, useState } from "react";
import type { FormEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { PHASES, PHASE_COPY, type ExecutionMode, type PhaseSpec } from "../lib/harness";
import {
  STANDARD_HARNESS_ID,
  builtinHarnesses,
  type HarnessDefinition,
} from "../lib/definitions";
import { ARTIFACT_POLICIES, PROMOTE_MODES, type ArtifactPolicy, type PromoteMode } from "../lib/outcomes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function StartHarnessForm({
  pending,
  disabled,
  customHarnesses,
  onStart,
  onRefresh,
}: {
  pending: boolean;
  disabled?: boolean;
  customHarnesses: HarnessDefinition[];
  onStart: (input: {
    objective: string;
    harnessId: string;
  }) => void;
  onRefresh: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const formId = useId();
  const catalog = [...builtinHarnesses(), ...customHarnesses];
  const [objective, setObjective] = useState("");
  const [harnessId, setHarnessId] = useState(STANDARD_HARNESS_ID);
  const [editor, setEditor] = useState<"create" | "edit" | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("Custom Harness");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftPhases, setDraftPhases] = useState(builtinHarnesses()[0]!.phases);
  const [draftArtifactPolicy, setDraftArtifactPolicy] = useState<ArtifactPolicy>("advisory");
  const [draftPromoteMode, setDraftPromoteMode] = useState<PromoteMode>("always");
  const [draftMaxCorrections, setDraftMaxCorrections] = useState("");
  const selected = catalog.find((item) => item.id === harnessId) ?? catalog[0]!;
  const canStart = objective.trim() !== "" && !pending && !disabled;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canStart) return;
    onStart({
      objective: objective.trim(),
      harnessId: selected.id,
    });
  };

  const loadDraft = (definition: HarnessDefinition) => {
    setDraftName(definition.name);
    setDraftDescription(definition.description);
    setDraftPhases(definition.phases);
    setDraftArtifactPolicy(definition.artifactPolicy);
    setDraftPromoteMode(definition.promoteMode);
    setDraftMaxCorrections(
      definition.maxCorrections == null ? "" : String(definition.maxCorrections),
    );
  };

  const openCreate = () => {
    loadDraft({ ...builtinHarnesses()[0]!, name: "Custom Harness" });
    setEditor("create");
  };

  const openEdit = () => {
    if (selected.kind !== "custom") return;
    loadDraft(selected);
    setEditor("edit");
  };

  const parsedMax = (): number | null | undefined => {
    const raw = draftMaxCorrections.trim();
    if (raw === "") return null;
    const value = Number(raw);
    if (!Number.isInteger(value)) return undefined;
    return value;
  };

  const saveDraft = async () => {
    setMutationError(null);
    const maxCorrections = parsedMax();
    if (maxCorrections === undefined) {
      setMutationError("maxCorrections must be an integer 0–99, or empty for unlimited.");
      return;
    }
    try {
      if (editor === "create") {
        const result = await rpc.call("createHarness", {
          name: draftName,
          description: draftDescription,
          phases: draftPhases,
          artifactPolicy: draftArtifactPolicy,
          promoteMode: draftPromoteMode,
          maxCorrections,
        });
        setHarnessId(result.harness.id);
      } else if (editor === "edit" && selected.kind === "custom") {
        await rpc.call("updateHarness", {
          id: selected.id,
          name: draftName,
          description: draftDescription,
          phases: draftPhases,
          artifactPolicy: draftArtifactPolicy,
          promoteMode: draftPromoteMode,
          maxCorrections,
        });
      }
      setEditor(null);
      onRefresh();
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const setPhase = (phase: keyof typeof draftPhases, patch: Partial<PhaseSpec>) => {
    setDraftPhases((current) => ({
      ...current,
      [phase]: { ...current[phase], ...patch },
    }));
  };

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <div className="space-y-1.5">
        <label htmlFor={`${formId}-task`} className="text-sm font-medium">
          Task
        </label>
        <textarea
          id={`${formId}-task`}
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          placeholder="What should this Harness accomplish?"
          rows={4}
          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled || pending}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${formId}-harness`} className="text-sm font-medium">
          Harness
        </label>
        <select
          id={`${formId}-harness`}
          value={selected.id}
          onChange={(event) => setHarnessId(event.target.value)}
          disabled={disabled || pending}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
        >
          {catalog.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.id === STANDARD_HARNESS_ID ? " (default)" : ""}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground">{selected.description}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={openCreate}>
            Create Harness
          </Button>
          {selected.kind === "custom" ? (
            <>
              <Button type="button" size="sm" variant="outline" onClick={openEdit}>
                Edit
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMutationError(null);
                  void rpc.call("deleteHarness", { id: selected.id }).then(
                    () => {
                      setHarnessId(STANDARD_HARNESS_ID);
                      onRefresh();
                    },
                    (cause: unknown) => {
                      setMutationError(
                        cause instanceof Error ? cause.message : String(cause),
                      );
                    },
                  );
                }}
              >
                Delete
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {editor ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-sm font-medium">
            {editor === "create" ? "Create Harness" : "Edit Harness"}
          </p>
          <Input
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder="Name"
            aria-label="Harness name"
          />
          <textarea
            value={draftDescription}
            onChange={(event) => setDraftDescription(event.target.value)}
            placeholder="Description"
            aria-label="Harness description"
            rows={2}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          />
          {PHASES.map((phase) => (
            <div key={phase} className="space-y-1">
              <p className="text-xs font-medium">{PHASE_COPY[phase].label} instructions</p>
              <Input
                value={draftPhases[phase].title}
                onChange={(event) => setPhase(phase, { title: event.target.value })}
                aria-label={`${PHASE_COPY[phase].label} title`}
              />
              <textarea
                value={draftPhases[phase].detail}
                onChange={(event) => setPhase(phase, { detail: event.target.value })}
                aria-label={`${PHASE_COPY[phase].label} instructions`}
                rows={2}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
              />
            </div>
          ))}
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setShowAdvanced((value) => !value)}
          >
            {showAdvanced ? "Hide Advanced" : "Advanced"}
          </button>
          {showAdvanced ? (
            <div className="space-y-2">
              {PHASES.map((phase) => (
                <div key={`${phase}-adv`}>
                  <label className="text-[11px] text-muted-foreground">
                    {PHASE_COPY[phase].label} execution
                    <select
                      aria-label={`${PHASE_COPY[phase].label} execution`}
                      value={draftPhases[phase].execution}
                      onChange={(event) =>
                        setPhase(phase, { execution: event.target.value as ExecutionMode })
                      }
                      className="mt-1 flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                    >
                      <option value="parent">parent</option>
                      <option value="child">child</option>
                    </select>
                  </label>
                </div>
              ))}
              <label className="block text-[11px] text-muted-foreground">
                Artifact policy
                <select
                  aria-label="Artifact policy"
                  value={draftArtifactPolicy}
                  onChange={(event) =>
                    setDraftArtifactPolicy(event.target.value as ArtifactPolicy)
                  }
                  className="mt-1 flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                >
                  {ARTIFACT_POLICIES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-[11px] text-muted-foreground">
                Promote mode
                <select
                  aria-label="Promote mode"
                  value={draftPromoteMode}
                  onChange={(event) => setDraftPromoteMode(event.target.value as PromoteMode)}
                  className="mt-1 flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                >
                  {PROMOTE_MODES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-[11px] text-muted-foreground">
                Max corrections (empty = unlimited)
                <Input
                  value={draftMaxCorrections}
                  onChange={(event) => setDraftMaxCorrections(event.target.value)}
                  aria-label="Max corrections"
                  placeholder="unlimited"
                />
              </label>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => void saveDraft()}>
              Save Harness
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditor(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {mutationError ? (
        <p role="alert" className="text-sm text-destructive">
          {mutationError}
        </p>
      ) : null}
      <Button type="submit" disabled={!canStart}>
        Start Harness
      </Button>
    </form>
  );
}
