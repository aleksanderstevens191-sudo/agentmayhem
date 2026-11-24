import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";

/** Agent apps that cannot be driven from here but connect to it over MCP. */
export const OUTSIDE_AGENT_APPS = ["Grok Bot", "Muse", "Claude Duet"] as const;

export type AgentReadiness = "ready" | "setup" | "off";

export function resolveAgentReadiness(
  provider: Pick<ServerProvider, "enabled" | "installed" | "status" | "auth">,
): AgentReadiness {
  if (!provider.enabled || provider.status === "disabled") return "off";
  if (
    !provider.installed ||
    provider.status === "error" ||
    provider.auth.status === "unauthenticated"
  ) {
    return "setup";
  }
  return "ready";
}

/** Ready agents first, then those that need setup; turned-off ones are left out. */
export function sortProjectAgents<
  T extends Pick<ServerProvider, "enabled" | "installed" | "status" | "auth">,
>(providers: ReadonlyArray<T>): T[] {
  const rank: Record<AgentReadiness, number> = { ready: 0, setup: 1, off: 2 };
  return providers
    .filter((provider) => resolveAgentReadiness(provider) !== "off")
    .toSorted((a, b) => rank[resolveAgentReadiness(a)] - rank[resolveAgentReadiness(b)]);
}

/** The project's live threads, newest activity first. */
export function selectProjectThreads<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly projectId: string;
    readonly archivedAt: string | null;
    readonly updatedAt: string;
  },
>(
  memberProjectRefs: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: string;
  }>,
  threads: ReadonlyArray<T>,
): T[] {
  const members = new Set(memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`));
  return threads
    .filter(
      (thread) =>
        thread.archivedAt === null && members.has(`${thread.environmentId}:${thread.projectId}`),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
