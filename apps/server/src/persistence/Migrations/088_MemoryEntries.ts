import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS memory_entries (
      memory_id TEXT PRIMARY KEY,
      project_id TEXT,
      text TEXT NOT NULL,
      source_thread_id TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_memory_entries_project_created
    ON memory_entries (project_id, created_at DESC)
  `;
});
