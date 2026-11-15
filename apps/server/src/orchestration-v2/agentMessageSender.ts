import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2LinkedSender,
  ThreadId,
} from "@t3tools/contracts";

/**
 * The other agent's thread that sent `message` into `thread`. Undefined for the user, the thread
 * itself, and the parent a delegated thread works for, whose results already reach it.
 */
export function agentMessageSender(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "senderThreadId" | "linkedSender"
  >,
  thread: Pick<OrchestrationV2AppThread, "id" | "lineage" | "delegatedFrom">,
): { readonly threadId: ThreadId } | OrchestrationV2LinkedSender | undefined {
  if (message.createdBy !== "agent") return undefined;
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
