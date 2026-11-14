import {
  type ChatAttachment,
  type OrchestrationV2ProviderCapabilities,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
  makeAcpAdapterV2,
} from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { isProviderNativeImageAttachment } from "@t3tools/provider-core/server/attachmentPrompt";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  resolveSelfInvocation,
  type SelfInvocation,
  selfInvocationArgs,
} from "@t3tools/shared/nodeRuntime";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  API_CHAT_AGENT_COMMAND,
  API_CHAT_BASE_URL_VARIABLE,
  API_CHAT_SERVICE_VARIABLE,
  API_CHAT_STATE_DIR_VARIABLE,
} from "../agent.ts";
import { API_CHAT_USAGE_LIMIT_CODE } from "../services.ts";
import { ApiChatSettings } from "../settings.ts";

const API_CHAT_PROVIDER = ProviderDriverKind.make("apiChat");
const DEFAULT_SETTINGS = Schema.decodeSync(ApiChatSettings)({});

const ApiChatCapabilities = {
  ...AcpProviderCapabilitiesV2,
  sessions: { ...AcpProviderCapabilitiesV2.sessions, supportsModelSwitchInSession: true },
} satisfies OrchestrationV2ProviderCapabilities;

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const decodeResetAt = Schema.decodeUnknownOption(Schema.Struct({ resetAt: Schema.String }));

/** A rate limit or spent quota is a usage limit, so the thread can move to a fallback agent. */
export function apiChatPromptFailure(cause: unknown) {
  if (!isAcpRequestError(cause)) return makeProviderFailure({ cause, class: "provider_error" });
  const usageLimited = cause.code === API_CHAT_USAGE_LIMIT_CODE;
  const resetAt = usageLimited ? decodeResetAt(cause.data) : undefined;
  return makeProviderFailure({
    cause,
    message: cause.errorMessage,
    code: String(cause.code),
    class: usageLimited ? "usage_limit" : "provider_error",
    ...(resetAt?._tag === "Some" ? { resetAt: resetAt.value.resetAt } : {}),
  });
}

