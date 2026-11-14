import type { ServerProviderModel } from "@t3tools/contracts";
import {
  buildServerProvider,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  API_CHAT_KEY_VARIABLE,
  ApiChatError,
  listApiChatModels,
  resolveApiChatConnection,
} from "../services.ts";
import type { ApiChatSettings } from "../settings.ts";

const PRESENTATION = { displayName: "API chat", showInteractionModeToggle: false } as const;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const ADD_MODELS_HINT = "You can add model ids under Custom models in this provider's settings.";

const snapshot = (
  settings: ApiChatSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  listed: ReadonlyArray<ServerProviderModel> = [],
) =>
  buildServerProvider({
    presentation: PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: providerModelsFromSettings(listed, settings.customModels, EMPTY_CAPABILITIES),
    probe,
  });

export const buildInitialApiChatSnapshot = Effect.fn("ApiChatProvider.buildInitialSnapshot")(
  function* (settings: ApiChatSettings): Effect.fn.Return<ServerProviderDraft> {
    return snapshot(settings, DateTime.formatIso(yield* DateTime.now), {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled ? "Checking the API key..." : "API chat is disabled.",
    });
  },
);

/** The model a thread without a model selection runs: the service's newest. */
export function apiChatDefaultModel(
  models: ReadonlyArray<ServerProviderModel>,
): string | undefined {
  return (models.find((model) => model.isDefault) ?? models[0])?.slug;
}

/** Checks the key by listing the service's models, which also fills the model picker. */
export const checkApiChatStatus = Effect.fn("ApiChatProvider.checkStatus")(function* (
  settings: ApiChatSettings,
  environment: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "API chat is disabled.",
    });
  }
  const connection = resolveApiChatConnection({
    service: settings.service,
    baseUrl: settings.baseUrl,
    apiKey: environment[API_CHAT_KEY_VARIABLE],
  });
  if ("missing" in connection) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unauthenticated" },
      message: connection.missing,
    });
  }
  const listed = yield* Effect.tryPromise({
    try: () => listApiChatModels(connection, fetchImpl),
    catch: (cause) =>
      cause instanceof ApiChatError
        ? cause
        : new ApiChatError(`Couldn't list ${connection.label}'s models.`),
  }).pipe(Effect.result);
  if (Result.isFailure(listed)) {
    const { message, keyRejected } = listed.failure;
    return snapshot(settings, checkedAt, {
      installed: true,
      version: null,
      status: keyRejected ? "error" : "warning",
      auth: { status: keyRejected ? "unauthenticated" : "unknown" },
      message: keyRejected ? message : `${message} ${ADD_MODELS_HINT}`,
    });
  }
  const models = listed.success.map((model, index): ServerProviderModel => ({
    slug: model.id,
    name: model.name,
    isCustom: false,
    ...(index === 0 ? { isDefault: true } : {}),
    capabilities: EMPTY_CAPABILITIES,
  }));
  return snapshot(
    settings,
    checkedAt,
    {
      installed: true,
      version: null,
      status: models.length > 0 || settings.customModels.length > 0 ? "ready" : "warning",
      auth: {
        status: "authenticated",
        type: "api_key",
        label: connection.apiKey ? `${connection.label} API key` : connection.label,
      },
      ...(models.length > 0
        ? {}
        : { message: `${connection.label} listed no chat models. ${ADD_MODELS_HINT}` }),
    },
    models,
  );
});
