import {spawnSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

type RunResult = {readonly code: number; readonly stdout: string; readonly stderr: string};

const run = (root: string, args: ReadonlyArray<string>, input = ""): RunResult => {
	const result = spawnSync("node", [BIN, "guard-content-probe", ...args], {cwd: root, encoding: "utf8", input});
	return {code: result.status ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? ""};
};

const enabledPolicy = JSON.stringify({
	schemaVersion: 1,
	github: {shipping: {guardContent: {enabled: true, decisionRecordPaths: ["^records/.*\\.md$"], vocabularyPatterns: ["safeguard", "relax"]}}},
});

describe("guard-content-probe command envelope", () => {
	let root: string;
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "guard-content-probe-"));
		spawnSync("git", ["init", "-q"], {cwd: root});
		spawnSync("git", ["config", "user.email", "test@example.invalid"], {cwd: root});
		spawnSync("git", ["config", "user.name", "Test"], {cwd: root});
		spawnSync("mkdir", ["-p", ".pipeline"], {cwd: root});
		writeFileSync(join(root, ".pipeline/agent-policy.json"), enabledPolicy, "utf8");
		spawnSync("git", ["add", ".pipeline/agent-policy.json"], {cwd: root});
		spawnSync("git", ["commit", "-qm", "base policy"], {cwd: root});
	});
	afterAll(() => rmSync(root, {recursive: true, force: true}));

	it("keeps stdout machine-readable and exits zero for matching content", () => {
		const result = run(root, ["classify", "--path", "records/1.md", "--policy-ref", "HEAD"], "This RELAXES a safeguard.");
		assert.strictEqual(result.code, 0);
		assert.strictEqual(result.stdout, "guard-touching\n");
		assert.include(result.stderr, "records/1.md → guard-touching [guard-vocabulary-match]");
	});

	it("exits one only for a readable non-match under an immutable policy ref", () => {
		writeFileSync(join(root, ".pipeline/agent-policy.json"), JSON.stringify({schemaVersion: 1, github: {shipping: {guardContent: {enabled: false, decisionRecordPaths: [], vocabularyPatterns: []}}}}), "utf8");
		const result = run(root, ["classify", "--path", "records/1.md", "--policy-ref", "HEAD"], "A routine display choice.");
		assert.strictEqual(result.code, 1);
		assert.strictEqual(result.stdout, "not-guard-touching\n");
		assert.include(result.stderr, "policy trusted from HEAD:.pipeline/agent-policy.json");
	});

	it("selects candidates through the policy ref, preserves order, and removes duplicates", () => {
		const result = run(root, ["candidates", "--policy-ref", "HEAD"], "src/a.ts\nrecords/a.md\nrecords/a.md\nrecords/b.md\n");
		assert.strictEqual(result.code, 0);
		assert.strictEqual(result.stdout, "records/a.md\nrecords/b.md\n");
		assert.strictEqual(result.stderr, "");
	});

	it("treats missing policy and an unreadable body as guard-touching", () => {
		const result = run(root, ["classify", "--body-file", join(root, "missing.md"), "--policy-ref", "no-such-ref"]);
		assert.strictEqual(result.code, 0);
		assert.strictEqual(result.stdout, "guard-touching\n");
		assert.include(result.stderr, "fail-closed");
		assert.include(result.stderr, "untrusted-policy");
	});
});
