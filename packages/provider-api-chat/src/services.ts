// @effect-diagnostics extendsNativeError:off globalDate:off -- Promise code shared by the agent process and the status probe.
import type { ApiChatService } from "./settings.ts";

/** The provider instance's environment variable that holds the API key. */
export const API_CHAT_KEY_VARIABLE = "API_CHAT_KEY";
/** The JSON-RPC error code the agent answers a prompt with when the service is rate or quota limited. */
export const API_CHAT_USAGE_LIMIT_CODE = -32029;

// Anthropic requires a cap; every current Claude model accepts this many output tokens.
const ANTHROPIC_MAX_TOKENS = 8192;
const LIST_MODELS_TIMEOUT_MS = 20_000;
// Listed by OpenAI-compatible services but unusable for chat.
const NON_CHAT_MODEL =
  /embed|tts|whisper|dall-e|moderation|transcribe|realtime|audio|image|imagen|veo|sora|aqa|babbage|davinci|instruct/i;

export type ApiChatFormat = "anthropic" | "openai";

export interface ApiChatConnection {
  readonly format: ApiChatFormat;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Names the service in errors. */
  readonly label: string;
}

const PRESETS: Record<
  Exclude<ApiChatService, "custom">,
  { readonly format: ApiChatFormat; readonly baseUrl: string; readonly label: string }
> = {
  anthropic: { format: "anthropic", baseUrl: "https://api.anthropic.com/v1", label: "Anthropic" },
  gemini: {
    format: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    label: "Gemini",
  },
  openai: { format: "openai", baseUrl: "https://api.openai.com/v1", label: "OpenAI" },
  openrouter: { format: "openai", baseUrl: "https://openrouter.ai/api/v1", label: "OpenRouter" },
};

/** The connection a setting describes, or what the person still has to fill in. */
export function resolveApiChatConnection(input: {
  readonly service: ApiChatService;
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
}): ApiChatConnection | { readonly missing: string } {
  const apiKey = input.apiKey?.trim() ?? "";
  if (input.service === "custom") {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    if (!baseUrl) return { missing: "Add the endpoint's base URL in this provider's settings." };
    let host: string;
    try {
      host = new URL(baseUrl).host;
    } catch {
      return { missing: "The base URL in this provider's settings is not a valid URL." };
    }
    return { format: "openai", baseUrl, apiKey, label: host || baseUrl };
  }
  const preset = PRESETS[input.service];
  if (!apiKey) return { missing: `Add your ${preset.label} API key in this provider's settings.` };
  return { ...preset, apiKey };
}

export class ApiChatError extends Error {
  readonly usageLimited: boolean;
  readonly keyRejected: boolean;
  /** When the service said the limit lifts, as an ISO time. */
  readonly resetAt: string | undefined;
  constructor(
    message: string,
    options: {
      readonly usageLimited?: boolean;
      readonly keyRejected?: boolean;
      readonly resetAt?: string | undefined;
    } = {},
  ) {
    super(message);
    this.usageLimited = options.usageLimited === true;
    this.keyRejected = options.keyRejected === true;
    this.resetAt = options.resetAt;
  }
}

export type UserPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mimeType: string; readonly data: string };

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** The arguments as the JSON text the model wrote. */
  readonly arguments: string;
  /** Fields the service needs sent back with the call, such as Gemini's thought signature. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** One entry of a conversation, in a form either API format is built from. */
export type ChatTurn =
  | { readonly role: "user"; readonly content: ReadonlyArray<UserPart> }
  | {
      readonly role: "assistant";
      readonly text: string;
      readonly toolCalls?: ReadonlyArray<ToolCall>;
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly text: string;
      readonly isError?: boolean;
    };

export interface ChatTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ApiChatModel {
  readonly id: string;
  readonly name: string;
}

export type ApiChatStopReason = "end_turn" | "max_tokens" | "tool_use";

export interface ApiChatReply {
  readonly stopReason: ApiChatStopReason;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<ToolCall>;
}

export interface ApiChatDelta {
  readonly kind: "text" | "thought";
  readonly text: string;
}

type Fetch = typeof fetch;

