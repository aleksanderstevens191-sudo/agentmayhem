import { useState } from "react";
import type { AgentPlugin } from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { ExternalLinkIcon, PlusIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { PLUGIN_STORE } from "./pluginStore";
import {
  describePluginServer,
  parsePluginServer,
  pluginNameProblem,
} from "./PluginsSettings.logic";
import { reconcileSnoozeDraft } from "./SnoozePresetsSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

type Plugins = ReadonlyArray<AgentPlugin>;

function AddPluginForm({
  plugins,
  onAdd,
}: {
  readonly plugins: Plugins;
  readonly onAdd: (plugin: AgentPlugin) => void;
}) {
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const trimmedName = name.trim();
  const nameProblem = trimmedName === "" ? null : pluginNameProblem(trimmedName, plugins);
  const server = parsePluginServer(source);
  const ready = trimmedName !== "" && nameProblem === null && server !== null;

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onAdd({ name: trimmedName, enabled: true, server });
        setName("");
        setSource("");
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          size="sm"
          className="w-full sm:w-40"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="name"
          spellCheck={false}
          aria-label="Plugin name"
          aria-invalid={nameProblem !== null}
        />
        <Input
          size="sm"
          className="w-full min-w-0 flex-1"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder="npx -y some-mcp-server, or https://…/mcp"
          spellCheck={false}
          aria-label="Command or URL"
        />
        <Button type="submit" variant="outline" size="compact" disabled={!ready}>
          <PlusIcon />
          Add
        </Button>
      </div>
      {nameProblem ? <p className="text-xs text-destructive-foreground">{nameProblem}</p> : null}
    </form>
  );
}

/** MCP servers every agent on the environment gets beside T3 Code's own (`agentPlugins`). */
export function PluginsSettingsPanel() {
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["agentPlugins"]);
  const saved = settings.agentPlugins;
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  // Edits build on a local draft, so a second click before the first save echoes back keeps both.
  const [draft, setDraft] = useState<Plugins>(saved);
  const [written, setWritten] = useState<ReadonlyArray<Plugins>>([]);
  // Null forces the next render to adopt the saved value, as after a failed write.
  const [savedSource, setSavedSource] = useState<Plugins | null>(saved);
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
  const save = (agentPlugins: Plugins) => {
    setDraft(agentPlugins);
    setWritten((previous) => [...previous, agentPlugins]);
    updateSettings(
      { agentPlugins },
      {
        onFailed: () => {
          setWritten([]);
          setSavedSource(null);
        },
      },
    );
  };
  const add = (plugin: AgentPlugin) =>
    save([...draft.filter((entry) => entry.name !== plugin.name), plugin]);

  if (isProjectScope) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Plugins apply to every project on an environment. Select an environment to change them.
        </p>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection id="plugins" title="Plugins">
        <SettingsRow
          serverScoped
          settingKeys={["agentPlugins"]}
          mixed={mixed}
          {...searchableSetting("agent-plugins")}
          description="Every agent on this environment gets the tools of the plugins turned on here. Muse gets URL plugins only; OpenCode and Pi get none yet. A thread picks up a change when its agent next starts."
          status={
            mixed
              ? "Environments have different plugins. A change here replaces all of them."
              : null
          }
        >
          <div className="flex flex-col gap-3 pt-3 pb-2">
            {draft.length > 0 ? (
              <ul
                aria-label="Plugins"
                className="divide-y divide-border/60 rounded-lg border border-border/60"
              >
                {draft.map((plugin) => (
                  <li key={plugin.name} className="flex items-center gap-3 py-1.5 ps-3 pe-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-foreground">{plugin.name}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {describePluginServer(plugin.server)}
                      </p>
                    </div>
                    <Switch
                      size="sm"
                      checked={plugin.enabled}
                      onCheckedChange={(enabled) =>
                        save(
                          draft.map((entry) =>
                            entry.name === plugin.name ? { ...entry, enabled } : entry,
                          ),
                        )
                      }
                      aria-label={`Turn on ${plugin.name}`}
                    />
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Remove ${plugin.name}`}
                      onClick={() => save(draft.filter((entry) => entry.name !== plugin.name))}
                    >
                      <XIcon />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                No plugins. Add one from the store below, or add any MCP server by its command or
                URL.
              </p>
            )}
            <AddPluginForm plugins={draft} onAdd={add} />
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="plugin-store" title="Plugin store">
        {PLUGIN_STORE.map((entry) => {
          const added = draft.some((plugin) => plugin.name === entry.plugin.name);
          return (
            <SettingsRow
              key={entry.plugin.name}
              serverScoped
              settingKeys={["agentPlugins"]}
              title={entry.title}
              description={entry.description}
              control={
                <div className="flex items-center gap-1">
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`About ${entry.title}`}
                    render={<a href={entry.docs} target="_blank" rel="noreferrer" />}
                  >
                    <ExternalLinkIcon />
                  </Button>
                  <Button
                    variant="outline"
                    size="compact"
                    disabled={added}
                    onClick={() => add(entry.plugin)}
                  >
                    {added ? "Added" : "Add"}
                  </Button>
                </div>
              }
            />
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
