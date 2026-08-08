import {execFile, execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));
const run = (root: string, args: ReadonlyArray<string>): Promise<{readonly code: number; readonly stdout: string; readonly stderr: string}> =>
	new Promise((resolve) => {
		execFile("node", [BIN, "trivial-diff", "route", "--root", root, ...args], (error, stdout, stderr) => resolve({
			code: error && typeof (error as {code?: unknown}).code === "number" ? (error as {code: number}).code : 0,
			stdout,
			stderr,
		}));
	});

const policyWithBoundary = (controlPlanePaths: ReadonlyArray<string>) => ({
	schemaVersion: 1,
	github: {
		review: {
			classification: {
				code: {includePatterns: ["^src/"], excludePatterns: []},
				docs: {includePatterns: ["\\.md$"], excludePatterns: []},
				skills: {includePatterns: ["^skills/"], excludePatterns: []},
				design: {includePatterns: [], excludePatterns: []},
			},
			trivialDiff: {enabled: true, maxChangedLines: 2, protectedPaths: []},
		},
		shipping: {controlPlanePaths, guardContent: {enabled: false, decisionRecordPaths: [], vocabularyPatterns: []}},
	},
});

/**
 * Commit `policy` as the immutable base, then leave a conflicting copy in the worktree so every
 * assertion also proves the route read the ref rather than the working tree.
 */
const fixture = (policy: ReturnType<typeof policyWithBoundary>): {root: string; diff: string} => {
	const root = mkdtempSync(join(tmpdir(), "trivial-diff-route-"));
	mkdirSync(join(root, ".pipeline"), {recursive: true});
	writeFileSync(join(root, ".pipeline", "agent-policy.json"), JSON.stringify(policy), "utf8");
	execFileSync("git", ["init", "-q"], {cwd: root});
	execFileSync("git", ["config", "user.email", "test@example.invalid"], {cwd: root});
	execFileSync("git", ["config", "user.name", "Test"], {cwd: root});
	execFileSync("git", ["add", ".pipeline/agent-policy.json"], {cwd: root});
	execFileSync("git", ["commit", "-qm", "base policy"], {cwd: root});
	writeFileSync(join(root, ".pipeline", "agent-policy.json"), JSON.stringify({...policy, github: {...policy.github, review: {...policy.github.review, trivialDiff: {...policy.github.review.trivialDiff, enabled: false}}}}), "utf8");
	const diff = join(root, "change.patch");
	writeFileSync(diff, "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n", "utf8");
	return {root, diff};
};

describe("trivial-diff route command", () => {
	const roots: string[] = [];
	let root: string;
	let diff: string;

	beforeAll(() => {
		({root, diff} = fixture(policyWithBoundary(["^protected/"])));
		roots.push(root);
	});

	afterAll(() => {
		while (roots.length) rmSync(roots.pop()!, {recursive: true, force: true});
	});

	it("uses immutable base policy and returns review-trivial only when its SHA-bound gate contract is asserted", async () => {
		const positive = await run(root, ["--policy-ref", "HEAD", "--diff-file", diff, "--reduced-gate-supported"]);
		expect(positive.code, positive.stderr).toBe(0);
		expect(positive.stdout.trim()).toBe("review-trivial");
		const noContract = await run(root, ["--policy-ref", "HEAD", "--diff-file", diff]);
		expect(noContract.stdout.trim()).toBe("full-review");
	});

	it("refuses the reduced route when the base policy declares no protected boundary", async () => {
		const vacuous = fixture(policyWithBoundary([]));
		roots.push(vacuous.root);
		const result = await run(vacuous.root, ["--policy-ref", "HEAD", "--diff-file", vacuous.diff, "--reduced-gate-supported"]);
		expect(result.stdout.trim()).toBe("full-review");
		expect(result.stderr).toContain("protected-change boundary is unavailable");
	});
});
