import { describe, expect, it } from "vite-plus/test";

import {
  describePluginServer,
  parsePluginServer,
  pluginNameProblem,
} from "./PluginsSettings.logic";

describe("parsePluginServer", () => {
  it.each([
    ["https://mcp.context7.com/mcp", { type: "http", url: "https://mcp.context7.com/mcp" }],
    [
      "  npx -y @steipete/peekaboo mcp ",
      { type: "stdio", command: "npx", args: ["-y", "@steipete/peekaboo", "mcp"] },
    ],
    [
      `"/Applications/My Tool/bin/tool" --root '/Users/a b' ""`,
      {
        type: "stdio",
        command: "/Applications/My Tool/bin/tool",
        args: ["--root", "/Users/a b", ""],
      },
    ],
    ["   ", null],
  ])("reads %j", (input, expected) => {
    const server = parsePluginServer(input);
    expect(server).toEqual(expected);
    // What the list shows reads back as the same server.
    if (server !== null) expect(parsePluginServer(describePluginServer(server))).toEqual(server);
  });
});

describe("pluginNameProblem", () => {
  const taken = [
    {
      name: "computer-control",
      enabled: true,
      server: { type: "http", url: "https://x.test/mcp" },
    } as const,
  ];
  it.each([
    ["docs", null],
    ["computer-control", "A plugin already has this name."],
    ["t3-tools", "Use lowercase letters, numbers, and dashes, up to 40, not starting with t3."],
    ["My Tool", "Use lowercase letters, numbers, and dashes, up to 40, not starting with t3."],
  ])("%s", (name, problem) => {
    expect(pluginNameProblem(name, taken)).toBe(problem);
  });
});
