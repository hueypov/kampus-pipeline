/**
 * The ADR 0001 guard, against fixtures AND against this repository's own tree.
 *
 * The tree assertion is the one that keeps the decision true. It runs in CI as an ordinary test,
 * which in this repository is what "runs in CI" means for a layout property — `pnpm -r test` is a CI
 * step and no guard verb is; `portable-audit.test.ts` asserts the payload's shape the same way.
 */
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, assert, describe, it} from "vitest";
import {EVALS_ROOT, SKILLS_ROOT, evalSetsReachableFromSkills} from "./evals-placement.ts";

const repoRoot = join(process.cwd(), "../..");

describe("ADR 0001 — no eval set inside a skill directory", () => {
	let scratch: string | null = null;
	afterEach(() => {
		if (scratch !== null) rmSync(scratch, {recursive: true, force: true});
		scratch = null;
	});

	/** A tree with one skill and one relocated eval set; `link` adds the violation. */
	const build = (link: "none" | "file" | "directory"): string => {
		scratch = mkdtempSync(join(tmpdir(), "evals-placement-"));
		const skill = join(scratch, SKILLS_ROOT, "report");
		const evals = join(scratch, EVALS_ROOT, "report");
		mkdirSync(skill, {recursive: true});
		mkdirSync(evals, {recursive: true});
		writeFileSync(join(skill, "SKILL.md"), "---\nname: report\n---\n");
		writeFileSync(join(evals, "evals.json"), '{"skill_name":"report","evals":[]}');
		if (link === "file") symlinkSync(join(evals, "evals.json"), join(skill, "evals.json"));
		if (link === "directory") symlinkSync("../../evals/report", join(skill, "evals"));
		return scratch;
	};

	it("is clean when the set lives outside the skill tree", () => {
		assert.deepStrictEqual(evalSetsReachableFromSkills(build("none")), []);
	});

	it("catches a set authored back inside a skill", () => {
		const root = build("none");
		const dir = join(root, SKILLS_ROOT, "report", "evals");
		mkdirSync(dir, {recursive: true});
		writeFileSync(join(dir, "evals.json"), "{}");
		assert.deepStrictEqual(evalSetsReachableFromSkills(root), [
			"claude-plugins/kampus-pipeline/skills/report/evals/evals.json",
		]);
	});

	it("catches a symlinked evals.json FILE", () => {
		// Reported at the target, because that is where the data is; the link inside the skill is what
		// makes it reachable and what has to go.
		assert.deepStrictEqual(evalSetsReachableFromSkills(build("file")), [
			"claude-plugins/kampus-pipeline/evals/report/evals.json",
		]);
	});

	it("catches a symlinked evals DIRECTORY — the case a dirent walk is blind to", () => {
		// The move an author reaches for to restore the colocation ADR 0001 costs them: the skill
		// directory gains one link and nothing looks moved. A `readdirSync(…, {withFileTypes: true})`
		// walk returns [] here, and so does matching on the entry name first, because the dirent is
		// named `evals` rather than `evals.json`. Measured both before choosing this walk.
		assert.deepStrictEqual(evalSetsReachableFromSkills(build("directory")), [
			"claude-plugins/kampus-pipeline/evals/report/evals.json",
		]);
	});

	it("does not flag a file that merely ends in evals.json", () => {
		// Review measured the false red: the filter was a suffix test, so `not-evals.json` inside a
		// skill was reported as a violation. Nothing about ADR 0001 forbids that file.
		const root = build("none");
		const dir = join(root, SKILLS_ROOT, "report");
		writeFileSync(join(dir, "not-evals.json"), "{}");
		writeFileSync(join(dir, "sample-evals.json"), "{}");
		assert.deepStrictEqual(evalSetsReachableFromSkills(root), []);
	});

	it("this repository has no eval set inside a skill directory", () => {
		// The assertion ADR 0001 exists for, against the real tree. It reds on the pre-move tree —
		// five findings — so it is not a test that could only ever pass.
		assert.deepStrictEqual(
			evalSetsReachableFromSkills(repoRoot),
			[],
			"an eval set inside a skill is installed with the skill, so a graded run can read its own answer key (ADR 0001)",
		);
	});
});
