import type { AgentPlugin } from "@t3tools/contracts";

export interface PluginStoreEntry {
  readonly title: string;
  readonly description: string;
  readonly plugin: AgentPlugin;
  readonly docs: string;
}

/** Plugins a user can add in one click. Each needs no sign-in, so it works for every agent. */
export const PLUGIN_STORE: ReadonlyArray<PluginStoreEntry> = [
  {
    title: "Computer control (Mac)",
    description:
      "Agents can see the screen, click, type, and use any app, with Peekaboo. Needs Node 22. macOS asks you to allow Screen Recording and Accessibility for the app that runs T3 Code.",
    plugin: {
      name: "computer-control",
      enabled: true,
      server: { type: "stdio", command: "npx", args: ["-y", "@steipete/peekaboo", "mcp"] },
    },
    docs: "https://github.com/openclaw/Peekaboo/blob/main/docs/MCP.md",
  },
  {
    title: "Library docs (Context7)",
    description: "Agents can look up current documentation and examples for code libraries.",
    plugin: {
      name: "context7",
      enabled: true,
      server: { type: "http", url: "https://mcp.context7.com/mcp" },
    },
    docs: "https://github.com/upstash/context7",
  },
];
