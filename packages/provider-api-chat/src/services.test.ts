import { assert, describe, it } from "@effect/vitest";

import {
  ApiChatError,
  type ChatTurn,
  describeFailure,
  listApiChatModels,
  makeReplyReader,
  replyRequestBody,
  serverSentData,
} from "./services.ts";

const encoder = new TextEncoder();

function streamOf(chunks: ReadonlyArray<string>) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function readAll(
  format: "anthropic" | "openai",
  events: ReadonlyArray<unknown>,
  deltas: Array<string> = [],
) {
  const reader = makeReplyReader({ format, label: "Test" }, (delta) =>
    deltas.push(`${delta.kind}:${delta.text}`),
  );
  for (const event of events) reader.read(JSON.stringify(event));
  return reader.result();
}

const TOOL_TURNS: ReadonlyArray<ChatTurn> = [
  { role: "user", content: [{ type: "text", text: "What do you remember?" }] },
  {
    role: "assistant",
    text: "Checking.",
    toolCalls: [
      {
        id: "call_1",
        name: "memory_search",
        arguments: '{"query":"plans"}',
        extra: { extra_content: { google: { thought_signature: "sig" } } },
      },
    ],
  },
  { role: "tool", toolCallId: "call_1", text: "Ship normal chat." },
  { role: "user", content: [{ type: "text", text: "Thanks" }] },
];

describe("serverSentData", () => {
  it("yields each event's data across chunk and CRLF boundaries", async () => {
    const data: Array<string> = [];
    for await (const entry of serverSentData(
      streamOf(['event: x\r\ndata: {"a"', ":1}\r\n\r\n: ping\n\ndata: [DONE]"]),
    )) {
      data.push(entry);
    }
    assert.deepEqual(data, ['{"a":1}', "[DONE]"]);
  });
});

