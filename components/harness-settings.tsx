import { useCallback, useEffect, useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
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
import { Button } from "@/components/ui/button";

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
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Pick a real provider and model for each role. Standard Harness: Explore
        and Plan inherit on the parent; Worker, Critic, and Promote spawn
        children unless a custom definition changes execution. Leave a slot
        unset to inherit the parent thread.
      </p>
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
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
