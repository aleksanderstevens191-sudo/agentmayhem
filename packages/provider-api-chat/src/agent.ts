// @effect-diagnostics nodeBuiltinImport:off extendsNativeError:off -- A plain Node process speaking ACP on stdio.
/**
 * The ACP agent behind the API chat provider. T3 starts it as a hidden server command, one
 * process per thread. It keeps each conversation in a JSON file, streams replies from an
 * Anthropic or OpenAI-compatible API, and runs the MCP tools T3 gives the session.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { connectMcpServer, type McpHttpServer, type McpToolResult } from "./mcp.ts";
import {
  API_CHAT_KEY_VARIABLE,
  API_CHAT_USAGE_LIMIT_CODE,
  ApiChatError,
  type ApiChatReply,
  type ChatTool,
  type ChatTurn,
  resolveApiChatConnection,
  streamApiChatReply,
  type UserPart,
} from "./services.ts";
import { ApiChatService } from "./settings.ts";

export const API_CHAT_AGENT_COMMAND = "__api-chat-agent";
export const API_CHAT_SERVICE_VARIABLE = "API_CHAT_SERVICE";
export const API_CHAT_BASE_URL_VARIABLE = "API_CHAT_BASE_URL";
export const API_CHAT_STATE_DIR_VARIABLE = "API_CHAT_STATE_DIR";

// Bounds the cost of a model that keeps calling tools.
const MAX_TOOL_ROUNDS = 50;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const isApiChatService = (value: unknown): value is ApiChatService =>
  ApiChatService.literals.some((literal) => literal === value);

interface Toolbox {
  readonly tools: ReadonlyArray<ChatTool>;
  readonly call: (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<McpToolResult>;
  readonly close: () => Promise<void>;
}

interface Session {
  readonly id: string;
  model: string;
  turns: Array<ChatTurn>;
  servers: ReadonlyArray<McpHttpServer>;
  toolbox: Promise<Toolbox> | undefined;
  running: AbortController | undefined;
}

class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The HTTP MCP servers of `session/new` or `session/load`; this agent advertises no other kind. */
function httpMcpServers(value: unknown): ReadonlyArray<McpHttpServer> {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const server = asRecord(entry);
    if (server?.type !== "http" || typeof server.url !== "string") return [];
    const headers = Object.fromEntries(
      (Array.isArray(server.headers) ? server.headers : []).flatMap((header) => {
        const pair = asRecord(header);
        return typeof pair?.name === "string" && typeof pair.value === "string"
          ? [[pair.name, pair.value]]
          : [];
      }),
    );
    return [{ name: String(server.name ?? "mcp"), url: server.url, headers }];
  });
}

/** A prompt's ACP content blocks as the parts of one user message. */
function userParts(blocks: unknown): ReadonlyArray<UserPart> {
  const parts: Array<UserPart> = [];
  const addText = (text: string) => {
    const last = parts.at(-1);
    if (last?.type === "text")
      parts[parts.length - 1] = { type: "text", text: `${last.text}\n\n${text}` };
    else parts.push({ type: "text", text });
  };
  for (const entry of Array.isArray(blocks) ? blocks : []) {
    const block = asRecord(entry);
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      addText(block.text);
    } else if (
      block?.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      parts.push({ type: "image", mimeType: block.mimeType, data: block.data });
    } else if (block?.type === "resource") {
      const resource = asRecord(block.resource);
      const uri = String(resource?.uri ?? "");
      if (typeof resource?.text === "string") {
        addText(`<file uri="${uri}">\n${resource.text}\n</file>`);
      } else if (
        typeof resource?.blob === "string" &&
        typeof resource.mimeType === "string" &&
        resource.mimeType.startsWith("image/")
      ) {
        parts.push({ type: "image", mimeType: resource.mimeType, data: resource.blob });
      } else {
        addText(`[Attached file: ${uri}]`);
      }
    } else if (block?.type === "resource_link" && typeof block.uri === "string") {
      addText(`[Attached file: ${String(block.name ?? block.uri)} (${block.uri})]`);
    }
  }
  return parts.length > 0 ? parts : [{ type: "text", text: "(empty message)" }];
}

function parseToolArguments(text: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(text || "{}")) ?? {};
  } catch {
    return {};
  }
}

function toRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  if (error instanceof ApiChatError) {
    return error.usageLimited
      ? new RpcError(
          API_CHAT_USAGE_LIMIT_CODE,
          error.message,
          error.resetAt === undefined ? undefined : { resetAt: error.resetAt },
        )
      : new RpcError(-32000, error.message);
  }
  return new RpcError(-32603, error instanceof Error ? error.message : String(error));
}

export interface ApiChatAgentOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly write?: (line: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
}

