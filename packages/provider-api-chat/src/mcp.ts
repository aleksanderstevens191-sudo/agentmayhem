import { type ChatTool, serverSentData } from "./services.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";
// A tool result this long would crowd the conversation out of the model's context.
const MAX_TOOL_RESULT_CHARS = 100_000;

export interface McpHttpServer {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

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

/** Opens an MCP session over Streamable HTTP and lists its tools. */
export async function connectMcpServer(
  server: McpHttpServer,
  fetchImpl: Fetch = fetch,
): Promise<McpServerConnection> {
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

  const request = async (method: string, params: unknown, signal?: AbortSignal) => {
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
    const reply = payloads.map(asRecord).find((payload) => payload?.id === id);
    const error = asRecord(reply?.error);
    if (reply === undefined || error !== undefined) {
      throw new Error(
        `MCP ${method} on ${server.name} failed${typeof error?.message === "string" ? `: ${error.message}` : "."}`,
      );
    }
    return reply.result;
  };

  const initialized = asRecord(
    await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "t3-api-chat", version: "1" },
    }),
  );
  if (typeof initialized?.protocolVersion === "string") {
    protocolVersion = initialized.protocolVersion;
  }
  const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  await notified.body?.cancel().catch(() => undefined);

  const tools: Array<ChatTool> = [];
  let cursor: string | undefined;
  do {
    const page = asRecord(await request("tools/list", cursor === undefined ? {} : { cursor }));
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
    cursor = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
  } while (cursor !== undefined);

  return {
    tools,
    call: async (name, args, signal) =>
      toolResultText(await request("tools/call", { name, arguments: args }, signal)),
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