function headers(connection: ApiChatConnection): Record<string, string> {
  if (connection.format === "anthropic") {
    return { "x-api-key": connection.apiKey, "anthropic-version": "2023-06-01" };
  }
  return connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `{ error: { message } }`, or Gemini's one-element array of it. */
function errorBodyOf(body: unknown): Record<string, unknown> | undefined {
  const root = asRecord(Array.isArray(body) ? body[0] : body);
  return asRecord(root?.error);
}

/** Rate limits and exhausted quota both mean "try another agent", like a subscription's limit. */
function isUsageLimitError(error: Record<string, unknown> | undefined): boolean {
  const type = String(error?.type ?? error?.status ?? error?.code ?? "");
  return /rate_limit|RESOURCE_EXHAUSTED|insufficient_quota|^429$/i.test(type);
}

/** `retry-after` as seconds or an HTTP date. */
function resetAtOf(retryAfter: string | null, now: number): string | undefined {
  if (retryAfter === null || retryAfter.trim() === "") return undefined;
  const seconds = Number(retryAfter);
  const at = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retryAfter);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

export function describeFailure(
  label: string,
  status: number,
  body: unknown,
  retryAfter: string | null = null,
): ApiChatError {
  const error = errorBodyOf(body);
  const detail = typeof error?.message === "string" ? error.message.trim().slice(0, 300) : "";
  const usageLimited = status === 429 || isUsageLimitError(error);
  const keyRejected = status === 401 || status === 403;
  const reason = keyRejected
    ? "rejected the API key"
    : usageLimited
      ? "is rate-limiting requests or your quota ran out"
      : status === 404
        ? "couldn't find that model or endpoint"
        : `returned HTTP ${status}`;
  return new ApiChatError(`${label} ${reason}${detail ? `: ${detail}` : "."}`, {
    usageLimited,
    keyRejected,
    resetAt: usageLimited ? resetAtOf(retryAfter, Date.now()) : undefined,
  });
}

async function send(
  connection: ApiChatConnection,
  path: string,
  init: { readonly method: "GET" | "POST"; readonly body?: unknown; readonly signal?: AbortSignal },
  fetchImpl: Fetch,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(`${connection.baseUrl}${path}`, {
      method: init.method,
      headers: {
        ...headers(connection),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
      // A redirect could carry the key to another origin.
      redirect: "error",
    });
  } catch (cause) {
    if (init.signal?.aborted) throw cause;
    throw new ApiChatError(
      `Couldn't reach ${connection.label}. Check the base URL and your connection.`,
    );
  }
  if (response.ok) return response;
  const body: unknown = await response.json().catch(() => undefined);
  throw describeFailure(
    connection.label,
    response.status,
    body,
    response.headers.get("retry-after"),
  );
}

export async function listApiChatModels(
  connection: ApiChatConnection,
  fetchImpl: Fetch = fetch,
): Promise<ReadonlyArray<ApiChatModel>> {
  const signal = AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS);
  const path = connection.format === "anthropic" ? "/models?limit=1000" : "/models";
  const response = await send(connection, path, { method: "GET", signal }, fetchImpl);
  const data = asRecord(await response.json().catch(() => undefined))?.data;
  const entries = (Array.isArray(data) ? data : []).flatMap((entry) => {
    const record = asRecord(entry);
    // Gemini's OpenAI-compatible list names models `models/<id>`; chat takes the bare id.
    const id = typeof record?.id === "string" ? record.id.trim().replace(/^models\//, "") : "";
    if (!id || (connection.format === "openai" && NON_CHAT_MODEL.test(id))) return [];
    const name = record?.display_name ?? record?.name;
    const created = typeof record?.created === "number" ? record.created : undefined;
    return [{ id, name: typeof name === "string" && name.trim() ? name.trim() : id, created }];
  });
  // Newest first makes the first entry a good default. Anthropic already lists that way; other
  // services date their entries or are left in their own order.
  const sorted = entries.every((entry) => entry.created !== undefined)
    ? entries.toSorted((left, right) => right.created! - left.created!)
    : entries;
  return sorted.map(({ id, name }) => ({ id, name }));
}

/** The `data:` payloads of a server-sent event stream, one per event. */
export async function* serverSentData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  const dataOf = (event: string) => {
    const lines = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    return lines.length === 0 ? undefined : lines.join("\n");
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer = (
        buffer + (done ? decoder.decode() : decoder.decode(value, { stream: true }))
      ).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const data = dataOf(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (data !== undefined) yield data;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) {
        const data = dataOf(buffer);
        if (data !== undefined) yield data;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseArguments(text: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(text || "{}")) ?? {};
  } catch {
    return {};
  }
}

/** Anthropic wants alternating roles, so neighbouring turns of one role share a message. */
function anthropicMessages(turns: ReadonlyArray<ChatTurn>) {
  const messages: Array<{ role: "user" | "assistant"; content: Array<unknown> }> = [];
  const push = (role: "user" | "assistant", blocks: ReadonlyArray<unknown>) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  for (const turn of turns) {
    if (turn.role === "user") {
      push(
        "user",
        turn.content.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : {
                type: "image",
                source: { type: "base64", media_type: part.mimeType, data: part.data },
              },
        ),
      );
    } else if (turn.role === "assistant") {
      push("assistant", [
        ...(turn.text ? [{ type: "text", text: turn.text }] : []),
        ...(turn.toolCalls ?? []).map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: parseArguments(call.arguments),
        })),
      ]);
    } else {
      push("user", [
        {
          type: "tool_result",
          tool_use_id: turn.toolCallId,
          content: turn.text,
          ...(turn.isError ? { is_error: true } : {}),
        },
      ]);
    }
  }
  return messages;
}

