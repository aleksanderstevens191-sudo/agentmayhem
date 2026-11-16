import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2LinkedSender,
  ThreadId,
} from "@t3tools/contracts";
import { t3AgentMessagePrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Effect from "effect/Effect";

type SentMessage = Pick<
  OrchestrationV2ConversationMessage,
  "createdBy" | "senderThreadId" | "linkedSender" | "outsideAgent"
>;

/**
 * The other agent that sent `message` into `thread`: its thread, or an outside agent's name.
 * Undefined for the user, the thread itself, and the parent a delegated thread works for, whose
 * results already reach it.
 */
export function agentMessageSender(
  message: SentMessage,
  thread: Pick<OrchestrationV2AppThread, "id" | "lineage" | "delegatedFrom">,
):
  | { readonly threadId: ThreadId }
  | OrchestrationV2LinkedSender
  | { readonly outsideAgent: string }
  | undefined {
  if (message.createdBy !== "agent") return undefined;
  if (message.outsideAgent) return { outsideAgent: message.outsideAgent };
  const linked = message.linkedSender;
  if (linked !== undefined) {
    const parent = thread.delegatedFrom;
    return parent?.environmentId === linked.environmentId && parent.threadId === linked.threadId
      ? undefined
      : linked;
  }
  const sender = message.senderThreadId;
  if (sender === undefined || sender === thread.id) return undefined;
  return thread.lineage.relationshipToParent === "subagent" &&
    thread.lineage.parentThreadId === sender
    ? undefined
    : { threadId: sender };
}

/** `text` for the provider, opened with a note naming the other agent that sent `message`. */
export const withAgentMessageSender = Effect.fn("agentMessageSender.withAgentMessageSender")(
  function* <E>(input: {
    readonly text: string;
    readonly message: SentMessage;
    readonly thread: Effect.Effect<OrchestrationV2AppThread, E>;
    readonly getThread: (threadId: ThreadId) => Effect.Effect<OrchestrationV2AppThread, E>;
  }) {
    if (input.message.createdBy !== "agent") return input.text;
    // The note only helps the receiver; a failed lookup must not stop delivery.
    const thread = yield* Effect.option(input.thread);
    if (thread._tag === "None") return input.text;
    const sender = agentMessageSender(input.message, thread.value);
    if (sender === undefined) return input.text;
    if (!("threadId" in sender) || "title" in sender) {
      return t3AgentMessagePrompt(input.text, sender);
    }
    const title = yield* input.getThread(sender.threadId).pipe(
      Effect.map((found) => found.title),
      Effect.orElseSucceed(() => undefined),
    );
    return t3AgentMessagePrompt(input.text, { threadId: sender.threadId, title });
  },
);
