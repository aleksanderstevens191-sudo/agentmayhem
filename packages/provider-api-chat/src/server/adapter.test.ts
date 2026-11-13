import { assert, describe, it } from "@effect/vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import { apiChatPromptFailure } from "./adapter.ts";

describe("apiChatPromptFailure", () => {
  it("makes the agent's rate-limit answer a usage limit, so fallback agents take over", () => {
    const limited = apiChatPromptFailure(
      new EffectAcpErrors.AcpRequestError({
        code: -32029,
        errorMessage: "Anthropic is rate-limiting requests or your quota ran out.",
        data: { resetAt: "2026-11-13T23:00:00.000Z" },
      }),
    );
    assert.strictEqual(limited.class, "usage_limit");
    assert.strictEqual(
      limited.message,
      "Anthropic is rate-limiting requests or your quota ran out.",
    );
    assert.strictEqual(limited.resetAt, "2026-11-13T23:00:00.000Z");

    const failed = apiChatPromptFailure(
      new EffectAcpErrors.AcpRequestError({
        code: -32000,
        errorMessage: "Anthropic rejected the API key.",
      }),
    );
    assert.strictEqual(failed.class, "provider_error");
    assert.strictEqual(failed.message, "Anthropic rejected the API key.");
  });
});
