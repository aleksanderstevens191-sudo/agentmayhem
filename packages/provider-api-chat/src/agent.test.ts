// @effect-diagnostics nodeBuiltinImport:off -- Drives the stdio agent with Node streams and a temp folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { assert, describe, it } from "@effect/vitest";

import { runApiChatAgent } from "./agent.ts";

type Message = Record<string, any>;

const encoder = new TextEncoder();
const sse = (events: ReadonlyArray<unknown>) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
const chatText = (text: string) =>
  sse([
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);

function startAgent(options: { readonly fetch: typeof fetch; readonly stateDir: string }) {
  const input = new NodeStream.PassThrough();
  const messages: Array<Message> = [];
  const listeners = new Set<(message: Message) => void>();
  const done = runApiChatAgent({
    input,
    write: (line) => {
      const message = JSON.parse(line) as Message;
      messages.push(message);
      for (const listener of listeners) listener(message);
    },
    env: {
      API_CHAT_SERVICE: "custom",
      API_CHAT_BASE_URL: "https://api.test/v1",
      API_CHAT_KEY: "sk-test",
      API_CHAT_STATE_DIR: options.stateDir,
    },
    fetch: options.fetch,
  });
  const next = (predicate: (message: Message) => boolean) =>
    new Promise<Message>((resolve) => {
      const seen = messages.find(predicate);
      if (seen !== undefined) return resolve(seen);
      const listener = (message: Message) => {
        if (!predicate(message)) return;
        listeners.delete(listener);
        resolve(message);
      };
      listeners.add(listener);
    });
  let nextId = 1;
  return {
    request: (method: string, params: Message = {}) => {
      const id = nextId++;
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return next((message) => message.id === id);
    },
    notify: (method: string, params: Message) =>
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`),
    nextUpdate: (kind: string) =>
      next(
        (message) =>
          message.method === "session/update" && message.params.update.sessionUpdate === kind,
      ),
    updates: () =>
      messages
        .filter((message) => message.method === "session/update")
        .map((message) => message.params.update),
    stop: async () => {
      input.end();
      await done;
    },
  };
}

async function withStateDir(use: (stateDir: string) => Promise<void>) {
  const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "api-chat-agent-"));
  try {
    await use(stateDir);
  } finally {
    await NodeFSP.rm(stateDir, { recursive: true, force: true });
  }
}

const requestBody = (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as Message;

describe("runApiChatAgent", () => {
  it("runs the session's MCP tools, then replays the saved conversation on load", () =>
    withStateDir(async (stateDir) => {
      const chatBodies: Array<Message> = [];
      const mcpRequests: Array<{ readonly body: Message | undefined; readonly headers: Headers }> =
        [];
      const fakeFetch: typeof fetch = async (url, init) => {
        if (String(url) === "http://mcp.test/mcp") {
          const headers = new Headers(init?.headers);
          const body = init?.method === "POST" ? requestBody(init) : undefined;
          mcpRequests.push({ body, headers });
          switch (body?.method) {
            case "initialize":
              return Response.json(
                {
                  jsonrpc: "2.0",
                  id: body.id,
                  result: { protocolVersion: "2025-06-18", capabilities: {} },
                },
                { headers: { "mcp-session-id": "mcp-1" } },
              );
            case "tools/list":
              return Response.json({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  tools: [
                    {
                      name: "memory_search",
                      description: "Search shared memory",
                      inputSchema: {
                        $schema: "https://json-schema.org/draft/2020-12/schema",
                        type: "object",
                        properties: { query: { type: "string" } },
                      },
                    },
                  ],
                },
              });
            case "tools/call":
              return sse([
                {
                  jsonrpc: "2.0",
                  id: body.id,
                  result: { content: [{ type: "text", text: "Ship normal chat." }] },
                },
              ]);
            default:
              return new Response(null, { status: 202 });
          }
        }
        assert.strictEqual(String(url), "https://api.test/v1/chat/completions");
        chatBodies.push(requestBody(init));
        return chatBodies.length === 1
          ? sse([
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_1",
                          function: { name: "memory_search", arguments: '{"query":"plans"}' },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              },
            ])
          : chatText("You planned normal chat.");
      };

      const agent = startAgent({ fetch: fakeFetch, stateDir });
      await agent.request("initialize", { protocolVersion: 1 });
      const created = await agent.request("session/new", {
        cwd: stateDir,
        mcpServers: [
          {
            type: "http",
            name: "t3-code",
            url: "http://mcp.test/mcp",
            headers: [{ name: "Authorization", value: "Bearer mcp-token" }],
          },
        ],
      });
      const sessionId = created.result.sessionId as string;
      await agent.request("session/set_model", { sessionId, modelId: "gpt-test" });
      const prompted = await agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "What do you remember?" }],
      });
      assert.deepEqual(prompted.result, { stopReason: "end_turn" });
      assert.deepEqual(agent.updates(), [
        {
          sessionUpdate: "tool_call",
          toolCallId: "call_1",
          title: "memory_search",
          kind: "other",
          status: "in_progress",
          rawInput: { query: "plans" },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "Ship normal chat." } }],
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "You planned normal chat." },
        },
      ]);
      assert.deepEqual(chatBodies[0]?.tools, [
        {
          type: "function",
          function: {
            name: "memory_search",
            description: "Search shared memory",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        },
      ]);
      assert.deepEqual(chatBodies[1]?.messages.at(-1), {
        role: "tool",
        tool_call_id: "call_1",
        content: "Ship normal chat.",
      });
      const call = mcpRequests.find((entry) => entry.body?.method === "tools/call");
      assert.strictEqual(call?.headers.get("authorization"), "Bearer mcp-token");
      assert.strictEqual(call?.headers.get("mcp-session-id"), "mcp-1");
      await agent.stop();
      assert.strictEqual(
        mcpRequests.at(-1)?.body,
        undefined,
        "closing the session ends the MCP session",
      );

      const restarted = startAgent({ fetch: fakeFetch, stateDir });
      await restarted.request("initialize", { protocolVersion: 1 });
      const loaded = await restarted.request("session/load", {
        sessionId,
        cwd: stateDir,
        mcpServers: [],
      });
      assert.deepEqual(loaded.result, {});
      assert.deepEqual(
        restarted.updates().map((update) => update.sessionUpdate),
        ["user_message_chunk", "tool_call", "tool_call_update", "agent_message_chunk"],
      );
      await restarted.stop();
    }));

  it("answers a rate limit with the usage-limit code and leaves the prompt out of the history", () =>
    withStateDir(async (stateDir) => {
      const chatBodies: Array<Message> = [];
      const fakeFetch: typeof fetch = async (_url, init) => {
        chatBodies.push(requestBody(init));
        return chatBodies.length === 1
          ? Response.json(
              { error: { type: "rate_limit_error", message: "Too many requests" } },
              { status: 429, headers: { "retry-after": "60" } },
            )
          : chatText("Hello again.");
      };
      const agent = startAgent({ fetch: fakeFetch, stateDir });
      const { result } = await agent.request("session/new", { cwd: stateDir, mcpServers: [] });
      await agent.request("session/set_model", {
        sessionId: result.sessionId,
        modelId: "gpt-test",
      });
      const limited = await agent.request("session/prompt", {
        sessionId: result.sessionId,
        prompt: [{ type: "text", text: "First" }],
      });
      assert.strictEqual(limited.error.code, -32029);
      assert.strictEqual(
        limited.error.message,
        "api.test is rate-limiting requests or your quota ran out: Too many requests",
      );
      assert.isString(limited.error.data.resetAt);

      await agent.request("session/prompt", {
        sessionId: result.sessionId,
        prompt: [{ type: "text", text: "Second" }],
      });
      assert.deepEqual(chatBodies[1]?.messages, [{ role: "user", content: "Second" }]);
      await agent.stop();
    }));

  it("keeps the text streamed before a stop", () =>
    withStateDir(async (stateDir) => {
      const chatBodies: Array<Message> = [];
      const fakeFetch: typeof fetch = async (_url, init) => {
        chatBodies.push(requestBody(init));
        if (chatBodies.length > 1) return chatText("Done.");
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "Partial" } }] })}\n\n`,
              ),
            );
            init?.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("Aborted", "AbortError")),
            );
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      };
      const agent = startAgent({ fetch: fakeFetch, stateDir });
      const { result } = await agent.request("session/new", { cwd: stateDir, mcpServers: [] });
      const sessionId = result.sessionId as string;
      await agent.request("session/set_model", { sessionId, modelId: "gpt-test" });
      const prompted = agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "Tell me a story" }],
      });
      await agent.nextUpdate("agent_message_chunk");
      agent.notify("session/cancel", { sessionId });
      assert.deepEqual((await prompted).result, { stopReason: "cancelled" });

      await agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "Go on" }],
      });
      assert.deepEqual(chatBodies[1]?.messages, [
        { role: "user", content: "Tell me a story" },
        { role: "assistant", content: "Partial" },
        { role: "user", content: "Go on" },
      ]);
      await agent.stop();
    }));
});
