import {
  MEMORY_SEARCH_DEFAULT_LIMIT,
  type MemoryEntry,
  MemoryId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Memory from "../../../persistence/Memory.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { MemoryToolkit } from "./tools.ts";

/** Every query word must appear, ignoring case. */
function matchesQuery(entry: Pick<MemoryEntry, "text">, query: string | undefined) {
  const words = (query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
  const text = entry.text.toLowerCase();
  return words.every((word) => text.includes(word));
}

const callerProjectId = loadCaller().pipe(Effect.map(({ caller }) => caller?.projectId ?? null));

const make = Effect.gen(function* () {
  const memory = yield* Memory.MemoryRepository;
  const random = yield* SecureRandom.SecureRandom;

  return {
    memory_save: McpToolAccess.writes(
      (input) =>
        Effect.gen(function* () {
          const { caller } = yield* loadCaller();
          const scope = input.scope ?? "global";
          if (scope === "project" && caller === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "target_required",
              message: "A project memory needs a calling thread. Save it as global instead.",
            });
          }
          const entry: MemoryEntry = {
            id: MemoryId.make(yield* random.uuidV4().pipe(Effect.orDie)),
            scope,
            projectId: scope === "project" ? (caller?.projectId ?? null) : null,
            text: input.text,
            sourceThreadId: caller?.id ?? null,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          };
          yield* memory.save(entry).pipe(Effect.mapError(unavailable));
          return entry;
        }),
      { linkedCallers: "allowed" },
    ),
    memory_search: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const projectId = yield* callerProjectId;
        const visible = yield* memory.listVisible({ projectId }).pipe(Effect.mapError(unavailable));
        const limit = input.limit ?? MEMORY_SEARCH_DEFAULT_LIMIT;
        return {
          memories: visible.filter((entry) => matchesQuery(entry, input.query)).slice(0, limit),
        };
      }),
    ),
    memory_forget: McpToolAccess.writes(
      (input) =>
        Effect.gen(function* () {
          const projectId = yield* callerProjectId;
          const forgotten = yield* memory
            .forget({ id: input.id, projectId })
            .pipe(Effect.mapError(unavailable));
          return { id: input.id, forgotten };
        }),
      { linkedCallers: "allowed" },
    ),
  } satisfies McpToolAccess.Handlers<typeof MemoryToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(MemoryToolkit, make);
