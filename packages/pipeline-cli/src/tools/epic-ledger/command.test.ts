/**
 * Spawned-bin witnesses for `epic-ledger`'s exit contract (#43).
 *
 * The module had 6 unit-test files and 0 covering the command layer, which is exactly where the
 * defect lived: `validateLedger` returned its defects correctly and the command printed them
 * correctly and then exited 0, so every unit test was green while `epic-ledger 39 && next-step` ran
 * `next-step` on a failing gate. Only a spawned process observes an exit code.
 *
 * These assert the CORRESPONDENCE — the exit status agrees with the verdict on stdout — rather than
 * a fixed code per epic. That is the actual invariant, and it is also what makes the test durable:
 * these read live ledgers, and a live ledger's verdict legitimately changes when someone triages a
 * child. #39 passed and #72 failed when this was written; if they swap tomorrow the assertion still
 * holds and still bites. A test pinned to "#72 exits 14" would instead go red on a correct repair of
 * #72 and teach whoever hit it to stop trusting the suite.
 *
 * They need a live read of the epic and its children, so they require an authenticated `gh`. Unlike
 * `verdict post`'s witnesses this does NOT need a user identity — reading issues works under CI's
 * installation token — so these run in CI.
 */
import {execFile, execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));
const REPO = "hueypov/kampus-pipeline";
/** Two epics with opposite verdicts at the time of writing; neither is assumed to keep it. */
const EPICS = ["39", "72"];

const ghAuthed = (): boolean => {
	try {
		execFileSync("gh", ["auth", "status"], {stdio: "ignore"});
		return true;
	} catch {
		return false;
	}
};

interface RunResult {
	readonly code: number;
	readonly stdout: string;
}

const ledger = (args: ReadonlyArray<string>): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile(
			"node",
			[BIN, "epic-ledger", ...args],
			{env: {...process.env, CLAUDE_PIPELINE_REPO: REPO}},
			(error, stdout) => {
				const code =
					error && typeof (error as {code?: unknown}).code === "number"
						? (error as {code: number}).code
						: 0;
				resolve({code, stdout});
			},
		);
	});

const authed = ghAuthed();
/** GitHub Actions and most CI set this; locally it is absent. */
const inCI = process.env.CI === "true" || process.env.CI === "1";

describe("epic-ledger — the CI-coverage guard (#43)", () => {
	// A skip that CI cannot see is coverage that does not exist (#69). Reading an issue needs only a
	// token, which CI has, so being unable to run these there is a harness defect and not a limit.
	it.skipIf(authed || !inCI)("CI must be able to run the live-ledger probes", () => {
		assert.fail(
			"no authenticated gh in CI, so the epic-ledger exit witnesses cannot run — set GH_TOKEN on the test step. A skip here would report coverage that does not exist.",
		);
	});
});

describe.skipIf(!authed)("epic-ledger — the exit status agrees with the verdict (#43)", () => {
	for (const epic of EPICS) {
		it(`--dry-run on #${epic}: PASS exits 0, FAIL exits 14`, async () => {
			const {code, stdout} = await ledger([epic, "--dry-run"]);
			const passed = stdout.includes(`✓ epic #${epic} — PASS`);
			const failed = stdout.includes(`✗ epic #${epic} — FAIL`);
			assert.isTrue(
				passed !== failed,
				`expected exactly one verdict line on stdout, got: ${stdout.slice(0, 300)}`,
			);
			assert.strictEqual(
				code,
				passed ? 0 : 14,
				`a ${passed ? "PASS" : "FAIL"} must exit ${passed ? 0 : 14} — the verdict is the exit status, not the text. stdout: ${stdout.slice(0, 300)}`,
			);
		}, 60_000);
	}

	it("a failing gate is chainable — `&&` does not run on FAIL", async () => {
		// The property the prose in plan-epic/SKILL.md used to warn about. Stated as the behaviour a
		// caller actually writes, so a regression reads as "the warning was right after all".
		const results = await Promise.all(EPICS.map((e) => ledger([e, "--dry-run"])));
		const failing = results.find((r) => r.stdout.includes("— FAIL"));
		if (failing === undefined) {
			// Every probe epic is currently clean. Not a skip: assert what that means, so the run
			// still states a fact rather than passing silently on absent evidence.
			assert.isTrue(
				results.every((r) => r.code === 0),
				"every probe epic passed its gate, so every exit must be 0",
			);
			return;
		}
		assert.notStrictEqual(failing.code, 0, "a FAIL that exits 0 makes `&&` proceed on a failing gate");
	}, 60_000);
});
