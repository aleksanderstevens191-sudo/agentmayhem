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
        const memories = yield* memory
          .listVisible({
            projectId,
            words: (input.query ?? "").split(/\s+/u).filter(Boolean),
            limit: input.limit ?? MEMORY_SEARCH_DEFAULT_LIMIT,
          })
          .pipe(Effect.mapError(unavailable));
        return { memories };
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
