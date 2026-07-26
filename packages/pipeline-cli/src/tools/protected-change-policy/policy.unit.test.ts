import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {parseProtectedChangePolicy, readProtectedChangePolicy} from "./policy.ts";

const policy = {schemaVersion: 1, github: {shipping: {controlPlanePaths: ["^pipeline/", "^\\.github/"]}}};
const roots: string[] = [];
const temporaryRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "protected-change-policy-"));
	roots.push(root);
	mkdirSync(join(root, ".pipeline"), {recursive: true});
	return root;
};

afterEach(() => {
	while (roots.length) rmSync(roots.pop()!, {recursive: true, force: true});
});

describe("protected-change policy reader", () => {
	it("accepts an explicit, fully anchored repository boundary and rejects unsafe shapes", () => {
		expect(parseProtectedChangePolicy(policy)).toEqual({controlPlanePaths: ["^pipeline/", "^\\.github/"]});
		expect(parseProtectedChangePolicy({schemaVersion: 1, github: {shipping: {controlPlanePaths: ["pipeline/"]}}})).toBeNull();
	});

	it("uses the immutable supplied ref instead of conflicting worktree policy", () => {
		const root = temporaryRoot();
		writeFileSync(join(root, ".pipeline", "agent-policy.json"), JSON.stringify(policy), "utf8");
		execFileSync("git", ["init", "-q"], {cwd: root});
		execFileSync("git", ["config", "user.email", "test@example.invalid"], {cwd: root});
		execFileSync("git", ["config", "user.name", "Test"], {cwd: root});
		execFileSync("git", ["add", ".pipeline/agent-policy.json"], {cwd: root});
		execFileSync("git", ["commit", "-qm", "base policy"], {cwd: root});
		writeFileSync(join(root, ".pipeline", "agent-policy.json"), JSON.stringify({schemaVersion: 1, github: {shipping: {controlPlanePaths: ["^relaxed/"]}}}), "utf8");
		expect(readProtectedChangePolicy(root, "HEAD")).toMatchObject({
			trusted: true,
			source: "HEAD:.pipeline/agent-policy.json",
			policy: {controlPlanePaths: policy.github.shipping.controlPlanePaths},
		});
	});
});
