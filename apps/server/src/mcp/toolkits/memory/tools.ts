import {
  MemoryEntry,
  MemoryForgetInput,
  MemoryForgetResult,
  MemorySaveInput,
  MemorySearchInput,
  MemorySearchResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];

const MemorySaveTool = Tool.make("memory_save", {
  description:
    "Save a durable fact about the user, their preferences, or this project so every model and agent can recall it later. One fact per call. Not for secrets or anything said only for this task.",
  parameters: MemorySaveInput,
  success: MemoryEntry,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Save a memory")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const MemorySearchTool = Tool.make("memory_search", {
  description:
    "Recall memories shared by every model and agent: global ones plus this project's. Newest first. Call it when starting work that may depend on the user's preferences or earlier context.",
  parameters: MemorySearchInput,
  success: MemorySearchResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Search memories")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const MemoryForgetTool = Tool.make("memory_forget", {
  description: "Delete one memory by `id`, when it is wrong or the user asks to forget it.",
  parameters: MemoryForgetInput,
  success: MemoryForgetResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Forget a memory")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const MemoryToolkit = Toolkit.make(MemorySaveTool, MemorySearchTool, MemoryForgetTool);
