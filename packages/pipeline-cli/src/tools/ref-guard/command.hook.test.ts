import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", args, {cwd, encoding: "utf8"}).trim();

const policy = {
	schemaVersion: 1,
	git: {
		primaryBranch: "trunk",
		primaryRemote: "upstream",
		postSyncCommand: null,
	},
	worktrees: {managedRoots: [], reviewPrefixes: [], idleMinutes: 0},
	github: {review: {trivialDiff: {enabled: false, maxChangedLines: 0, protectedPaths: []}}},
};

let root = "";
let clone = "";
let base = "";
let remoteTip = "";
let divergent = "";

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pipeline-ref-guard-"));
	const origin = join(root, "origin.git");
	const seed = join(root, "seed");
	clone = join(root, "clone");
	execFileSync("git", ["init", "-q", "--bare", "-b", "trunk", origin]);
	execFileSync("git", ["init", "-q", "-b", "trunk", seed]);
	git(seed, "config", "user.email", "test@example.invalid");
	git(seed, "config", "user.name", "ref-guard-test");
	git(seed, "commit", "--allow-empty", "-q", "-m", "base");
	base = git(seed, "rev-parse", "HEAD");
	git(seed, "remote", "add", "upstream", origin);
	git(seed, "push", "-q", "upstream", "trunk");
	execFileSync("git", ["clone", "-q", "-o", "upstream", "-b", "trunk", origin, clone]);
	git(clone, "config", "user.email", "test@example.invalid");
	git(clone, "config", "user.name", "ref-guard-test");
	git(seed, "commit", "--allow-empty", "-q", "-m", "remote-ahead");
	git(seed, "push", "-q", "upstream", "trunk");
	git(clone, "fetch", "-q", "upstream", "trunk");
	remoteTip = git(clone, "rev-parse", "refs/remotes/upstream/trunk");
	git(clone, "commit", "--allow-empty", "-q", "-m", "divergent");
	divergent = git(clone, "rev-parse", "HEAD");
	git(clone, "reset", "--hard", "-q", base);
	mkdirSync(join(clone, ".pipeline"), {recursive: true});
	writeFileSync(join(clone, ".pipeline/agent-policy.json"), `${JSON.stringify(policy)}\n`);
	execFileSync(process.execPath, [BIN, "ref-guard", "install", "--root", clone], {stdio: "pipe"});
}, 30_000);

afterAll(() => {
	if (root) rmSync(root, {recursive: true, force: true});
});

describe("ref-guard installed hook", () => {
	it("blocks a raw divergent update-ref and preserves the existing primary ref", () => {
		expect(() => execFileSync("git", ["update-ref", "refs/heads/trunk", divergent], {cwd: clone, stdio: "pipe"})).toThrow();
		expect(git(clone, "rev-parse", "refs/heads/trunk")).toBe(base);
	});

	it("allows git stash push while the primary is behind its remote", () => {
		// The stash's internal `reset --hard HEAD` re-writes trunk at its current oid. Behind
		// upstream, that standstill used to fail the ancestry probe and abort the stash mid-way —
		// stash entry created, tree still dirty — instead of refusing cleanly (#77).
		writeFileSync(join(clone, "wip.txt"), "stash me\n");
		git(clone, "add", "wip.txt");
		expect(() => execFileSync("git", ["stash", "push", "-q"], {cwd: clone, stdio: "pipe"})).not.toThrow();
		expect(git(clone, "rev-parse", "refs/heads/trunk")).toBe(base);
		expect(git(clone, "status", "--porcelain", "--untracked-files=no")).toBe("");
		// A stash fires several reference transactions, each a cold node start of the hook.
	}, 30_000);

	it("allows a raw primary fast-forward without a pipeline caller", () => {
		expect(() => execFileSync("git", ["update-ref", "refs/heads/trunk", remoteTip], {cwd: clone, stdio: "pipe"})).not.toThrow();
		expect(git(clone, "rev-parse", "refs/heads/trunk")).toBe(remoteTip);
	});
});
