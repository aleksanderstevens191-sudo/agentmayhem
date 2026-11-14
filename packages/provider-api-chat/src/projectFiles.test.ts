// @effect-diagnostics nodeBuiltinImport:off -- Builds a project folder on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { callProjectFileTool, projectSystemPrompt } from "./projectFiles.ts";

async function withProject(use: (root: string, outside: string) => Promise<void>) {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "api-chat-project-"));
  const root = NodePath.join(base, "project");
  const outside = NodePath.join(base, "outside");
  await NodeFSP.mkdir(NodePath.join(root, "notes"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(root, ".git"));
  await NodeFSP.mkdir(outside);
  await NodeFSP.writeFile(NodePath.join(root, "notes", "plan.md"), "Ship Projects.");
  await NodeFSP.writeFile(NodePath.join(root, "photo.png"), new Uint8Array([137, 80, 0, 71]));
  await NodeFSP.writeFile(NodePath.join(outside, "secret.txt"), "Not yours.");
  await NodeFSP.symlink(NodePath.join(outside, "secret.txt"), NodePath.join(root, "link.txt"));
  try {
    await use(root, outside);
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
}

describe("callProjectFileTool", () => {
  it("reads text inside the project and nothing outside it, links included", () =>
    withProject(async (root) => {
      const call = (name: string, path?: string) =>
        callProjectFileTool(root, name, path === undefined ? {} : { path });
      assert.deepEqual(await call("list_files"), {
        text: "link.txt\nnotes/\nphoto.png",
        isError: false,
      });
      assert.deepEqual(await call("read_file", "notes/plan.md"), {
        text: "Ship Projects.",
        isError: false,
      });
      assert.deepEqual(await call("read_file", "../outside/secret.txt"), {
        text: "../outside/secret.txt is outside the project.",
        isError: true,
      });
      assert.deepEqual(await call("read_file", "../outside/missing.txt"), {
        text: "../outside/missing.txt is outside the project.",
        isError: true,
      });
      assert.deepEqual(await call("read_file", "link.txt"), {
        text: "link.txt is outside the project.",
        isError: true,
      });
      assert.isTrue((await call("read_file", "photo.png"))?.isError);
      assert.isTrue((await call("read_file", "missing.md"))?.isError);
      assert.isUndefined(await call("memory_search"));
    }));
});

describe("projectSystemPrompt", () => {
  it("carries AGENTS.md, or CLAUDE.md when AGENTS.md is missing or leads outside", () =>
    withProject(async (root) => {
      assert.notInclude(await projectSystemPrompt(root), "project_instructions");
      await NodeFSP.writeFile(NodePath.join(root, "CLAUDE.md"), "Use British spelling.");
      assert.include(
        await projectSystemPrompt(root),
        "from its CLAUDE.md:\n\n<project_instructions>\nUse British spelling.\n</project_instructions>",
      );
      await NodeFSP.symlink(NodePath.join(root, "link.txt"), NodePath.join(root, "AGENTS.md"));
      const linkedOut = await projectSystemPrompt(root);
      assert.notInclude(linkedOut, "Not yours.");
      assert.include(linkedOut, "from its CLAUDE.md");
      await NodeFSP.rm(NodePath.join(root, "AGENTS.md"));
      await NodeFSP.writeFile(NodePath.join(root, "AGENTS.md"), "Answer in French.");
      assert.include(await projectSystemPrompt(root), "from its AGENTS.md");
    }));
});
