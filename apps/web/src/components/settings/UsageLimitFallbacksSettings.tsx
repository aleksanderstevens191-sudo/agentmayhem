import { useState } from "react";
import type { ModelSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import * as Equal from "effect/Equal";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  getDefaultProviderInstanceModel,
  isProviderInstancePickerReady,
  providerInstanceEntriesFor,
} from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { reconcileSnoozeDraft } from "./SnoozePresetsSettings.logic";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

type Fallbacks = ReadonlyArray<ModelSelection>;

function moveEntry(list: Fallbacks, index: number, steps: number): Fallbacks {
  const to = Math.max(0, Math.min(list.length - 1, index + steps));
  if (to === index) return list;
  const next = [...list];
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved!);
  return next;
}

// Keys follow an entry when it moves, so focus stays on the button that moved it.
function rowKeys(list: Fallbacks): ReadonlyArray<string> {
  const seen = new Map<string, number>();
  return list.map((entry) => {
    const base = `${entry.instanceId}\u0000${entry.model}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return `${base}\u0000${count}`;
  });
}

/**
 * The agents a usage-limited thread continues on, in order. The server's
 * `nextUsageLimitFallback` walks this list, skipping entries on the agent the thread is already on.
 */
export function UsageLimitFallbacksRow() {
  const { target } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers =
    (representative?.serverConfig
      ? providersByEnvironment.get(representative.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const modelDisabledReason = useScopedModelDisabledReason(settings, entries);
  const mixed = useScopedSettingsMixed(["usageLimitFallbacks"]);
  const saved = settings.usageLimitFallbacks;

  // Edits build on a local draft, so a second click before the first save echoes back keeps both.
  const [draft, setDraft] = useState<Fallbacks>(saved);
  const [written, setWritten] = useState<ReadonlyArray<Fallbacks>>([]);
  // Null forces the next render to adopt the saved value, as after a failed write.
  const [savedSource, setSavedSource] = useState<Fallbacks | null>(saved);
  if (!Equal.equals(savedSource, saved)) {
    setSavedSource(saved);
    const reconciled = reconcileSnoozeDraft(written, saved);
    if (reconciled.adopt) {
      setWritten([]);
      setDraft(saved);
    } else {
      setWritten(reconciled.pending);
    }
  }
  const save = (usageLimitFallbacks: Fallbacks) => {
    // Environments disagree, so an equal-looking list must still write to all of them.
    if (!mixed && Equal.equals(usageLimitFallbacks, draft)) return;
    setDraft(usageLimitFallbacks);
    setWritten((previous) => [...previous, usageLimitFallbacks]);
    updateSettings(
      { usageLimitFallbacks },
      {
        onFailed: () => {
          setWritten([]);
          setSavedSource(null);
        },
      },
    );
  };
  const choose = (index: number, instanceId: ModelSelection["instanceId"], model: string) => {
    const reason = modelDisabledReason(instanceId, model);
    if (reason) {
      toastManager.add({ type: "error", title: "Fallback agent not saved", description: reason });
      return;
    }
    const selection = createModelSelection(instanceId, model);
    save(
      index === draft.length
        ? [...draft, selection]
        : draft.map((entry, candidate) => (candidate === index ? selection : entry)),
    );
  };

  const listed = new Set(draft.map((entry) => entry.instanceId));
  const ready = entries.filter(isProviderInstancePickerReady);
  const unlisted = ready.filter((entry) => !listed.has(entry.instanceId));
  // Skips agents that a selected environment lacks, so Add never retries a rejected one.
  const addable = unlisted.flatMap((entry) => {
    const model = getDefaultProviderInstanceModel(providers, entry.instanceId);
    return model !== undefined && modelDisabledReason(entry.instanceId, model) === null
      ? [{ instanceId: entry.instanceId, model }]
      : [];
  })[0];
  const keys = rowKeys(draft);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["usageLimitFallbacks"]}
      mixed={mixed}
      {...searchableSetting("usage-limit-fallbacks")}
      description="When a thread stops on a usage limit, it continues on the next agent below its current one, with the conversation so far. Threads on an agent that is not listed start at the top."
      status={
        mixed ? "Environments have different lists. A change here replaces all of them." : null
      }
      resetAction={
        mixed || draft.length > 0 ? (
          <SettingResetButton label="fallback agents" onClick={() => save([])} />
        ) : null
      }
    >
      <div className="flex flex-col gap-1.5 pt-3 pb-2">
        {draft.length > 0 ? (
          <ol
            aria-label="Fallback agents, first choice first"
            className="divide-y divide-border/60 rounded-lg border border-border/60"
          >
            {draft.map((entry, index) => {
              const name =
                entries.find((candidate) => candidate.instanceId === entry.instanceId)
                  ?.displayName ?? entry.instanceId;
              const note =
                modelDisabledReason(entry.instanceId, entry.model) !== null
                  ? "Unavailable, so a thread that reaches it stays stopped"
                  : draft[index - 1]?.instanceId === entry.instanceId
                    ? "Same agent as above, so threads skip it"
                    : null;
              return (
                <li
                  key={keys[index]}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 ps-3 pe-1.5"
                >
                  <span className="w-4 text-xs tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                  <ProviderModelPicker
                    environmentId={representative?.environmentId ?? null}
                    activeInstanceId={entry.instanceId}
                    model={entry.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={getCustomModelOptionsByInstance(
                      settings,
                      providers,
                      entry.instanceId,
                      entry.model,
                    )}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel={`Fallback agent ${index + 1}`}
                    getModelDisabledReason={modelDisabledReason}
                    onOpenProviderSetup={(instanceId) => {
                      if (representative)
                        void navigate({
                          to: "/settings/providers",
                          search: { environmentId: representative.environmentId, instanceId },
                        });
                    }}
                    onInstanceModelChange={(instanceId, model) => choose(index, instanceId, model)}
                  />
                  {/* Limits belong to an account, so name it beside the model. */}
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {note ? `${name} · ${note}` : name}
                  </span>
                  <span className="ms-auto flex items-center gap-0.5">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost-muted"
                      disabled={index === 0}
                      aria-label={`Move ${name} up`}
                      onClick={() => save(moveEntry(draft, index, -1))}
                    >
                      <ArrowUpIcon />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost-muted"
                      disabled={index === draft.length - 1}
                      aria-label={`Move ${name} down`}
                      onClick={() => save(moveEntry(draft, index, 1))}
                    >
                      <ArrowDownIcon />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Remove ${name}`}
                      onClick={() => save(draft.filter((_, candidate) => candidate !== index))}
                    >
                      <XIcon />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">
            No fallback agents. Limited threads wait for their limit to reset.
          </p>
        )}
        <div>
          <Button
            variant="ghost-muted"
            size="compact"
            disabled={!addable}
            onClick={() => {
              if (addable) choose(draft.length, addable.instanceId, addable.model);
            }}
          >
            <PlusIcon />
            Add agent
          </Button>
          {!addable ? (
            <span className="ps-2 text-xs text-muted-foreground">
              {unlisted.length > 0
                ? "The other agents are not on every selected environment"
                : ready.length > 0
                  ? "Every ready agent is listed"
                  : "No agents are ready"}
            </span>
          ) : null}
        </div>
      </div>
    </SettingsRow>
  );
}
