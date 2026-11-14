import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { API_CHAT_KEY_VARIABLE } from "./services.ts";
import { ApiChatSettings } from "./settings.ts";

export const apiChatClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("apiChat"),
  label: "API chat",
  hasDefaultInstance: false,
  settingsSchema: ApiChatSettings,
  environmentFields: [
    {
      name: API_CHAT_KEY_VARIABLE,
      label: "API key",
      description: "The service's API key. Custom endpoints without a key can leave it empty.",
      placeholder: "Paste API key",
      sensitive: true,
    },
  ],
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#5B5BD6", dark: "#9B9BF5" },
    paths: [
      {
        d: "M5 3h14a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-8l-5 4v-4H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z",
      },
    ],
  },
});