describe("makeReplyReader", () => {
  it("assembles Anthropic text, thinking and a streamed tool call", () => {
    const deltas: Array<string> = [];
    const reply = readAll(
      "anthropic",
      [
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Hm" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Let me look." },
        },
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "toolu_1", name: "memory_search", input: {} },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"query":' },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '"plans"}' },
        },
        { type: "message_delta", delta: { stop_reason: "tool_use" } },
      ],
      deltas,
    );
    assert.deepEqual(deltas, ["thought:Hm", "text:Let me look."]);
    assert.deepEqual(reply, {
      stopReason: "tool_use",
      text: "Let me look.",
      toolCalls: [{ id: "toolu_1", name: "memory_search", arguments: '{"query":"plans"}' }],
    });
  });

  it("assembles OpenAI tool calls, keeps Gemini's signature, and calls with a stop finish", () => {
    const reply = readAll("openai", [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "memory_search", arguments: '{"query"' },
                  extra_content: { google: { thought_signature: "sig" } },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"plans"}' } }] } }],
      },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    assert.deepEqual(reply, {
      stopReason: "tool_use",
      text: "",
      toolCalls: [
        {
          id: "call_1",
          name: "memory_search",
          arguments: '{"query":"plans"}',
          extra: { extra_content: { google: { thought_signature: "sig" } } },
        },
      ],
    });
  });

  it("drops tool calls from a reply cut off at the token cap", () => {
    const reply = readAll("openai", [
      {
        choices: [
          {
            delta: {
              content: "Partial",
              tool_calls: [{ index: 0, id: "c", function: { name: "t", arguments: "{" } }],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ]);
    assert.deepEqual(reply, { stopReason: "max_tokens", text: "Partial", toolCalls: [] });
  });

  it("raises an in-stream rate limit as a usage limit", () => {
    try {
      readAll("anthropic", [
        { type: "error", error: { type: "rate_limit_error", message: "Slow down" } },
      ]);
      assert.fail("expected the stream error to throw");
    } catch (error) {
      assert.instanceOf(error, ApiChatError);
      assert.strictEqual(error.usageLimited, true);
      assert.strictEqual(error.message, "Test stopped the reply: Slow down");
    }
  });
});

describe("describeFailure", () => {
  it("classifies rate limits, exhausted quota and rejected keys", () => {
    const limited = describeFailure("Anthropic", 429, { error: { message: "Too many" } }, "30");
    assert.strictEqual(limited.usageLimited, true);
    assert.isString(limited.resetAt);

    const quota = describeFailure("Gemini", 400, [
      { error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } },
    ]);
    assert.strictEqual(quota.usageLimited, true);
    assert.strictEqual(
      quota.message,
      "Gemini is rate-limiting requests or your quota ran out: Quota exceeded",
    );

    const rejected = describeFailure("OpenAI", 401, { error: { message: "Bad key" } });
    assert.strictEqual(rejected.keyRejected, true);
    assert.strictEqual(rejected.usageLimited, false);
    assert.strictEqual(rejected.message, "OpenAI rejected the API key: Bad key");
  });
});

describe("replyRequestBody", () => {
  const tools = [{ name: "memory_search", description: "Search", inputSchema: { type: "object" } }];

  it("puts Anthropic tool results and the next prompt in one user message", () => {
    const body = replyRequestBody({ format: "anthropic", model: "m", turns: TOOL_TURNS, tools });
    assert.deepEqual(body.messages, [
      { role: "user", content: [{ type: "text", text: "What do you remember?" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "call_1", name: "memory_search", input: { query: "plans" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "Ship normal chat." },
          { type: "text", text: "Thanks" },
        ],
      },
    ]);
    assert.deepEqual(body.tools, [
      { name: "memory_search", description: "Search", input_schema: { type: "object" } },
    ]);
  });

  it("sends OpenAI tool calls back with the fields the service attached", () => {
    const body = replyRequestBody({ format: "openai", model: "m", turns: TOOL_TURNS, tools });
    assert.deepEqual(body.messages, [
      { role: "user", content: "What do you remember?" },
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [
          {
            extra_content: { google: { thought_signature: "sig" } },
            id: "call_1",
            type: "function",
            function: { name: "memory_search", arguments: '{"query":"plans"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "Ship normal chat." },
      { role: "user", content: "Thanks" },
    ]);
  });

  it("writes earlier tool use as text when the session has no tools", () => {
    const body = replyRequestBody({
      format: "anthropic",
      model: "m",
      turns: TOOL_TURNS,
      tools: [],
    });
    assert.isUndefined(body.tools);
    assert.deepEqual(body.messages, [
      { role: "user", content: [{ type: "text", text: "What do you remember?" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: 'Checking.\n\n[Called memory_search with {"query":"plans"}]' },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "[Tool result: Ship normal chat.]" },
          { type: "text", text: "Thanks" },
        ],
      },
    ]);
  });
});

describe("listApiChatModels", () => {
  it("strips Gemini's model prefix, drops non-chat models, and lists dated models newest first", async () => {
    const respond = (data: unknown) => async () => Response.json({ data });
    const gemini = await listApiChatModels(
      { format: "openai", baseUrl: "https://g", apiKey: "k", label: "Gemini" },
      respond([
        { id: "models/gemini-3-pro", display_name: "Gemini 3 Pro" },
        { id: "models/text-embedding-004" },
      ]),
    );
    assert.deepEqual(gemini, [{ id: "gemini-3-pro", name: "Gemini 3 Pro" }]);

    const openai = await listApiChatModels(
      { format: "openai", baseUrl: "https://o", apiKey: "k", label: "OpenAI" },
      respond([
        { id: "gpt-old", created: 1 },
        { id: "whisper-1", created: 3 },
        { id: "gpt-new", created: 2 },
      ]),
    );
    assert.deepEqual(
      openai.map((model) => model.id),
      ["gpt-new", "gpt-old"],
    );
  });
});