function openAiMessages(turns: ReadonlyArray<ChatTurn>) {
  return turns.flatMap((turn): ReadonlyArray<unknown> => {
    if (turn.role === "user") {
      const [only] = turn.content;
      return [
        {
          role: "user",
          content:
            turn.content.length === 1 && only?.type === "text"
              ? only.text
              : turn.content.map((part) =>
                  part.type === "text"
                    ? { type: "text", text: part.text }
                    : {
                        type: "image_url",
                        image_url: { url: `data:${part.mimeType};base64,${part.data}` },
                      },
                ),
        },
      ];
    }
    if (turn.role === "tool") {
      return [{ role: "tool", tool_call_id: turn.toolCallId, content: turn.text }];
    }
    const calls = turn.toolCalls ?? [];
    if (!turn.text && calls.length === 0) return [];
    return [
      {
        role: "assistant",
        content: turn.text || null,
        ...(calls.length === 0
          ? {}
          : {
              tool_calls: calls.map((call) => ({
                ...call.extra,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments || "{}" },
              })),
            }),
      },
    ];
  });
}

/** Without tools the APIs reject tool calls in the history, so those turns become text. */
function withToolTurnsAsText(turns: ReadonlyArray<ChatTurn>): ReadonlyArray<ChatTurn> {
  return turns.map((turn): ChatTurn => {
    if (turn.role === "tool") {
      const label = turn.isError ? "Tool error" : "Tool result";
      return { role: "user", content: [{ type: "text", text: `[${label}: ${turn.text}]` }] };
    }
    if (turn.role !== "assistant" || !turn.toolCalls?.length) return turn;
    const calls = turn.toolCalls.map(
      (call) => `[Called ${call.name} with ${call.arguments || "{}"}]`,
    );
    return { role: "assistant", text: [turn.text, ...calls].filter(Boolean).join("\n\n") };
  });
}

/** The request body for one reply, in the connection's format. */
export function replyRequestBody(input: {
  readonly format: ApiChatFormat;
  readonly model: string;
  readonly turns: ReadonlyArray<ChatTurn>;
  readonly tools: ReadonlyArray<ChatTool>;
}): Record<string, unknown> {
  const turns = input.tools.length === 0 ? withToolTurnsAsText(input.turns) : input.turns;
  if (input.format === "anthropic") {
    return {
      model: input.model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      messages: anthropicMessages(turns),
      ...(input.tools.length === 0
        ? {}
        : {
            tools: input.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
          }),
      stream: true,
    };
  }
  return {
    model: input.model,
    messages: openAiMessages(turns),
    ...(input.tools.length === 0
      ? {}
      : {
          tools: input.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }),
    stream: true,
  };
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
  extra: Record<string, unknown> | undefined;
}