// A whole large file would crowd the conversation out of the model's context.
const MAX_ATTACHED_TEXT_CHARS = 200_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function readableText(bytes: Uint8Array): string | undefined {
  try {
    const text = utf8.decode(bytes);
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * The model cannot open files, so attachments travel in the prompt: images as images, and
 * text files or the text of Office documents inline. Other files stay a named path.
 */
export const apiChatAttachmentBlocks = Effect.fn("ApiChatAdapter.attachmentBlocks")(
  function* (input: {
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
    readonly resolveExtractedTextPath:
      | ((path: string) => Effect.Effect<string | undefined>)
      | undefined;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const blocks: Array<EffectAcpSchema.ContentBlock> = [];
    for (const attachment of input.attachments) {
      const saved = input.resolveAttachmentPath(attachment);
      // The prompt text already says the attachment is unavailable.
      if (saved === null) continue;
      const image = isProviderNativeImageAttachment(attachment);
      if (!image && attachment.type !== "file") continue;
      const extracted =
        image || input.resolveExtractedTextPath === undefined
          ? undefined
          : yield* input.resolveExtractedTextPath(saved);
      const source = extracted ?? saved;
      const bytes = yield* fileSystem
        .readFile(source)
        .pipe(
          Effect.mapError(() =>
            EffectAcpErrors.AcpRequestError.invalidParams(
              `Could not read attachment '${attachment.name}'.`,
            ),
          ),
        );
      if (image) {
        blocks.push({
          type: "image",
          mimeType: attachment.mimeType,
          data: Buffer.from(bytes).toString("base64"),
        });
        continue;
      }
      const text = readableText(bytes);
      if (text === undefined) continue;
      const uri = yield* path.toFileUrl(saved).pipe(
        Effect.map((url) => url.href),
        Effect.orElseSucceed(() => attachment.name),
      );
      blocks.push({
        type: "resource",
        resource: {
          uri,
          mimeType: "text/plain",
          text:
            text.length > MAX_ATTACHED_TEXT_CHARS
              ? `${text.slice(0, MAX_ATTACHED_TEXT_CHARS)}\n[File cut at ${MAX_ATTACHED_TEXT_CHARS} characters]`
              : text,
        },
      });
    }
    return blocks;
  },
);

interface ApiChatAdapterOptions {
  readonly settings: ApiChatSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  /** Where the agent keeps its conversations. */
  readonly stateDir: string;
  /** The model a thread without a selection runs, read from the provider snapshot. */
  readonly defaultModel: Effect.Effect<string | undefined>;
  readonly resolveExtractedTextPath:
    | ((path: string) => Effect.Effect<string | undefined>)
    | undefined;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

function makeApiChatAdapterFlavor(options: ApiChatAdapterOptions): AcpAdapterV2Flavor {
  const makeRuntime = (input: AcpAdapterV2RuntimeInput) => {
    const { runtimePolicy: _runtimePolicy, processEnvironment, ...runtimeInput } = input;
    return Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeInput,
        spawn: {
          command: options.selfInvocation.command,
          args: [...selfInvocationArgs(options.selfInvocation, [API_CHAT_AGENT_COMMAND])],
          cwd: input.cwd,
          env: {
            ...options.environment,
            ...processEnvironment,
            ELECTRON_RUN_AS_NODE: "1",
            [API_CHAT_SERVICE_VARIABLE]: options.settings.service,
            [API_CHAT_BASE_URL_VARIABLE]: options.settings.baseUrl,
            [API_CHAT_STATE_DIR_VARIABLE]: options.stateDir,
          },
        },
      }),
    ).pipe(
      Effect.flatMap((context) =>
        Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context)),
      ),
    );
  };
  return {
    driver: API_CHAT_PROVIDER,
    runtimeHarness: "API chat",
    capabilities: ApiChatCapabilities,
    makeRuntime,
    // The agent's only tools are T3's, over HTTP.
    mcpOverHttp: true,
    promptFailure: apiChatPromptFailure,
    buildAttachmentPrompt: ({ attachments, resolveAttachmentPath }) =>
      apiChatAttachmentBlocks({
        attachments,
        resolveAttachmentPath,
        resolveExtractedTextPath: options.resolveExtractedTextPath,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, options.fileSystem),
        Effect.provideService(Path.Path, options.path),
      ),
    // Any session takes `session/set_model`, though `session/new` lists no models.
    modelOptionArrivesLate: true,
    applyModelSelection: Effect.fn("ApiChatAdapter.applyModelSelection")(function* ({
      runtime,
      modelSelection,
    }) {
      const selected = modelSelection.model.trim();
      const model = selected && selected !== "default" ? selected : yield* options.defaultModel;
      if (!model) return undefined;
      yield* runtime.setSessionModel(model);
      return model;
    }),
  };
}

export type ApiChatAdapterDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const makeApiChatAdapterDriver = (
  defaultModel: Effect.Effect<string | undefined>,
): ProviderAdapterDriver<ApiChatSettings, ApiChatAdapterDriverEnv> => ({
  driverKind: API_CHAT_PROVIDER,
  configSchema: ApiChatSettings,
  defaultConfig: (): ApiChatSettings => DEFAULT_SETTINGS,
  create: Effect.fn("ApiChatAdapterDriver.create")(
    function* (input: ProviderAdapterDriverCreateInput<ApiChatSettings>) {
      const host = yield* ProviderHost.ProviderHost;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeAcpAdapterV2({
        instanceId: input.instanceId,
        flavor: makeApiChatAdapterFlavor({
          settings: { ...input.config, enabled: input.enabled },
          environment: yield* mergeProviderInstanceEnvironment(
            input.environment,
            yield* HostProcess.Environment,
          ),
          selfInvocation,
          stateDir: path.join(host.paths.stateDir, "api-chat"),
          defaultModel,
          resolveExtractedTextPath: host.resolveExtractedTextPath,
          fileSystem,
          path,
        }),
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: API_CHAT_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: API_CHAT_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create the API chat adapter.",
              cause,
            }),
        ),
      ),
  ),
});
