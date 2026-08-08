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
import {
	readPullRequestPolicies,
	resolvePullRequestPolicies,
} from "../class-probe/policy.ts";
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

/**
 * The repair for the unsatisfiable merge gate: a caller that does not yet HAVE the head commit.
 *
 * The two-ref read resolves each policy with `git show <sha>:…` against the caller's object store.
 * A clone that has not fetched since the author's last push does not contain the head — the head SHA
 * moves on every push, and `ship-it check` runs right after review — and neither do `--single-branch`
 * clones, `fetch-depth: 1` checkouts, or a fresh look at any cross-fork PR. Unfetched, the head loads
 * as the untrusted classify-everything policy and the union demands `design`, which this repository
 * configures with no include pattern at all: nothing can route that gate, no reviewer can produce
 * that verdict, and the merge gate is permanently unsatisfiable while printing a required set that
 * reads like a legitimate answer.
 *
 * The first case asserts on the GATES rather than on the presence of the resolver, so removing the
 * fetch again fails it on the requirement itself and not on a missing symbol.
 */
describe("both policy refs are made resolvable before either is read", () => {
	let origin: string;
	let clone: string;
	let baseSha: string;
	let headSha: string;

	beforeAll(() => {
		origin = mkdtempSync(join(tmpdir(), "pr-policy-origin-"));
		mkdirSync(join(origin, ".pipeline"), {recursive: true});
		git(origin, ["init", "-q", "-b", "main"]);
		git(origin, ["config", "user.email", "test@example.invalid"]);
		git(origin, ["config", "user.name", "Test"]);
		writeFileSync(join(origin, ".pipeline", "agent-policy.json"), policyFile(BASE_CLASSIFICATION), "utf8");
		git(origin, ["add", "."]);
		git(origin, ["commit", "-qm", "base policy"]);
		baseSha = git(origin, ["rev-parse", "HEAD"]);
		// The head lives on its own branch, exactly as a PR head does — so a clone of the default
		// branch alone has the base and not the head, which is the state this repair is about.
		git(origin, ["checkout", "-q", "-b", "pr-head"]);
		writeFileSync(join(origin, ".pipeline", "agent-policy.json"), policyFile(HEAD_CLASSIFICATION), "utf8");
		git(origin, ["add", "."]);
		git(origin, ["commit", "-qm", "head policy"]);
		headSha = git(origin, ["rev-parse", "HEAD"]);
		git(origin, ["checkout", "-q", "main"]);

		clone = mkdtempSync(join(tmpdir(), "pr-policy-clone-"));
		// `--no-local` matters: cloning a path without it hardlinks the whole object store, so the
		// clone would silently hold the head commit it was never asked for and the reproduction would
		// prove nothing. This forces the real transport, which honours `--single-branch`.
		execFileSync("git", [
			"clone",
			"-q",
			"--no-local",
			"--single-branch",
			"--branch",
			"main",
			origin,
			clone,
		]);
	});

	afterAll(() => {
		rmSync(origin, {recursive: true, force: true});
		rmSync(clone, {recursive: true, force: true});
	});

	const present = (root: string, sha: string): boolean => {
		try {
			execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {cwd: root, stdio: "ignore"});
			return true;
		} catch {
			return false;
		}
	};

	it("fetches the absent head and requires the union, not every namespace", () => {
		// The precondition is asserted here rather than in its own case: the fetch below makes the
		// head present, so a separate pin would pass or fail on test order.
		expect(present(clone, baseSha)).toBe(true);
		expect(present(clone, headSha)).toBe(false);
		// The defect itself, stated as a required set: the raw two-ref read the merge gate used loads
		// the absent head as the untrusted classify-everything policy, and the union then demands
		// `design` — the namespace this repository configures with no include pattern, so nothing can
		// route it and no verdict can ever satisfy the gate.
		const unfetched = readPullRequestPolicies(clone, baseSha, headSha);
		expect(unfetched.head.trusted).toBe(false);
		expect(
			prGateScope(CHANGED_FILES, {base: unfetched.base.policy, head: unfetched.head.policy}).gates,
		).toEqual(["code", "doc", "skill", "design"]);

		// No remote argument: the default resolver has to find one. A `--single-branch` clone has no
		// `refs/remotes/origin/HEAD`, so asking the primary-BRANCH resolver reported "no remote to
		// fetch from" in a clone that plainly had one — caught by running the built verb against this
		// repository's own PR from exactly such a clone.
		const resolution = resolvePullRequestPolicies(clone, baseSha, headSha);
		expect(resolution._tag).toBe("resolved");
		const policies = resolution._tag === "resolved" ? resolution.policies : null;
		expect(policies?.head.trusted).toBe(true);
		const scope = prGateScope(CHANGED_FILES, {
			base: policies!.base.policy,
			head: policies!.head.policy,
		});
		expect(scope.gates).toEqual(["code", "doc", "skill"]);
		expect(scope.gates).not.toContain("design");
	});

	it("reports a ref no fetch can supply as unresolved rather than as a strict policy", () => {
		// Not knowing the rules is a different fact from knowing they are strict. Returning the
		// fail-closed policy here is what produced a required set nothing could satisfy, phrased as
		// though the scope had been established.
		const absent = "0".repeat(40);
		const resolution = resolvePullRequestPolicies(clone, baseSha, absent);
		expect(resolution._tag).toBe("unresolved");
		expect(resolution._tag === "unresolved" && resolution.refs).toEqual([absent]);
		// The remote it tried is named, so the refusal says where it looked rather than only that it
		// failed — and it proves the discovery ran rather than being handed the answer.
		expect(resolution._tag === "unresolved" && resolution.remote).toBe("origin");
	});

	it("says so rather than guessing when there is no remote to fetch from", () => {
		const isolated = mkdtempSync(join(tmpdir(), "pr-policy-noremote-"));
		try {
			git(isolated, ["init", "-q"]);
			const resolution = resolvePullRequestPolicies(isolated, baseSha, headSha);
			expect(resolution._tag).toBe("unresolved");
			expect(resolution._tag === "unresolved" && resolution.remote).toBeNull();
		} finally {
			rmSync(isolated, {recursive: true, force: true});
		}
	});
});
