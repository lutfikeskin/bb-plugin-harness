import { useId, useState } from "react";
import type { FormEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { PHASES, PHASE_COPY } from "../lib/harness";
import {
  STANDARD_HARNESS_ID,
  builtinHarnesses,
  type HarnessDefinition,
} from "../lib/definitions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function parsePathList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

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
    runScout: boolean;
    execPlanPath?: string;
    branch?: string;
    protectedPaths?: string[];
    specialistQuestion?: string;
  }) => void;
  onRefresh: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const formId = useId();
  const catalog = [...builtinHarnesses(), ...customHarnesses];
  const [objective, setObjective] = useState("");
  const [harnessId, setHarnessId] = useState(STANDARD_HARNESS_ID);
  const [runScout, setRunScout] = useState(true);
  const [execPlanPath, setExecPlanPath] = useState("");
  const [branch, setBranch] = useState("");
  const [protectedPaths, setProtectedPaths] = useState("");
  const [specialistQuestion, setSpecialistQuestion] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [editor, setEditor] = useState<"create" | "edit" | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("Custom Harness");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftPhases, setDraftPhases] = useState(builtinHarnesses()[0]!.phases);
  const selected = catalog.find((item) => item.id === harnessId) ?? catalog[0]!;
  const milestone = selected.engine === "milestone";
  const canStart = objective.trim() !== "" && !pending && !disabled;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canStart) return;
    const paths = parsePathList(protectedPaths);
    onStart({
      objective: objective.trim(),
      harnessId: selected.id,
      runScout,
      ...(milestone && execPlanPath.trim()
        ? { execPlanPath: execPlanPath.trim() }
        : {}),
      ...(milestone && branch.trim() ? { branch: branch.trim() } : {}),
      ...(milestone && paths.length > 0 ? { protectedPaths: paths } : {}),
      ...(milestone && specialistQuestion.trim()
        ? { specialistQuestion: specialistQuestion.trim() }
        : {}),
    });
  };

  const openCreate = () => {
    const standard = builtinHarnesses()[0]!;
    setDraftName("Custom Harness");
    setDraftDescription(standard.description);
    setDraftPhases(standard.phases);
    setEditor("create");
  };

  const openEdit = () => {
    if (selected.kind !== "custom") return;
    setDraftName(selected.name);
    setDraftDescription(selected.description);
    setDraftPhases(selected.phases);
    setEditor("edit");
  };

  const saveDraft = async () => {
    setMutationError(null);
    try {
      if (editor === "create") {
        const result = await rpc.call("createHarness", {
          name: draftName,
          description: draftDescription,
          phases: draftPhases,
        });
        setHarnessId(result.harness.id);
      } else if (editor === "edit" && selected.kind === "custom") {
        await rpc.call("updateHarness", {
          id: selected.id,
          name: draftName,
          description: draftDescription,
          phases: draftPhases,
        });
      }
      setEditor(null);
      onRefresh();
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : String(cause));
    }
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
                onChange={(event) =>
                  setDraftPhases((current) => ({
                    ...current,
                    [phase]: { ...current[phase], title: event.target.value },
                  }))
                }
                aria-label={`${PHASE_COPY[phase].label} title`}
              />
              <textarea
                value={draftPhases[phase].detail}
                onChange={(event) =>
                  setDraftPhases((current) => ({
                    ...current,
                    [phase]: { ...current[phase], detail: event.target.value },
                  }))
                }
                aria-label={`${PHASE_COPY[phase].label} instructions`}
                rows={2}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
              />
            </div>
          ))}
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
      {milestone ? (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={runScout}
              onChange={(event) => setRunScout(event.target.checked)}
              disabled={disabled || pending}
            />
            Run Scout
          </label>
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setShowAdvanced((value) => !value)}
          >
            {showAdvanced ? "Hide optional fields" : "Optional fields"}
          </button>
          {showAdvanced ? (
            <div className="space-y-2">
              <Input
                value={execPlanPath}
                onChange={(event) => setExecPlanPath(event.target.value)}
                placeholder="ExecPlan path"
                aria-label="ExecPlan path"
                disabled={disabled || pending}
              />
              <Input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="Branch"
                aria-label="Branch"
                disabled={disabled || pending}
              />
              <Input
                value={protectedPaths}
                onChange={(event) => setProtectedPaths(event.target.value)}
                placeholder="Protected paths (comma-separated)"
                aria-label="Protected paths"
                disabled={disabled || pending}
              />
              <Input
                value={specialistQuestion}
                onChange={(event) => setSpecialistQuestion(event.target.value)}
                placeholder="Specialist question"
                aria-label="Specialist question"
                disabled={disabled || pending}
              />
            </div>
          ) : null}
        </>
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
