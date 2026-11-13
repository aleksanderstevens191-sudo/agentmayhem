import { CustomModelSetting, TrimmedString, makeProviderSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ApiChatService = Schema.Literals([
  "anthropic",
  "gemini",
  "openai",
  "openrouter",
  "custom",
]);
export type ApiChatService = typeof ApiChatService.Type;

export const ApiChatSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    service: ApiChatService.pipe(
      Schema.withDecodingDefault(Effect.succeed("anthropic")),
      Schema.annotateKey({
        title: "Service",
        description: "Which service the API key under Setup is for.",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "anthropic", label: "Anthropic (Claude)" },
            { value: "gemini", label: "Google (Gemini)" },
            { value: "openai", label: "OpenAI" },
            { value: "openrouter", label: "OpenRouter" },
            { value: "custom", label: "Custom (OpenAI-compatible)" },
          ],
        },
      }),
    ),
    baseUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Base URL",
        description:
          "Only for Custom, such as http://localhost:11434/v1 for Ollama. The server makes the requests.",
        providerSettingsForm: { placeholder: "https://…/v1", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["service", "baseUrl"] },
);
export type ApiChatSettings = typeof ApiChatSettings.Type;
