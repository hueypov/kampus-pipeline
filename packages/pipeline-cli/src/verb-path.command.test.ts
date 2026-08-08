/**
 * Exit-code tests for the verb-path guard, spawning the real bin.
 *
 * These exist because the 31 unit tests could not catch the guard being DISCONNECTED: the review
 * no-op'ed the wiring in `run.ts` and every unit test stayed green while `triage not-a-real-verb
 * --help` went back to exit 0 — the suite reporting green over the exact defect #55 was filed for.
 * The unit tests pin the decision; these pin that the decision runs, which only a spawned process
 * can witness.
 */
import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const run = (args: ReadonlyArray<string>): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile("node", [BIN, ...args], (error, stdout, stderr) => {
			const code =
				error && typeof (error as {code?: unknown}).code === "number"
					? (error as {code: number}).code
					: 0;
			resolve({code, stdout, stderr});
		});
	});

describe("verb-path guard — the exit codes only a spawned bin can witness (#55)", () => {
	it("an unknown subcommand exits 1 even when --help follows", async () => {
		const {code, stderr} = await run(["triage", "not-a-real-verb", "--help"]);
		assert.strictEqual(code, 1, "the guard must run before the framework answers help");
		assert.include(stderr, "this verb does not exist");
		assert.include(stderr, "queue", "the refusal names what exists");
	}, 30_000);

	it("an unknown top-level tool exits 1", async () => {
		const {code, stderr} = await run(["scratchpad", "open"]);
		assert.strictEqual(code, 1, "the verb a merged skill once cited, and nothing caught");
		assert.include(stderr, "does not exist");
	}, 30_000);

	it("an extra operand after flags exits 1 rather than answering", async () => {
		const {code, stderr} = await run(["triage", "queue", "--stage", "x", "stray"]);
		assert.strictEqual(code, 1);
		assert.include(stderr, "one too many");
	}, 30_000);

	it("a real leaf's --help still exits 0", async () => {
		const {code, stdout} = await run(["triage", "claim", "--help"]);
		assert.strictEqual(code, 0, "the guard must never refuse a path that exists");
		assert.include(stdout, "sweep-scoped hold");
	}, 30_000);

	it("version still exits 0", async () => {
		const {code} = await run(["version"]);
		assert.strictEqual(code, 0);
	}, 30_000);
});
