import { type AgentPlugin, AgentPluginName, type AgentPluginServer } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isPluginName = Schema.is(AgentPluginName);

/** A URL is a remote server; anything else is a command line, split on spaces outside quotes. */
export function parsePluginServer(input: string): AgentPluginServer | null {
  const text = input.trim();
  if (/^https?:\/\/\S+$/i.test(text)) return { type: "http", url: text };
  const words = [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
  const [command, ...args] = words;
  return command ? { type: "stdio", command, args } : null;
}

export function describePluginServer(server: AgentPluginServer): string {
  if (server.type === "http") return server.url;
  return [server.command, ...server.args]
    .map((word) => (word === "" || /\s/.test(word) ? `"${word}"` : word))
    .join(" ");
}

export function pluginNameProblem(
  name: string,
  plugins: ReadonlyArray<AgentPlugin>,
): string | null {
  if (!isPluginName(name)) {
    return "Use lowercase letters, numbers, and dashes, up to 40, not starting with t3.";
  }
  return plugins.some((plugin) => plugin.name === name) ? "A plugin already has this name." : null;
}
