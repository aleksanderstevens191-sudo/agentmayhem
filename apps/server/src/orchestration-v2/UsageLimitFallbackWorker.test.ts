import { ProviderInstanceId, RunId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { nextUsageLimitFallback, usageLimitFallbackCommands } from "./UsageLimitFallbackWorker.ts";

const selection = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});
const claude = selection("claude", "claude-opus-5-5");
const codexPersonal = selection("codex", "gpt-6.1-sol");
const codexSchool = selection("codex-school", "gpt-6.1-sol");
const fallbacks = [claude, codexPersonal, codexSchool];

const limited = {
  id: ThreadId.make("thread:limited"),
  status: "failed" as const,
  lastErrorClass: "usage_limit" as const,
  latestRunId: RunId.make("run:1"),
  archivedAt: null,
  deletedAt: null,
  pendingRuntimeRequest: null,
  modelSelection: claude,
};

it("walks the fallback list once, starting after the current agent", () => {
  assert.strictEqual(nextUsageLimitFallback(claude, fallbacks), codexPersonal);
  assert.strictEqual(nextUsageLimitFallback(codexPersonal, fallbacks), codexSchool);
  assert.strictEqual(nextUsageLimitFallback(codexSchool, fallbacks), null);
  assert.strictEqual(nextUsageLimitFallback(selection("grok", "grok-5"), fallbacks), claude);
  assert.strictEqual(nextUsageLimitFallback(claude, [claude]), null);
});

it("switches a usage-limited thread and continues it, once per limited run", () => {
  const commands = usageLimitFallbackCommands(limited, fallbacks);
  assert.deepStrictEqual(
    commands?.map((command) => [command.type, command.commandId]),
    [
      ["provider.switch", "limit-fallback-switch:thread:limited:run:1"],
      ["message.dispatch", "limit-fallback-continue:thread:limited:run:1"],
    ],
  );
  const sameInstance = usageLimitFallbackCommands(limited, [
    claude,
    selection("claude", "claude-sonnet-5-5"),
  ]);
  assert.strictEqual(sameInstance, null);
});

it("leaves threads alone that are not stopped by a usage limit", () => {
  assert.isNull(
    usageLimitFallbackCommands({ ...limited, lastErrorClass: "provider_error" }, fallbacks),
  );
  assert.isNull(usageLimitFallbackCommands({ ...limited, status: "idle" }, fallbacks));
  assert.isNull(usageLimitFallbackCommands(limited, []));
});
