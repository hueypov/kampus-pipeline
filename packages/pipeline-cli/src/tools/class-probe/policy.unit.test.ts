import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {parseClassificationPolicy, readClassificationPolicy} from "./policy.ts";

const policy = {
	schemaVersion: 1,
	github: {review: {classification: {
		code: {includePatterns: ["^src/"], excludePatterns: []},
		docs: {includePatterns: ["\\.md$"], excludePatterns: []},
		skills: {includePatterns: ["^skills/"], excludePatterns: []},
		design: {includePatterns: [], excludePatterns: []},
	}}},
};

const roots: string[] = [];
const temporaryRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "class-probe-policy-"));
	roots.push(root);
	mkdirSync(join(root, ".pipeline"), {recursive: true});
	return root;
};

afterEach(() => {
	while (roots.length) rmSync(roots.pop()!, {recursive: true, force: true});
});

describe("classification policy", () => {
	it("parses the complete policy atomically", () => {
		expect(parseClassificationPolicy(policy)).toMatchObject({code: {includePatterns: ["^src/"]}});
		expect(parseClassificationPolicy({schemaVersion: 1, github: {review: {classification: {}}}})).toBeNull();
	});

	it("uses the requested base ref instead of a conflicting worktree policy", () => {
		const root = temporaryRoot();
		writeFileSync(join(root, ".pipeline", "agent-policy.json"), JSON.stringify(policy), "utf8");
		execFileSync("git", ["init", "-q"], {cwd: root});
		execFileSync("git", ["config", "user.email", "test@example.invalid"], {cwd: root});
		execFileSync("git", ["config", "user.name", "Test"], {cwd: root});
		execFileSync("git", ["add", ".pipeline/agent-policy.json"], {cwd: root});
		execFileSync("git", ["commit", "-qm", "base policy"], {cwd: root});
		writeFileSync(join(root, ".pipeline", "agent-policy.json"), "{not-json}", "utf8");
		const loaded = readClassificationPolicy(root, "HEAD");
		expect(loaded).toMatchObject({trusted: true, source: "HEAD:.pipeline/agent-policy.json"});
		expect(loaded.policy.code.includePatterns).toEqual(["^src/"]);
	});

	it("makes a missing source fail closed", () => {
		const loaded = readClassificationPolicy(temporaryRoot(), null);
		expect(loaded).toMatchObject({trusted: false, reason: "classification policy could not be read"});
	});
});
