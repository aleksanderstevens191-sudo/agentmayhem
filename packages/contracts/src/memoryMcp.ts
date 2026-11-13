import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const MEMORY_TEXT_MAX_LENGTH = 4_000;
export const MEMORY_SEARCH_DEFAULT_LIMIT = 20;
const MEMORY_SEARCH_MAX_LIMIT = 100;

export const MemoryId = TrimmedNonEmptyString.pipe(Schema.brand("MemoryId"));
export type MemoryId = typeof MemoryId.Type;

export const MemoryScope = Schema.Literals(["global", "project"]);
export type MemoryScope = typeof MemoryScope.Type;

export const MemoryEntry = Schema.Struct({
  id: MemoryId,
  scope: MemoryScope,
  projectId: Schema.NullOr(ProjectId),
  text: Schema.String,
  sourceThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type MemoryEntry = typeof MemoryEntry.Type;

export const MemorySaveInput = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(MEMORY_TEXT_MAX_LENGTH)).annotate({
    description: "One self-contained fact, in a sentence or two.",
  }),
  scope: Schema.optional(
    MemoryScope.annotate({
      description: "global (default): every project. project: only this thread's project.",
    }),
  ),
});
export type MemorySaveInput = typeof MemorySaveInput.Type;

export const MemorySearchInput = Schema.Struct({
  query: Schema.optional(
    Schema.String.check(Schema.isMaxLength(500)).annotate({
      description: "Words to match. Omit for the newest memories.",
    }),
  ),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MEMORY_SEARCH_MAX_LIMIT })),
  ),
});
export type MemorySearchInput = typeof MemorySearchInput.Type;

export const MemorySearchResult = Schema.Struct({
  memories: Schema.Array(MemoryEntry),
});
export type MemorySearchResult = typeof MemorySearchResult.Type;

export const MemoryForgetInput = Schema.Struct({
  id: MemoryId,
});
export type MemoryForgetInput = typeof MemoryForgetInput.Type;

export const MemoryForgetResult = Schema.Struct({
  id: MemoryId,
  forgotten: Schema.Boolean,
});
export type MemoryForgetResult = typeof MemoryForgetResult.Type;
