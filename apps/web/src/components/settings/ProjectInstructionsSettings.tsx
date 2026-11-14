import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef } from "react";

import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// Most agents read AGENTS.md; Claude Code reads CLAUDE.md, which can import it.
const INSTRUCTIONS_FILE = "AGENTS.md";
const CLAUDE_FILE = "CLAUDE.md";

/** Edits the instructions file every agent in the checkout reads. */
export function ProjectInstructionsSettings({
  environmentId,
  cwd,
}: {
  environmentId: EnvironmentId;
  cwd: string;
}) {
  const file = useAtomValue(
    projectEnvironment.readFile({
      environmentId,
      input: { cwd, relativePath: INSTRUCTIONS_FILE, allowMissing: true },
    }),
  );
  const canWrite = useAtomValue(projectEnvironment.writeFile.permissionAtom(environmentId));
  const writeFile = useAtomCommand(projectEnvironment.writeFile, "Save project instructions");
  const readFile = useAtomQueryRunner(projectEnvironment.readFile, {
    reportFailure: false,
    refresh: true,
  });
  const edited = useRef(false);

  const loaded = AsyncResult.isSuccess(file) ? file.value : undefined;
  const saved = loaded === undefined || loaded.exists === false ? "" : loaded.contents;
  const tooLong = loaded?.truncated === true;

  const save = async (contents: string) => {
    const written = await writeFile({
      environmentId,
      input: { cwd, relativePath: INSTRUCTIONS_FILE, contents },
    });
    if (written._tag === "Failure" || !contents) return;
    const claude = await readFile({
      environmentId,
      input: { cwd, relativePath: CLAUDE_FILE, allowMissing: true },
    });
    if (claude._tag === "Success" && claude.value.exists === false) {
      await writeFile({
        environmentId,
        input: { cwd, relativePath: CLAUDE_FILE, contents: `@${INSTRUCTIONS_FILE}\n` },
      });
    }
  };

  return (
    <SettingsSection id="project-instructions" title="Instructions">
      <SettingsRow
        {...searchableSetting("project-instructions")}
        description={
          tooLong
            ? `${INSTRUCTIONS_FILE} is too long to edit here. Open it from the project's files instead.`
            : `What every agent in this project should know. Saved as ${INSTRUCTIONS_FILE} in ${cwd}.`
        }
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={`${environmentId}:${cwd}:${saved}`}
            aria-label="Project instructions"
            rows={6}
            disabled={!canWrite || tooLong || !AsyncResult.isSuccess(file)}
            defaultValue={saved.trimEnd()}
            placeholder={
              AsyncResult.isFailure(file)
                ? "Could not read the instructions file."
                : "You are helping me study biology. Explain terms the first time you use them."
            }
            onChange={() => {
              edited.current = true;
            }}
            onBlur={(event) => {
              const value = event.target.value;
              const changed = edited.current && value.trim() !== saved.trim();
              edited.current = false;
              if (changed) void save(value.trim() ? `${value.trim()}\n` : "");
            }}
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