/** Assembles one streamed reply from its events. */
export function makeReplyReader(
  connection: Pick<ApiChatConnection, "format" | "label">,
  onDelta: (delta: ApiChatDelta) => void,
) {
  let stopReason: ApiChatStopReason = "end_turn";
  let text = "";
  const calls = new Map<number, PendingToolCall>();
  const callAt = (index: number) => {
    let call = calls.get(index);
    if (call === undefined) {
      call = { id: "", name: "", arguments: "", extra: undefined };
      calls.set(index, call);
    }
    return call;
  };
  const emitText = (chunk: string) => {
    text += chunk;
    onDelta({ kind: "text", text: chunk });
  };

  const readAnthropic = (event: Record<string, unknown>) => {
    const index = typeof event.index === "number" ? event.index : 0;
    if (event.type === "content_block_start") {
      const block = asRecord(event.content_block);
      if (block?.type === "tool_use") {
        const call = callAt(index);
        call.id = String(block.id ?? "");
        call.name = String(block.name ?? "");
      }
      return;
    }
    const delta = asRecord(event.delta);
    if (event.type === "content_block_delta") {
      if (delta?.type === "text_delta" && typeof delta.text === "string") emitText(delta.text);
      else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
        onDelta({ kind: "thought", text: delta.thinking });
      } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        callAt(index).arguments += delta.partial_json;
      }
    } else if (event.type === "message_delta" && typeof delta?.stop_reason === "string") {
      stopReason =
        delta.stop_reason === "max_tokens"
          ? "max_tokens"
          : delta.stop_reason === "tool_use"
            ? "tool_use"
            : "end_turn";
    }
  };

  const readOpenAi = (event: Record<string, unknown>) => {
    const choice = asRecord(Array.isArray(event.choices) ? event.choices[0] : undefined);
    const delta = asRecord(choice?.delta);
    // OpenRouter streams reasoning as `reasoning`; DeepSeek-style servers as `reasoning_content`.
    const thought = delta?.reasoning ?? delta?.reasoning_content;
    if (typeof thought === "string" && thought) onDelta({ kind: "thought", text: thought });
    if (typeof delta?.content === "string" && delta.content) emitText(delta.content);
    for (const [position, entry] of (Array.isArray(delta?.tool_calls)
      ? delta.tool_calls
      : []
    ).entries()) {
      const part = asRecord(entry);
      if (part === undefined) continue;
      const call = callAt(typeof part.index === "number" ? part.index : position);
      if (typeof part.id === "string" && part.id) call.id = part.id;
      const fn = asRecord(part.function);
      if (typeof fn?.name === "string" && fn.name) call.name = fn.name;
      if (typeof fn?.arguments === "string") call.arguments += fn.arguments;
      const { index: _index, id: _id, type: _type, function: _function, ...extra } = part;
      if (Object.keys(extra).length > 0) call.extra = { ...call.extra, ...extra };
    }
    const finish = choice?.finish_reason;
    if (typeof finish === "string") {
      stopReason =
        finish === "length" ? "max_tokens" : finish === "tool_calls" ? "tool_use" : "end_turn";
    }
  };

  return {
    read(data: string): void {
      if (data === "[DONE]") return;
      let event: Record<string, unknown> | undefined;
      try {
        event = asRecord(JSON.parse(data));
      } catch {
        return;
      }
      if (event === undefined) return;
      const error = asRecord(event.error);
      if (error !== undefined) {
        throw new ApiChatError(
          `${connection.label} stopped the reply: ${String(error.message ?? "unknown error").slice(0, 300)}`,
          { usageLimited: isUsageLimitError(error) },
        );
      }
      if (connection.format === "anthropic") readAnthropic(event);
      else readOpenAi(event);
    },
    result(): ApiChatReply {
      const toolCalls = [...calls.entries()]
        .toSorted(([left], [right]) => left - right)
        .flatMap(([index, call]): ReadonlyArray<ToolCall> =>
          call.name
            ? [
                {
                  id: call.id || `call_${index}`,
                  name: call.name,
                  arguments: call.arguments,
                  ...(call.extra === undefined ? {} : { extra: call.extra }),
                },
              ]
            : [],
        );
      // Some services finish a reply that calls tools with "stop". A reply cut off at the token
      // cap keeps that reason, since its last call's arguments may be incomplete.
      if (stopReason === "max_tokens") return { stopReason, text, toolCalls: [] };
      return { stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn", text, toolCalls };
    },
  };
}

/** Streams one reply to `turns`, calling `onDelta` as text arrives. */
export async function streamApiChatReply(input: {
  readonly connection: ApiChatConnection;
  readonly model: string;
  readonly turns: ReadonlyArray<ChatTurn>;
  readonly tools: ReadonlyArray<ChatTool>;
  readonly onDelta: (delta: ApiChatDelta) => void;
  readonly signal: AbortSignal;
  readonly fetch?: Fetch;
}): Promise<ApiChatReply> {
  const { connection } = input;
  const response = await send(
    connection,
    connection.format === "anthropic" ? "/messages" : "/chat/completions",
    {
      method: "POST",
      signal: input.signal,
      body: replyRequestBody({
        format: connection.format,
        model: input.model,
        turns: input.turns,
        tools: input.tools,
      }),
    },
    input.fetch ?? fetch,
  );
  if (response.body === null) throw new ApiChatError(`${connection.label} sent an empty reply.`);
  const reader = makeReplyReader(connection, input.onDelta);
  for await (const data of serverSentData(response.body)) reader.read(data);
  return reader.result();
}
