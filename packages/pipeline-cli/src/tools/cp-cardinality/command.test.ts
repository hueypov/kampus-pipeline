import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));
type RunResult = {readonly code: number; readonly stdout: string; readonly stderr: string};

const run = (args: ReadonlyArray<string>, input = ""): RunResult => {
	const result = spawnSync("node", [BIN, "cp-cardinality", "decide", ...args], {encoding: "utf8", input});
	return {code: result.status ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? ""};
};

describe("cp-cardinality command envelope", () => {
	it("prints only discharge to stdout and records the factual branch on stderr", () => {
		const result = run(["--author", "author", "--required-non-author-approvals", "1", "--non-author-approvals-at-head", "1"], "author\nreviewer\n");
		assert.strictEqual(result.code, 0);
		assert.strictEqual(result.stdout, "discharge\n");
		assert.include(result.stderr, "branch=multi-member");
		assert.include(result.stderr, "approvals=1 threshold=1");
	});

	it("maps the legacy boolean approval fact to one count and supports the legacy exception alias", () => {
		const approval = run(["--author", "author", "--non-author-approval-at-head"], "reviewer\n");
		assert.strictEqual(approval.code, 0);
		const exception = run(["--author", "author", "--non-author-approval-at-head", "--self-approval-at-head"], "author\n");
		assert.strictEqual(exception.code, 0);
	});

	it("fails closed with a stop token for invalid and contradictory count facts", () => {
		const invalid = run(["--author", "author", "--required-non-author-approvals", "zero", "--non-author-approvals-at-head", "1"], "reviewer\n");
		assert.strictEqual(invalid.code, 1);
		assert.strictEqual(invalid.stdout, "stop\n");
		assert.include(invalid.stderr, "positive integer");
		const contradiction = run(["--author", "author", "--required-non-author-approvals", "1", "--non-author-approvals-at-head", "0", "--non-author-approval-at-head"], "reviewer\n");
		assert.strictEqual(contradiction.code, 1);
		assert.strictEqual(contradiction.stdout, "stop\n");
	});
});
