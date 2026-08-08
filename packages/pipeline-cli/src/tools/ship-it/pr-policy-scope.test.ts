/**
 * The regression for #120, on the pull request that exposed it.
 *
 * A PR touching no policy cannot reproduce this: the base and head files are identical, so reading
 * either one gives the same answer and the defect is invisible. The reproduction needs a repository
 * whose two sides genuinely disagree, so this builds one — a base commit carrying the policy #93
 * replaced, a head commit carrying the policy #93 introduced, and a worktree standing at the base,
 * which is where a shipper normally runs.
 */
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {readPullRequestPolicies} from "../class-probe/policy.ts";
import {gatesForFiles, guardPolicies, prGateScope} from "./preconditions.ts";

/** #93's classification policy as its BASE commit stated it: no rule for eval sets. */
const BASE_CLASSIFICATION = {
	code: {includePatterns: ["^(src|app|apps|packages|lib|server|infra|scripts|tests?)/"], excludePatterns: []},
	docs: {
		includePatterns: ["^(docs|documentation|\\.decisions|\\.patterns)/|(^|/)README\\.md$|\\.md$"],
		excludePatterns: ["(^|/)(skills|agents)/", "^\\.codex-plugin/", "^(src|app|apps|packages|lib|server|infra|scripts|tests?)/"],
	},
	skills: {includePatterns: ["(^|/)(skills|agents)/", "^\\.codex-plugin/"], excludePatterns: []},
	design: {includePatterns: [], excludePatterns: []},
};

/** The same policy as #93's HEAD states it — one added pattern, which is the whole point of #93. */
const HEAD_CLASSIFICATION = {
	...BASE_CLASSIFICATION,
	skills: {
		includePatterns: ["(^|/)(skills|agents)/", "^\\.codex-plugin/", "^claude-plugins/[^/]+/evals/"],
		excludePatterns: [],
	},
};

/** #93's changed-file list, verbatim from `pulls/93/files`. */
const CHANGED_FILES = [
	".pipeline/agent-policy.json",
	"claude-plugins/kampus-pipeline/docs/authoring-conventions.md",
	"claude-plugins/kampus-pipeline/evals/plan-epic/evals.json",
	"claude-plugins/kampus-pipeline/evals/report/evals.json",
	"claude-plugins/kampus-pipeline/evals/review-code/evals.json",
	"claude-plugins/kampus-pipeline/evals/triage/evals.json",
	"claude-plugins/kampus-pipeline/evals/write-code/evals.json",
	"packages/pipeline-cli/src/tools/evals/command.test.ts",
	"packages/pipeline-cli/src/tools/evals/command.ts",
	"packages/pipeline/src/evals-placement.test.ts",
	"packages/pipeline/src/evals-placement.ts",
	"packages/pipeline/src/portable-audit.test.ts",
	"templates/pipeline/agent-policy.json",
];

const policyFile = (classification: unknown): string =>
	JSON.stringify({schemaVersion: 1, github: {review: {classification}}});

const git = (root: string, args: ReadonlyArray<string>): string =>
	execFileSync("git", args, {cwd: root, encoding: "utf8"}).trim();

describe("a policy-changing PR is gated by both of its policies (#120)", () => {
	let root: string;
	let baseSha: string;
	let headSha: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "pr-policy-scope-"));
		mkdirSync(join(root, ".pipeline"), {recursive: true});
		git(root, ["init", "-q"]);
		git(root, ["config", "user.email", "test@example.invalid"]);
		git(root, ["config", "user.name", "Test"]);
		writeFileSync(join(root, ".pipeline", "agent-policy.json"), policyFile(BASE_CLASSIFICATION), "utf8");
		git(root, ["add", "."]);
		git(root, ["commit", "-qm", "base policy"]);
		baseSha = git(root, ["rev-parse", "HEAD"]);
		writeFileSync(join(root, ".pipeline", "agent-policy.json"), policyFile(HEAD_CLASSIFICATION), "utf8");
		git(root, ["add", "."]);
		git(root, ["commit", "-qm", "head policy"]);
		headSha = git(root, ["rev-parse", "HEAD"]);
		// Back to the base: a shipper's checkout is the side the PR is merging INTO, which is what
		// made the worktree read answer with the rule under replacement.
		git(root, ["checkout", "-q", baseSha]);
	});

	afterAll(() => rmSync(root, {recursive: true, force: true}));

	it("pins the defect: the worktree's own policy requires two namespaces", () => {
		const worktree = readPullRequestPolicies(root, baseSha, headSha).base;
		expect(worktree.trusted).toBe(true);
		expect(gatesForFiles(CHANGED_FILES, worktree.policy)).toEqual(["code", "doc"]);
	});

	it("requires review-code, review-doc AND review-skill from the two sides together", () => {
		const loaded = readPullRequestPolicies(root, baseSha, headSha);
		const scope = prGateScope(CHANGED_FILES, {base: loaded.base.policy, head: loaded.head.policy});
		expect(scope.gates).toEqual(["code", "doc", "skill"]);
		// The namespace #93 existed to introduce, named as the one its two sides disagree about.
		expect(scope.only).toEqual(["skill"]);
	});

	it("gives the reviewer's guard the same two policies, so the two stages cannot diverge", () => {
		const loaded = readPullRequestPolicies(root, baseSha, headSha);
		const guarded = guardPolicies(loaded);
		expect(guarded).not.toBeNull();
		expect(prGateScope(CHANGED_FILES, guarded!).gates).toEqual(["code", "doc", "skill"]);
	});

	it("falls closed on a ref it cannot resolve rather than answering from the worktree", () => {
		const loaded = readPullRequestPolicies(root, baseSha, "0000000000000000000000000000000000000000");
		expect(loaded.head.trusted).toBe(false);
		expect(guardPolicies(loaded)).toBeNull();
		const scope = prGateScope(CHANGED_FILES, {base: loaded.base.policy, head: loaded.head.policy});
		expect(scope.gates).toEqual(["code", "doc", "skill", "design"]);
	});
});
