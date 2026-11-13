import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { modelSelectionCommandType } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const FALLBACK_CONTINUE_TEXT =
  "The previous agent stopped on a usage limit. Continue where it left off.";

/**
 * The entry after the thread's current agent, so a chain of limited agents walks the list once
 * instead of looping. An agent not in the list starts at the first entry that is not itself.
 */
export function nextUsageLimitFallback(
  current: ModelSelection,
  fallbacks: ReadonlyArray<ModelSelection>,
): ModelSelection | null {
  const position = fallbacks.findIndex((entry) => entry.instanceId === current.instanceId);
  const rest = position === -1 ? fallbacks : fallbacks.slice(position + 1);
  return rest.find((entry) => entry.instanceId !== current.instanceId) ?? null;
}

export function usageLimitFallbackCommands(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "id"
    | "status"
    | "lastErrorClass"
    | "latestRunId"
    | "archivedAt"
    | "deletedAt"
    | "pendingRuntimeRequest"
    | "modelSelection"
  >,
  fallbacks: ReadonlyArray<ModelSelection>,
): ReadonlyArray<OrchestrationV2Command> | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    thread.latestRunId === null ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const next = nextUsageLimitFallback(thread.modelSelection, fallbacks);
  if (next === null) return null;
  const identity = `${thread.id}:${thread.latestRunId}`;
  return [
    {
      type: modelSelectionCommandType(thread.modelSelection.instanceId, next),
      commandId: CommandId.make(`limit-fallback-switch:${identity}`),
      threadId: thread.id,
      modelSelection: next,
    },
    {
      type: "message.dispatch",
      commandId: CommandId.make(`limit-fallback-continue:${identity}`),
      messageId: MessageId.make(`limit-fallback-continue:${identity}`),
      threadId: thread.id,
      text: FALLBACK_CONTINUE_TEXT,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
    },
  ];
}

const limitedThreadId = (event: OrchestrationV2DomainEvent): ThreadId | null =>
  (event.type === "run.updated" && event.payload.status === "failed") ||
  (event.type === "turn-item.updated" && event.payload.type === "error")
    ? event.threadId
    : null;

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;

    const fallBack = Effect.fn("UsageLimitFallbackWorker.fallBack")(function* (threadId: ThreadId) {
      const { usageLimitFallbacks } = yield* settings.getSettings;
      if (usageLimitFallbacks.length === 0) return;
      const thread = yield* threads.getThreadShell(threadId);
      if (thread === null) return;
      const commands = usageLimitFallbackCommands(thread, usageLimitFallbacks);
      if (commands === null) return;
      // Command ids repeat for the same limited run, so a second event cannot switch twice.
      for (const command of commands) yield* threads.dispatch(command);
    });

    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        const threadId = limitedThreadId(event);
        return threadId === null
          ? Effect.void
          : fallBack(threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.limit-fallback.failed", { threadId, cause }),
              ),
            );
      }),
    );
  }),
);
