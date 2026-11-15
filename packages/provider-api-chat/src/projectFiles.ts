// @effect-diagnostics nodeBuiltinImport:off -- Runs in the plain Node agent process.
/**
 * What the API chat model knows about the thread's project: its instructions file, and
 * read-only tools over its folder, since the model cannot open files itself.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { McpToolResult } from "./mcp.ts";
import type { ChatTool } from "./services.ts";

// Large files would crowd the conversation out of the model's context.
const MAX_FILE_CHARS = 100_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_INSTRUCTIONS_CHARS = 50_000;
// The files coding agents read, so every agent in a project follows the same instructions.
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The text of a file, or undefined when it is not UTF-8 text. */
export function readableText(bytes: Uint8Array): string | undefined {
  try {
    const text = utf8.decode(bytes);
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

const cut = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}\n[Cut at ${limit} characters]` : text;

export const PROJECT_FILE_TOOLS: ReadonlyArray<ChatTool> = [
  {
    name: "list_files",
    description: "List the files and folders in a folder of the user's project. Folders end in /.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "A folder relative to the project folder. Leave it out for the project folder.",
        },
      },
    },
  },
  {
    name: "read_file",
    description: "Read a text file in the user's project.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file's path relative to the project folder." },
      },
      required: ["path"],
    },
  },
];

const leaves = (root: string, target: string) => {
  const fromRoot = NodePath.relative(root, target);
  return (
    fromRoot === ".." || fromRoot.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(fromRoot)
  );
};

/** The real path of `relative` inside `root`, or undefined when it leads out, links included. */
async function insideProject(root: string, relative: unknown): Promise<string | undefined> {
  const asked = NodePath.resolve(root, typeof relative === "string" && relative ? relative : ".");
  // Checked before touching the disk, so the answer says nothing about files outside.
  if (leaves(root, asked)) return undefined;
  const realRoot = await NodeFSP.realpath(root);
  const target = await NodeFSP.realpath(asked);
  return leaves(realRoot, target) ? undefined : target;
}

/** Runs a project file tool, or answers undefined for any other tool name. */
export async function callProjectFileTool(
  root: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult | undefined> {
  if (name !== "list_files" && name !== "read_file") return undefined;
  const shown = typeof args.path === "string" && args.path ? args.path : ".";
  try {
    const target = await insideProject(root, args.path);
    if (target === undefined) return { text: `${shown} is outside the project.`, isError: true };
    if (name === "list_files") {
      const entries = (await NodeFSP.readdir(target, { withFileTypes: true }))
        .filter((entry) => entry.name !== ".git")
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .toSorted();
      if (entries.length === 0) return { text: "(empty folder)", isError: false };
      const listed = entries.slice(0, MAX_LIST_ENTRIES).join("\n");
      return {
        text:
          entries.length > MAX_LIST_ENTRIES
            ? `${listed}\n[${entries.length - MAX_LIST_ENTRIES} more not shown]`
            : listed,
        isError: false,
      };
    }
    const info = await NodeFSP.stat(target);
    if (!info.isFile()) return { text: `${shown} is not a file.`, isError: true };
    if (info.size > MAX_FILE_BYTES) {
      return { text: `${shown} is too large to read here.`, isError: true };
    }
    const text = readableText(await NodeFSP.readFile(target));
    return text === undefined
      ? { text: `${shown} is not a text file, so it can't be read here.`, isError: true }
      : { text: cut(text, MAX_FILE_CHARS), isError: false };
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "it does not exist"
        : error instanceof Error
          ? error.message
          : String(error);
    return { text: `Could not open ${shown}: ${reason}.`, isError: true };
  }
}

/** The system prompt for a chat in `root`, with the project's instructions file when it has one. */
export async function projectSystemPrompt(root: string): Promise<string> {
  const intro = `The user's project folder is ${root}. Use list_files and read_file to look at its files when they would help.`;
  for (const file of INSTRUCTION_FILES) {
    // Read like read_file, so a linked instructions file can't pull in text from outside.
    const read = await callProjectFileTool(root, "read_file", { path: file });
    const text = read === undefined || read.isError ? "" : read.text.trim();
    if (!text) continue;
    return `${intro}\n\nFollow the project's instructions, from its ${file}:\n\n<project_instructions>\n${cut(text, MAX_INSTRUCTIONS_CHARS)}\n</project_instructions>`;
  }
  return intro;
}
