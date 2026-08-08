/**
 * Spawned-bin witnesses for `evals lint`'s exit contract.
 *
 * The unit suite pins the lint DECISIONS; it cannot witness the command layer. Review demonstrated
 * that mutating away both the `SKILL_NAME` identifier guard and the INDETERMINATE ambient-missing
 * refusal left all 30 unit tests green — and those two were the exact command-level regressions the
 * review had just found. Only a spawned process observes an exit code.
 *
 * Unlike the namespace guard's witnesses, these are HERMETIC: `evals lint` reads files under
 * `--root` and touches no network, so they always run — in CI, on a fresh clone, offline. The
 * fixture repository is built here rather than pointed at the real tree, so a future eval-set edit
 * cannot quietly change what these assert.
 */
import {execFile} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const lint = (args: ReadonlyArray<string>): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile("node", [BIN, "evals", "lint", ...args], (error, stdout, stderr) => {
			const code =
				error && typeof (error as {code?: unknown}).code === "number"
					? (error as {code: number}).code
					: 0;
			resolve({code, stdout, stderr});
		});
	});

/** A case that lints clean: real prompt, one grounded assertion naming a skill-only surface. */
const CLEAN_CASE = {
	name: "a-clean-case",
	grounding: "contract.md T1",
	prompt: "You are mid-task and notice the retry helper swallows the abort reason.",
	assertions: ["Composes the body as the six sections the skill names"],
};

describe("evals lint — the exit contract, witnessed by a spawned bin (#69)", () => {
	let root: string;

	const writeSet = (skill: string, set: unknown): void => {
		const dir = join(root, "claude-plugins/pipeline/skills", skill, "evals");
		mkdirSync(dir, {recursive: true});
		writeFileSync(join(dir, "evals.json"), JSON.stringify(set));
	};

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "evals-lint-"));
		writeSet("clean-skill", {skill_name: "clean-skill", evals: [CLEAN_CASE]});
		writeSet("defect-skill", {skill_name: "defect-skill", evals: [{...CLEAN_CASE, assertions: []}]});
	});
	afterAll(() => rmSync(root, {recursive: true, force: true}));

	it("exits 4 on a skill name that is not an identifier, rather than crashing", async () => {
		// The name reaches a RegExp. Review's probe crashed this on exit 1 with a SyntaxError —
		// a bug's exit code, not a refusal's.
		const {code, stderr} = await lint(["bad;name", "--root", root, "--no-ambient"]);
		assert.strictEqual(code, 4, "an unusable input refuses; it does not throw");
		assert.include(stderr, "is not a skill name");
	}, 30_000);

	it("exits 8 when no ambient context can be found and none was asserted", async () => {
		// The flagship grades-the-repository check silently off is a vacuous pass wearing a clean
		// exit: the same set reported a defect with an ambient file present and clean-0 with the
		// path mistyped.
		const {code, stderr} = await lint(["clean-skill", "--root", root]);
		assert.strictEqual(code, 8, "an unrun check is INDETERMINATE, never clean");
		assert.include(stderr, "--no-ambient");
	}, 30_000);

	it("exits 0 once --no-ambient asserts the repository has none", async () => {
		const {code, stdout} = await lint(["clean-skill", "--root", root, "--no-ambient"]);
		assert.strictEqual(code, 0, "the assertion makes the skip a stated fact");
		assert.include(stdout, "clean");
	}, 30_000);

	it("exits 14 on a defect", async () => {
		const {code, stdout} = await lint(["defect-skill", "--root", root, "--no-ambient"]);
		assert.strictEqual(code, 14);
		assert.include(stdout, "no-assertions");
	}, 30_000);

	it("exits 16 when the skill has no eval set at all", async () => {
		// Ungraded is not a pass, and must not share a code with a set that graded clean.
		const {code, stderr} = await lint(["absent-skill", "--root", root, "--no-ambient"]);
		assert.strictEqual(code, 16);
		assert.include(stderr, "ungraded, which is not the same as passing");
	}, 30_000);
});
