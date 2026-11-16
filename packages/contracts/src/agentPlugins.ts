import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The MCP server name agents see, such as `computer-control`. Names starting with `t3` are kept
 * for T3 Code's own servers.
 */
export const AgentPluginName = Schema.String.check(
  Schema.isMaxLength(40),
  Schema.isPattern(/^(?!t3)[a-z0-9][a-z0-9-]*$/),
);
export type AgentPluginName = typeof AgentPluginName.Type;

export const AgentPluginServer = Schema.Union([
  /** A program the agent starts on this machine. */
  Schema.Struct({
    type: Schema.Literal("stdio"),
    command: TrimmedNonEmptyString,
    args: Schema.Array(Schema.String),
  }),
  /** A remote MCP server that needs no sign-in. */
  Schema.Struct({ type: Schema.Literal("http"), url: TrimmedNonEmptyString }),
]);
export type AgentPluginServer = typeof AgentPluginServer.Type;

/** An MCP server the user added as a plugin. Every agent on this environment gets its tools. */
export const AgentPlugin = Schema.Struct({
  name: AgentPluginName,
  enabled: Schema.Boolean,
  server: AgentPluginServer,
});
export type AgentPlugin = typeof AgentPlugin.Type;

const isAgentPlugin = Schema.is(AgentPlugin);

/** Bad entries drop alone, so a hand edit cannot reset settings. Later duplicates of a name drop. */
export const AgentPlugins = Schema.Array(Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Array(AgentPlugin),
    SchemaTransformation.transform<ReadonlyArray<AgentPlugin>, ReadonlyArray<unknown>>({
      decode: (values) => {
        const names = new Set<string>();
        return values.filter((value): value is AgentPlugin => {
          if (!isAgentPlugin(value) || names.has(value.name)) return false;
          names.add(value.name);
          return true;
        });
      },
      encode: (values) => values,
    }),
  ),
);
