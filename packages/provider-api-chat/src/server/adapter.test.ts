import { assert, describe, it } from "@effect/vitest";
import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as EffectAcpErrors from "effect-acp/errors";

import { apiChatAttachmentBlocks, apiChatPromptFailure } from "./adapter.ts";

const encoder = new TextEncoder();
const savedFiles = new Map<string, Uint8Array>([
  ["/attachments/screen.png", new Uint8Array([137, 80, 78, 71])],
  ["/attachments/notes.md", encoder.encode("# Plan\nShip normal chat.")],
  ["/attachments/report.docx", new Uint8Array([80, 75, 3, 4, 0, 0])],
  ["/attachments/report.docx.txt", encoder.encode("Quarterly report text.")],
  ["/attachments/archive.zip", new Uint8Array([80, 75, 3, 4, 0, 0])],
]);
const savedFileLayer = Layer.merge(
  FileSystem.layerNoop({
    readFile: (path) => Effect.succeed(savedFiles.get(path) ?? new Uint8Array()),
  }),
  Path.layer,
);
const attachment = (name: string, mimeType: string) =>
  ({
    type: mimeType.startsWith("image/") ? "image" : "file",
    id: "thread-00000000-0000-4000-8000-000000000001",
    name,
    mimeType,
    sizeBytes: 1,
  }) as ChatAttachment;

describe("apiChatAttachmentBlocks", () => {
  it.effect("puts images and readable text in the prompt, since the model can't open files", () =>
    Effect.gen(function* () {
      const blocks = yield* apiChatAttachmentBlocks({
        attachments: [
          attachment("screen.png", "image/png"),
          attachment("notes.md", "text/markdown"),
          attachment("report.docx", "application/vnd.openxmlformats"),
          attachment("archive.zip", "application/zip"),
        ],
        resolveAttachmentPath: (entry) => `/attachments/${entry.name}`,
        resolveExtractedTextPath: (path) =>
          Effect.succeed(path.endsWith(".docx") ? `${path}.txt` : undefined),
      });
      assert.deepEqual(blocks, [
        { type: "image", mimeType: "image/png", data: "iVBORw==" },
        {
          type: "resource",
          resource: {
            uri: "file:///attachments/notes.md",
            mimeType: "text/plain",
            text: "# Plan\nShip normal chat.",
          },
        },
        {
          type: "resource",
          resource: {
            uri: "file:///attachments/report.docx",
            mimeType: "text/plain",
            text: "Quarterly report text.",
          },
        },
      ]);
    }).pipe(Effect.provide(savedFileLayer)),
  );
});

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
