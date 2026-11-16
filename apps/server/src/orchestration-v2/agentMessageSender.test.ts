import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { agentMessageSender } from "./agentMessageSender.ts";

const here = ThreadId.make("thread-here");
const parent = ThreadId.make("thread-parent");
const other = ThreadId.make("thread-other");
const remote = {
  environmentId: EnvironmentId.make("env-remote"),
  threadId: other,
  title: "Remote",
};

const topLevel = {
  id: here,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: here },
};
const delegated = {
  id: here,
  lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
} as const;

describe("agentMessageSender", () => {
  it("names another agent's thread, but not the user, itself, or the parent it works for", () => {
    const fromAgent = (senderThreadId: ThreadId) =>
      ({ createdBy: "agent", senderThreadId }) as const;
    assert.deepEqual(agentMessageSender(fromAgent(other), topLevel), { threadId: other });
    assert.deepEqual(agentMessageSender(fromAgent(other), delegated), { threadId: other });
    assert.deepEqual(agentMessageSender(fromAgent(parent), topLevel), { threadId: parent });
    assert.isUndefined(agentMessageSender(fromAgent(parent), delegated));
    assert.isUndefined(agentMessageSender(fromAgent(here), topLevel));
    assert.isUndefined(agentMessageSender({ createdBy: "user", senderThreadId: other }, topLevel));
  });

  it("names a linked machine's agent unless this thread works for it, and an outside agent", () => {
    const linked = { createdBy: "agent", linkedSender: remote } as const;
    assert.deepEqual(agentMessageSender(linked, topLevel), remote);
    assert.isUndefined(
      agentMessageSender(linked, {
        ...topLevel,
        delegatedFrom: { environmentId: remote.environmentId, threadId: other, title: "Remote" },
      }),
    );
    assert.deepEqual(
      agentMessageSender({ createdBy: "agent", outsideAgent: "Grok Bot" }, topLevel),
      { outsideAgent: "Grok Bot" },
    );
  });
});