/** Serves ACP on the given streams until the input ends. */
export async function runApiChatAgent(options: ApiChatAgentOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((line: string) => void process.stdout.write(line));
  const fetchImpl = options.fetch ?? fetch;
  const stateDir = env[API_CHAT_STATE_DIR_VARIABLE]?.trim() || undefined;
  const service = env[API_CHAT_SERVICE_VARIABLE];
  const sessions = new Map<string, Session>();

  const send = (message: Record<string, unknown>) =>
    write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const notify = (sessionId: string, update: Record<string, unknown>) =>
    send({ method: "session/update", params: { sessionId, update } });

  const sessionFile = (id: string) =>
    stateDir === undefined ? undefined : NodePath.join(stateDir, `${id}.json`);

  const save = async (session: Session) => {
    const file = sessionFile(session.id);
    if (file === undefined) return;
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await NodeFSP.writeFile(
      temporary,
      JSON.stringify({ version: 1, model: session.model, turns: session.turns }),
    );
    await NodeFSP.rename(temporary, file);
  };

  const load = async (id: string): Promise<{ model: string; turns: Array<ChatTurn> }> => {
    const file = sessionFile(id);
    if (file === undefined) return { model: "", turns: [] };
    let text: string;
    try {
      text = await NodeFSP.readFile(file, "utf8");
    } catch (error) {
      // A session is first saved after its first reply, so a new one has no file yet.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { model: "", turns: [] };
      throw error;
    }
    const stored = asRecord(JSON.parse(text));
    return {
      model: typeof stored?.model === "string" ? stored.model : "",
      turns: Array.isArray(stored?.turns) ? (stored.turns as Array<ChatTurn>) : [],
    };
  };

  /** Connects the session's MCP servers once; a server that fails is left out. */
  const toolboxFor = (session: Session): Promise<Toolbox> => {
    session.toolbox ??= Promise.all(
      session.servers.map((server) =>
        connectMcpServer(server, fetchImpl).catch((error: unknown) => {
          process.stderr.write(
            `API chat could not open MCP server ${server.name}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          return undefined;
        }),
      ),
    ).then((connections) => {
      const owners = new Map<string, NonNullable<(typeof connections)[number]>>();
      const tools: Array<ChatTool> = [];
      for (const connection of connections) {
        for (const tool of connection?.tools ?? []) {
          if (connection === undefined || owners.has(tool.name)) continue;
          owners.set(tool.name, connection);
          tools.push(tool);
        }
      }
      return {
        tools,
        call: (name, args, signal) => {
          const owner = owners.get(name);
          return owner === undefined
            ? Promise.resolve({ text: `There is no tool named ${name}.`, isError: true })
            : owner.call(name, args, signal);
        },
        close: async () => {
          await Promise.all(connections.map((connection) => connection?.close()));
        },
      };
    });
    return session.toolbox;
  };

  const sessionOf = (params: Record<string, unknown>) => {
    const session = sessions.get(String(params.sessionId));
    if (session === undefined)
      throw new RpcError(-32602, `Unknown session ${String(params.sessionId)}.`);
    return session;
  };

  const replay = (session: Session) => {
    for (const turn of session.turns) {
      if (turn.role === "user") {
        for (const part of turn.content) {
          notify(session.id, {
            sessionUpdate: "user_message_chunk",
            content:
              part.type === "text"
                ? { type: "text", text: part.text }
                : { type: "image", data: part.data, mimeType: part.mimeType },
          });
        }
      } else if (turn.role === "assistant") {
        if (turn.text) {
          notify(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: turn.text },
          });
        }
        for (const call of turn.toolCalls ?? []) {
          notify(session.id, {
            sessionUpdate: "tool_call",
            toolCallId: call.id,
            title: call.name,
            kind: "other",
            status: "in_progress",
            rawInput: parseToolArguments(call.arguments),
          });
        }
      } else {
        notify(session.id, {
          sessionUpdate: "tool_call_update",
          toolCallId: turn.toolCallId,
          status: turn.isError ? "failed" : "completed",
          content: [{ type: "content", content: { type: "text", text: turn.text } }],
        });
      }
    }
  };

  const prompt = async (session: Session, blocks: unknown) => {
    if (session.running !== undefined) throw new RpcError(-32000, "A reply is already running.");
    const connection = resolveApiChatConnection({
      service: isApiChatService(service) ? service : "custom",
      baseUrl: env[API_CHAT_BASE_URL_VARIABLE] ?? "",
      apiKey: env[API_CHAT_KEY_VARIABLE],
    });
    if ("missing" in connection) throw new RpcError(-32000, connection.missing);
    if (!session.model) throw new RpcError(-32000, "Pick a model for this chat.");
    const controller = new AbortController();
    session.running = controller;
    const firstTurn = session.turns.length;
    // Turns that stay if the prompt fails: none, until a tool has run.
    let keptTurns = firstTurn;
    session.turns.push({ role: "user", content: userParts(blocks) });
    try {
      const toolbox = await toolboxFor(session);
      for (let round = 0; ; round += 1) {
        if (round === MAX_TOOL_ROUNDS) {
          const text = `Stopped after ${MAX_TOOL_ROUNDS} rounds of tool calls in one reply.`;
          notify(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          });
          session.turns.push({ role: "assistant", text });
          await save(session);
          return { stopReason: "end_turn" };
        }
        let streamed = "";
        let reply: ApiChatReply;
        try {
          reply = await streamApiChatReply({
            connection,
            model: session.model,
            turns: session.turns,
            tools: toolbox.tools,
            signal: controller.signal,
            fetch: fetchImpl,
            onDelta: (delta) => {
              if (delta.kind === "text") streamed += delta.text;
              notify(session.id, {
                sessionUpdate:
                  delta.kind === "text" ? "agent_message_chunk" : "agent_thought_chunk",
                content: { type: "text", text: delta.text },
              });
            },
          });
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          // What already reached the user stays part of the conversation.
          if (streamed) session.turns.push({ role: "assistant", text: streamed });
          await save(session);
          return { stopReason: "cancelled" };
        }
        session.turns.push({
          role: "assistant",
          text: reply.text,
          ...(reply.toolCalls.length === 0 ? {} : { toolCalls: reply.toolCalls }),
        });
        if (reply.stopReason !== "tool_use") {
          await save(session);
          return { stopReason: reply.stopReason };
        }
        // Every call gets a result, even after a stop, since the APIs reject a call left unanswered.
        for (const call of reply.toolCalls) {
          const args = parseToolArguments(call.arguments);
          notify(session.id, {
            sessionUpdate: "tool_call",
            toolCallId: call.id,
            title: call.name,
            kind: "other",
            status: "in_progress",
            rawInput: args,
          });
          let result: McpToolResult;
          if (controller.signal.aborted) {
            result = { text: "The user stopped the reply before this tool ran.", isError: true };
          } else {
            try {
              result = await toolbox.call(call.name, args, controller.signal);
            } catch (error) {
              result = {
                text: controller.signal.aborted
                  ? "The user stopped the reply while this tool ran."
                  : `The tool failed: ${error instanceof Error ? error.message : String(error)}`,
                isError: true,
              };
            }
          }
          const text = result.text || "(no output)";
          session.turns.push({
            role: "tool",
            toolCallId: call.id,
            text,
            ...(result.isError ? { isError: true } : {}),
          });
          notify(session.id, {
            sessionUpdate: "tool_call_update",
            toolCallId: call.id,
            status: result.isError ? "failed" : "completed",
            content: [{ type: "content", content: { type: "text", text } }],
          });
        }
        keptTurns = session.turns.length;
        if (controller.signal.aborted) {
          await save(session);
          return { stopReason: "cancelled" };
        }
      }
    } catch (error) {
      // A prompt that failed before any tool ran leaves no trace, so a retry doesn't send it twice.
      // Tool rounds that ran stay, since what a tool did can't be taken back.
      session.turns.length = keptTurns;
      if (keptTurns > firstTurn) await save(session).catch(() => undefined);
      throw toRpcError(error);
    } finally {
      session.running = undefined;
    }
  };

  const closeSession = async (id: string) => {
    const session = sessions.get(id);
    sessions.delete(id);
    session?.running?.abort();
    await (await session?.toolbox?.catch(() => undefined))?.close();
  };

  const handleRequest = async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            mcpCapabilities: { http: true, sse: false },
          },
          authMethods: [],
          agentInfo: { name: "t3-api-chat", version: "1" },
        };
      case "session/new": {
        const id = NodeCrypto.randomUUID();
        sessions.set(id, {
          id,
          model: "",
          turns: [],
          servers: httpMcpServers(params.mcpServers),
          toolbox: undefined,
          running: undefined,
        });
        return { sessionId: id };
      }
      case "session/load": {
        const id = String(params.sessionId);
        if (!SESSION_ID.test(id)) throw new RpcError(-32602, "Invalid session id.");
        await closeSession(id);
        const stored = await load(id);
        const session: Session = {
          id,
          ...stored,
          servers: httpMcpServers(params.mcpServers),
          toolbox: undefined,
          running: undefined,
        };
        sessions.set(id, session);
        replay(session);
        return {};
      }
      case "session/set_model":
        sessionOf(params).model = String(params.modelId ?? "").trim();
        return {};
      case "session/prompt":
        return prompt(sessionOf(params), params.prompt);
      case "session/close":
        await closeSession(String(params.sessionId));
        return {};
      case "authenticate":
      case "session/set_mode":
        return {};
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  };

  const lines = NodeReadline.createInterface({
    input: options.input ?? process.stdin,
    crlfDelay: Infinity,
  });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: Record<string, unknown> | undefined;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (typeof message?.method !== "string") return;
    const params = asRecord(message.params) ?? {};
    const id = message.id;
    if (id === undefined || id === null) {
      if (message.method === "session/cancel")
        sessions.get(String(params.sessionId))?.running?.abort();
      return;
    }
    handleRequest(message.method, params).then(
      (result) => send({ id, result }),
      (error: unknown) => {
        const rpc = toRpcError(error);
        send({
          id,
          error: {
            code: rpc.code,
            message: rpc.message,
            ...(rpc.data === undefined ? {} : { data: rpc.data }),
          },
        });
      },
    );
  });
  await new Promise<void>((resolve) => lines.once("close", resolve));
  await Promise.all([...sessions.keys()].map(closeSession));
}
