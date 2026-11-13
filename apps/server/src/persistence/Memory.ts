import { MemoryEntry, type MemoryId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type MemoryRepositoryError,
} from "./Errors.ts";

/** Memories are short, so matching runs over the newest rows in memory rather than in SQL. */
const MEMORY_SCAN_LIMIT = 5_000;

export interface SaveMemoryInput {
  readonly id: MemoryId;
  readonly projectId: ProjectId | null;
  readonly text: string;
  readonly sourceThreadId: ThreadId | null;
  readonly createdAt: string;
}

export interface ListMemoryInput {
  /** Global memories, plus this project's when set. */
  readonly projectId: ProjectId | null;
}

export class MemoryRepository extends Context.Service<
  MemoryRepository,
  {
    readonly save: (input: SaveMemoryInput) => Effect.Effect<void, MemoryRepositoryError>;
    /** Newest first. */
    readonly listVisible: (
      input: ListMemoryInput,
    ) => Effect.Effect<ReadonlyArray<MemoryEntry>, MemoryRepositoryError>;
    readonly forget: (input: {
      readonly id: MemoryId;
      readonly projectId: ProjectId | null;
    }) => Effect.Effect<boolean, MemoryRepositoryError>;
  }
>()("t3/persistence/Memory/MemoryRepository") {}

const MemoryRow = Schema.Struct({
  id: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  text: Schema.String,
  sourceThreadId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

const decodeEntry = Schema.decodeUnknownEffect(MemoryEntry);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: Schema.NullOr(Schema.String) }),
    Result: MemoryRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          memory_id AS "id",
          project_id AS "projectId",
          text AS "text",
          source_thread_id AS "sourceThreadId",
          created_at AS "createdAt"
        FROM memory_entries
        WHERE project_id IS NULL OR project_id = ${projectId}
        ORDER BY created_at DESC, memory_id DESC
        LIMIT ${MEMORY_SCAN_LIMIT}
      `,
  });

  return MemoryRepository.of({
    save: Effect.fn("MemoryRepository.save")(function (input) {
      return sql`
        INSERT INTO memory_entries (memory_id, project_id, text, source_thread_id, created_at)
        VALUES (${input.id}, ${input.projectId}, ${input.text}, ${input.sourceThreadId}, ${input.createdAt})
      `.pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new PersistenceSqlError({ operation: "saveMemory", cause })),
      );
    }),

    listVisible: Effect.fn("MemoryRepository.listVisible")(function (input) {
      return listRows({ projectId: input.projectId }).pipe(
        NodeSqliteClient.readOnly,
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeEntry({ ...row, scope: row.projectId === null ? "global" : "project" }),
          ),
        ),
        Effect.mapError((cause) =>
          Schema.isSchemaError(cause)
            ? PersistenceDecodeError.fromSchemaError("MemoryEntry", cause)
            : new PersistenceSqlError({ operation: "listMemory", cause }),
        ),
      );
    }),

    forget: Effect.fn("MemoryRepository.forget")(function (input) {
      return sql<{ readonly memory_id: string }>`
        DELETE FROM memory_entries
        WHERE memory_id = ${input.id}
          AND (project_id IS NULL OR project_id = ${input.projectId})
        RETURNING memory_id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError((cause) => new PersistenceSqlError({ operation: "forgetMemory", cause })),
      );
    }),
  });
});

export const layer = Layer.effect(MemoryRepository, make);
