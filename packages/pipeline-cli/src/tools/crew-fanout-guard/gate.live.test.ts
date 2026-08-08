/**
 * `crew-fanout-guard` against the SHIPPED crew defs, not a fixture.
 *
 * The unit suite proves the decision; this proves the bytes we ship satisfy it. #121 was a
 * defect no fixture could have caught — three bridge defs each declared a toolset that
 * silently did not resolve, and nothing in the build read the real files. So this crosses the
 * filesystem seam at the actual repo root and additionally pins the three facts that defect
 * turned on, per bridge: `Task` is granted, no `disallowedTools` subtracts it, and no
 * ungrantable name is declared as if it were served.
 */
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "@effect/vitest";
import {Effect} from "effect";
import {BRIDGE_NAMES, parseAgentDef, UNGRANTABLE_TOOLS} from "./crew-fanout-guard.ts";
import {checkCrewFanout} from "./gate.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const CREW_AGENTS = "claude-plugins/pipeline-crew/agents";

const defAt = (name: string) => {
	const def = parseAgentDef(readFileSync(join(REPO_ROOT, CREW_AGENTS, `${name}.md`), "utf8"));
	if (!def) throw new Error(`${CREW_AGENTS}/${name}.md did not parse as an agent def`);
	return def;
};

/** Run the gate and reduce it to a comparable string, so a failure reports the guard's own report. */
const runGate = (root: string): Promise<string> =>
	Effect.runPromise(
		checkCrewFanout(root).pipe(
			Effect.match({
				onSuccess: () => "pass",
				onFailure: (e) => (e._tag === "CheckFailed" ? e.reason : `IoError at ${e.path}`),
			}),
		),
	);

describe("crew-fanout-guard over the shipped defs", () => {
	it("passes at the repo root", async () => {
		expect(await runGate(REPO_ROOT)).toBe("pass");
	});

	it.each(BRIDGE_NAMES)("%s declares a toolset that resolves as written (#121)", (name) => {
		const def = defAt(name);
		expect(def.declaresDisallowedTools).toBe(false);
		expect(def.tools).toContain("Task");
		expect(def.tools.filter((t) => UNGRANTABLE_TOOLS.has(t))).toEqual([]);
	});

	it("leaves the engine — the control case that never lost Task — free of self-denial", () => {
		expect(defAt("crew-engineering-manager").declaresDisallowedTools).toBe(false);
	});
});
