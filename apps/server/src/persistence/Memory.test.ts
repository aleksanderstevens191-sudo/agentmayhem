import { MemoryId, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Memory from "./Memory.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layer = it.layer(Memory.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)));

const projectA = ProjectId.make("project:a");
const projectB = ProjectId.make("project:b");

layer("MemoryRepository", (it) => {
  it.effect("shows global memories everywhere and project memories only in their project", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.MemoryRepository;
      const save = (id: string, projectId: ProjectId | null, createdAt: string) =>
        memory.save({
          id: MemoryId.make(id),
          projectId,
          text: id,
          sourceThreadId: ThreadId.make("thread:source"),
          createdAt,
        });
      yield* save("global-old", null, "2026-11-01T00:00:00.000Z");
      yield* save("a-only", projectA, "2026-11-02T00:00:00.000Z");
      yield* save("b-only", projectB, "2026-11-03T00:00:00.000Z");

      const inA = yield* memory.listVisible({ projectId: projectA });
      assert.deepStrictEqual(
        inA.map((entry) => [entry.id, entry.scope]),
        [
          ["a-only", "project"],
          ["global-old", "global"],
        ],
      );
      const outside = yield* memory.listVisible({ projectId: null });
      assert.deepStrictEqual(
        outside.map((entry) => entry.id),
        ["global-old"],
      );

      // Another project cannot delete project A's memory.
      assert.isFalse(yield* memory.forget({ id: MemoryId.make("a-only"), projectId: projectB }));
      assert.isTrue(yield* memory.forget({ id: MemoryId.make("a-only"), projectId: projectA }));
      assert.isTrue(yield* memory.forget({ id: MemoryId.make("global-old"), projectId: null }));
      assert.deepStrictEqual(yield* memory.listVisible({ projectId: projectA }), []);
    }),
  );
});
