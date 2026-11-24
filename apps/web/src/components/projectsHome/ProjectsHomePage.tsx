import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { FileIcon, FolderIcon, PlugIcon, SettingsIcon, SquarePenIcon } from "lucide-react";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { cn } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironmentProviders } from "../../state/environments";
import { useQuietThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { useProjectEntriesQuery } from "../files/projectFilesQueryState";
import { openUseInAnotherApp } from "../mcp/UseInAnotherAppDialog";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProjectInstructionsSettings } from "../settings/ProjectInstructionsSettings";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  OUTSIDE_AGENT_APPS,
  resolveAgentReadiness,
  selectProjectThreads,
  sortProjectAgents,
} from "./ProjectsHome.logic";

const MAX_FILES = 40;

export function ProjectsHomePage({ selectedKey }: { readonly selectedKey: string | undefined }) {
  const navigate = useNavigate();
  const groups = useSidebarProjectGroups().filter((group) => !group.archived);
  const threads = useQuietThreadShells();
  const selected = groups.find((group) => group.projectKey === selectedKey) ?? groups[0] ?? null;

  return (
    <AppRouteModal label="Projects">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-1 border-b ps-5 pe-2">
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Projects</h1>
          <AppRouteModalClose />
        </header>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav
            aria-label="Projects"
            className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-60 sm:flex-col sm:overflow-y-auto sm:border-e sm:border-b-0"
          >
            {groups.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">
                Add a project from the sidebar to see it here.
              </p>
            ) : null}
            {groups.map((group) => {
              const count = selectProjectThreads(group.memberProjectRefs, threads).length;
              const active = group.projectKey === selected?.projectKey;
              return (
                <button
                  key={group.projectKey}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() =>
                    void navigate({
                      to: "/overview",
                      search: { project: group.projectKey },
                      replace: true,
                    })
                  }
                  className={cn(
                    "flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    active && "bg-accent font-medium",
                  )}
                >
                  <ProjectFavicon project={group} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
                  {count > 0 ? (
                    <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
                  ) : null}
                </button>
              );
            })}
          </nav>
          <ScrollArea className="min-h-0 flex-1">
            {selected ? (
              <ProjectDetail key={selected.projectKey} group={selected} threads={threads} />
            ) : null}
          </ScrollArea>
        </div>
      </div>
    </AppRouteModal>
  );
}

function ProjectDetail({
  group,
  threads,
}: {
  readonly group: SidebarProjectSnapshot;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const projectThreads = selectProjectThreads(group.memberProjectRefs, threads);
  const working = projectThreads.filter(
    (thread) => resolveThreadStatusPill({ thread })?.label === "Working",
  ).length;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-5 pt-6 pb-12 sm:px-8">
      <div className="flex flex-wrap items-start gap-3">
        <ProjectFavicon project={group} className="mt-1 size-6 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold">{group.displayName}</h2>
          <p className="truncate text-xs text-muted-foreground">{group.workspaceRoot}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void navigate({
                to: "/projects/$projectKey",
                params: { projectKey: group.projectKey },
              })
            }
          >
            <SettingsIcon aria-hidden />
            Settings
          </Button>
          <Button
            size="sm"
            onClick={() => void handleNewThread(scopeProjectRef(group.environmentId, group.id))}
          >
            <SquarePenIcon aria-hidden />
            New thread
          </Button>
        </div>
      </div>

      <Section
        title="Threads"
        detail={
          working > 0
            ? `${working} working now · ${projectThreads.length} total`
            : `${projectThreads.length} total`
        }
      >
        {projectThreads.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No threads yet. Start one, or start several to run them side by side.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {projectThreads.map((thread) => (
              <ThreadRow key={`${thread.environmentId}:${thread.id}`} thread={thread} />
            ))}
          </ul>
        )}
      </Section>

      <ProjectInstructionsSettings environmentId={group.environmentId} cwd={group.workspaceRoot} />

      <AgentsSection group={group} />

      <FilesSection group={group} />
    </div>
  );
}

function Section({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
      </div>
      {children}
    </section>
  );
}

function ThreadRow({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const navigate = useNavigate();
  const pill = resolveThreadStatusPill({ thread });
  return (
    <li>
      <button
        type="button"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
          })
        }
        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 truncate">{thread.title || "Untitled thread"}</span>
        {pill ? (
          <span className={cn("flex shrink-0 items-center gap-1.5 text-xs", pill.colorClass)}>
            <span className={cn("size-1.5 rounded-full", pill.dotClass)} />
            {pill.label}
          </span>
        ) : null}
        <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
          {formatRelativeTimeLabel(thread.updatedAt)}
        </span>
      </button>
    </li>
  );
}

function AgentsSection({ group }: { readonly group: SidebarProjectSnapshot }) {
  const navigate = useNavigate();
  const providers = sortProjectAgents(useEnvironmentProviders().get(group.environmentId) ?? []);
  return (
    <Section title="Agents" detail="Pick one from the model menu when you start a thread.">
      <ul className="divide-y rounded-lg border">
        {providers.map((provider) => {
          const name = resolveProviderInstanceDisplayName(provider);
          const ready = resolveAgentReadiness(provider) === "ready";
          return (
            <li key={provider.instanceId} className="flex items-center gap-3 px-3 py-2 text-sm">
              <ProviderInstanceIcon
                driverKind={provider.driver}
                displayName={name}
                iconClassName="size-4"
              />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              {ready ? (
                <span className="text-xs text-success-foreground">Ready</span>
              ) : (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() =>
                    void navigate({
                      to: "/settings/providers",
                      search: {
                        environmentId: group.environmentId,
                        instanceId: provider.instanceId,
                      },
                    })
                  }
                >
                  Set up
                </Button>
              )}
            </li>
          );
        })}
        <li className="flex items-center gap-3 px-3 py-2 text-sm">
          <PlugIcon aria-hidden className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {OUTSIDE_AGENT_APPS.join(", ")}
            <span className="block text-xs text-muted-foreground">
              These apps connect to AgentMayhem and can read, start and message its threads.
            </span>
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => openUseInAnotherApp(group.environmentId)}
          >
            Connect
          </Button>
        </li>
        <li className="flex items-center gap-3 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 text-muted-foreground">
            More agents, such as Grok Build or Muse Code
          </span>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() =>
              void navigate({
                to: "/settings/providers",
                search: { environmentId: group.environmentId },
              })
            }
          >
            Add agent
          </Button>
        </li>
      </ul>
    </Section>
  );
}

function FilesSection({ group }: { readonly group: SidebarProjectSnapshot }) {
  const entries = useProjectEntriesQuery(group.environmentId, group.workspaceRoot);
  const topLevel = (entries.data?.entries ?? [])
    .filter((entry) => !entry.ignored && !entry.path.includes("/"))
    .toSorted((a, b) =>
      a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "directory" ? -1 : 1,
    );
  return (
    <Section title="Files" detail="What agents in this project can see.">
      {entries.error ? (
        <p className="text-sm text-muted-foreground">{entries.error}</p>
      ) : topLevel.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {entries.isPending ? "Loading files…" : "This project folder is empty."}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-lg border p-3 text-sm sm:grid-cols-2">
          {topLevel.slice(0, MAX_FILES).map((entry) => (
            <li key={entry.path} className="flex min-w-0 items-center gap-2">
              {entry.kind === "directory" ? (
                <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{entry.path}</span>
            </li>
          ))}
          {topLevel.length > MAX_FILES ? (
            <li className="text-xs text-muted-foreground">
              and {topLevel.length - MAX_FILES} more
            </li>
          ) : null}
        </ul>
      )}
    </Section>
  );
}
