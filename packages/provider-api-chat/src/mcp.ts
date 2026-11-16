// @effect-diagnostics nodeBuiltinImport:off -- Runs in the plain Node agent process.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import { type ChatTool, serverSentData } from "./services.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";
// A tool result this long would crowd the conversation out of the model's context.
const MAX_TOOL_RESULT_CHARS = 100_000;

export interface McpHttpServer {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A program the agent starts, speaking MCP on its stdin and stdout. */
export interface McpStdioServer {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export type McpServer = McpHttpServer | McpStdioServer;

export interface McpToolResult {
  readonly text: string;
  readonly isError: boolean;
}

export interface McpServerConnection {
  readonly tools: ReadonlyArray<ChatTool>;
  readonly call: (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<McpToolResult>;
  readonly close: () => Promise<void>;
}

type Fetch = typeof fetch;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The text a model reads for a `tools/call` result. */
function toolResultText(result: unknown): McpToolResult {
  const record = asRecord(result);
  const parts = (Array.isArray(record?.content) ? record.content : []).flatMap((entry) => {
    const item = asRecord(entry);
    if (item?.type === "text" && typeof item.text === "string") return [item.text];
    const resource = asRecord(item?.resource);
    if (item?.type === "resource" && typeof resource?.text === "string") return [resource.text];
    return typeof item?.type === "string" ? [`[${item.type} content]`] : [];
  });
  const text =
    parts.length > 0
      ? parts.join("\n")
      : record?.structuredContent === undefined
        ? ""
        : JSON.stringify(record.structuredContent);
  return {
    text:
      text.length > MAX_TOOL_RESULT_CHARS
        ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[Result cut at ${MAX_TOOL_RESULT_CHARS} characters]`
        : text,
    isError: record?.isError === true,
  };
}

/** How one MCP server's JSON-RPC messages travel. `request` resolves with the reply's result. */
interface McpTransport {
  readonly request: (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  readonly notify: (method: string) => Promise<void>;
  /** The version the server chose, which later HTTP requests repeat in a header. */
  readonly setProtocolVersion: (version: string) => void;
  readonly close: () => Promise<void>;
}

const replyResult = (
  serverName: string,
  method: string,
  reply: Record<string, unknown> | undefined,
) => {
  const error = asRecord(reply?.error);
  if (reply === undefined || error !== undefined) {
    throw new Error(
      `MCP ${method} on ${serverName} failed${typeof error?.message === "string" ? `: ${error.message}` : "."}`,
    );
  }
  return reply.result;
};

function httpTransport(server: McpHttpServer, fetchImpl: Fetch): McpTransport {
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextId = 0;

  const requestHeaders = () => ({
    ...server.headers,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
    ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
  });

  const post = async (message: Record<string, unknown>, signal?: AbortSignal) => {
    const response = await fetchImpl(server.url, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify(message),
      ...(signal === undefined ? {} : { signal }),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`MCP server ${server.name} answered HTTP ${response.status}.`);
    }
    return response;
  };

  return {
    request: async (method, params, signal) => {
      const id = `t3-api-chat-${nextId++}`;
      const response = await post({ jsonrpc: "2.0", id, method, params }, signal);
      const payloads: Array<unknown> = [];
      if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        if (response.body !== null) {
          for await (const data of serverSentData(response.body)) {
            try {
              const payload: unknown = JSON.parse(data);
              payloads.push(payload);
              if (asRecord(payload)?.id === id) break;
            } catch {
              // A keep-alive or a comment, not a message.
            }
          }
          await response.body.cancel().catch(() => undefined);
        }
      } else {
        const text = await response.text();
        if (text.trim()) payloads.push(...[JSON.parse(text) as unknown].flat());
      }
      return replyResult(
        server.name,
        method,
        payloads.map(asRecord).find((payload) => payload?.id === id),
      );
    },
    notify: async (method) => {
      const response = await post({ jsonrpc: "2.0", method });
      await response.body?.cancel().catch(() => undefined);
    },
    setProtocolVersion: (version) => {
      protocolVersion = version;
    },
    close: async () => {
      if (sessionId === null) return;
      const response = await fetchImpl(server.url, {
        method: "DELETE",
        headers: requestHeaders(),
      }).catch(() => undefined);
      await response?.body?.cancel().catch(() => undefined);
    },
  };
}

function stdioTransport(server: McpStdioServer): McpTransport {
  const child = NodeChildProcess.spawn(server.command, [...server.args], {
    env: { ...process.env, ...server.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // The server's log lines would otherwise fill the pipe and stall it.
  child.stderr.resume();
  const pending = new Map<
    string,
    {
      readonly resolve: (reply: Record<string, unknown>) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  let nextId = 0;
  let exited: Error | undefined;
  const fail = (error: Error) => {
    exited ??= error;
    for (const waiter of pending.values()) waiter.reject(exited);
    pending.clear();
  };
  child.on("error", (error) =>
    fail(new Error(`MCP server ${server.name} could not start: ${error.message}`)),
  );
  child.on("exit", (code, signal) =>
    fail(new Error(`MCP server ${server.name} exited (${signal ?? `code ${code}`}).`)),
  );
  // A write after the server exits fails with EPIPE, which would otherwise crash this agent.
  child.stdin.on("error", (error) =>
    fail(new Error(`MCP server ${server.name}: ${error.message}`)),
  );
  const send = (message: Record<string, unknown>) =>
    new Promise<void>((resolve, reject) => {
      if (exited) return reject(exited);
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message: Record<string, unknown> | undefined;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (message === undefined) return;
    const { id } = message;
    if (typeof message.method === "string") {
      // Answer a server request rather than leave it waiting: ping works, and nothing else is offered.
      if (id !== undefined) {
        void send({
          jsonrpc: "2.0",
          id,
          ...(message.method === "ping"
            ? { result: {} }
            : { error: { code: -32601, message: "Method not found" } }),
        }).catch(() => undefined);
      }
      return;
    }
    if (typeof id !== "string") return;
    pending.get(id)?.resolve(message);
    pending.delete(id);
  });

  return {
    request: async (method, params, signal) => {
      const id = `t3-api-chat-${nextId++}`;
      const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        signal?.addEventListener(
          "abort",
          () => {
            pending.delete(id);
            reject(new Error(`MCP ${method} on ${server.name} was cancelled.`));
            void send({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: id },
            }).catch(() => undefined);
          },
          { once: true },
        );
      });
      await send({ jsonrpc: "2.0", id, method, params });
      return replyResult(server.name, method, await reply);
    },
    notify: (method) => send({ jsonrpc: "2.0", method }),
    setProtocolVersion: () => undefined,
    close: async () => {
      child.stdin.end();
      child.kill();
    },
  };
}

/** Opens an MCP session over Streamable HTTP or a program's stdio, and lists its tools. */
export async function connectMcpServer(
  server: McpServer,
  fetchImpl: Fetch = fetch,
): Promise<McpServerConnection> {
  const transport = "url" in server ? httpTransport(server, fetchImpl) : stdioTransport(server);
  try {
    const initialized = asRecord(
      await transport.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "t3-api-chat", version: "1" },
      }),
    );
    if (typeof initialized?.protocolVersion === "string") {
      transport.setProtocolVersion(initialized.protocolVersion);
    }
    await transport.notify("notifications/initialized");

    const tools: Array<ChatTool> = [];
    let cursor: string | undefined;
    do {
      const page = asRecord(
        await transport.request("tools/list", cursor === undefined ? {} : { cursor }),
      );
      for (const entry of Array.isArray(page?.tools) ? page.tools : []) {
        const tool = asRecord(entry);
        if (typeof tool?.name !== "string") continue;
        const { $schema: _schema, ...inputSchema } = asRecord(tool.inputSchema) ?? {};
        tools.push({
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema: { type: "object", ...inputSchema },
        });
      }
      cursor =
        typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor !== undefined);

    return {
      tools,
      call: async (name, args, signal) =>
        toolResultText(await transport.request("tools/call", { name, arguments: args }, signal)),
      close: transport.close,
    };
  } catch (error) {
    await transport.close();
    throw error;
  }
}
