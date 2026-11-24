import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveAgentReadiness,
  selectProjectThreads,
  sortProjectAgents,
} from "./ProjectsHome.logic";

const env = EnvironmentId.make("env-1");
const other = EnvironmentId.make("env-2");

const provider = (
  name: string,
  overrides: Partial<Parameters<typeof resolveAgentReadiness>[0]> = {},
) => ({
  name,
  enabled: true,
  installed: true,
  status: "ready" as const,
  auth: { status: "authenticated" as const },
  ...overrides,
});

describe("resolveAgentReadiness", () => {
  it.each([
    ["ready", provider("a"), "ready"],
    ["turned off", provider("a", { enabled: false }), "off"],
    ["not installed", provider("a", { installed: false }), "setup"],
    ["signed out", provider("a", { auth: { status: "unauthenticated" } }), "setup"],
    ["failed probe", provider("a", { status: "error" }), "setup"],
  ])("%s", (_label, input, expected) => {
    expect(resolveAgentReadiness(input)).toBe(expected);
  });
});

describe("sortProjectAgents", () => {
  it("lists ready agents before ones needing setup and drops turned-off ones", () => {
    const sorted = sortProjectAgents([
      provider("codex", { status: "error" }),
      provider("off", { enabled: false }),
      provider("claude"),
    ]);
    expect(sorted.map((p) => p.name)).toEqual(["claude", "codex"]);
  });
});

describe("selectProjectThreads", () => {
  it("keeps the project's unarchived threads, newest first", () => {
    const thread = (
      id: string,
      projectId: string,
      updatedAt: string,
      archivedAt: string | null = null,
    ) => ({
      id,
      environmentId: env,
      projectId,
      updatedAt,
      archivedAt,
    });
    const threads = [
      thread("old", "p1", "2026-11-01T00:00:00.000Z"),
      thread("archived", "p1", "2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z"),
      thread("elsewhere", "p2", "2026-11-05T00:00:00.000Z"),
      thread("new", "p1", "2026-11-02T00:00:00.000Z"),
      { ...thread("other-env", "p1", "2026-11-06T00:00:00.000Z"), environmentId: other },
    ];
    expect(
      selectProjectThreads([{ environmentId: env, projectId: "p1" }], threads).map((t) => t.id),
    ).toEqual(["new", "old"]);
  });
});
