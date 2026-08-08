import {execFileSync, spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
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

/**
 * Every case here drives real Git against the real installed hook, and each ref transaction is a
 * cold Node start — `git stash push` alone fires several. The generous timeouts are headroom for
 * that, not a symptom: measured, the hook costs about 2.5s per commit and v3 is slightly cheaper
 * than v2 (it stops running the CLI once a candidate has answered). They are here because the
 * default 5s fails on a loaded machine, which reads as a broken guard rather than a busy one.
 */
const HOOK_TIMEOUT = 60_000;

describe("ref-guard installed hook", () => {
	it("blocks a raw divergent update-ref and preserves the existing primary ref", () => {
		expect(() => execFileSync("git", ["update-ref", "refs/heads/trunk", divergent], {cwd: clone, stdio: "pipe"})).toThrow();
		expect(git(clone, "rev-parse", "refs/heads/trunk")).toBe(base);
	}, HOOK_TIMEOUT);

	it("still guards when the first candidate exists but cannot run", () => {
		// #85: in a worktree without `node_modules` the in-repo bin.ts passes `[ -f ]` and then dies
		// at module load. v2 chose that candidate and read its crash as "ran, no refusal" — the
		// guard was off, behind a stack trace, on every ref update. Only a real hook run shows it,
		// because the failure is in candidate selection, not in any decision.
		const broken = join(clone, "packages/pipeline-cli/src");
		mkdirSync(broken, {recursive: true});
		writeFileSync(join(broken, "bin.ts"), 'import "node:nonexistent/module";\n');
		try {
			// The refusal must still arrive, from the recorded candidate, and the ref must not move.
			expect(() => execFileSync("git", ["update-ref", "refs/heads/trunk", divergent], {cwd: clone, stdio: "pipe"})).toThrow();
			expect(git(clone, "rev-parse", "refs/heads/trunk")).toBe(base);
		} finally {
			rmSync(join(clone, "packages"), {recursive: true, force: true});
		}
	}, HOOK_TIMEOUT);

	it("announces itself when no candidate can run, and does not abort the transaction", () => {
		// Fail-open is deliberate — a reference-transaction hook that exits non-zero bricks every
		// git operation — but it must say so rather than pass for a clean run.
		const hookPath = join(clone, ".git/hooks/reference-transaction");
		const installed = readFileSync(hookPath, "utf8");
		writeFileSync(hookPath, installed.replaceAll(BIN, join(clone, "no-such-toolkit/bin.ts")), {mode: 0o755});
		try {
			// The transaction goes through — that IS fail-open, and it is why the announcement has to
			// be there: this update would otherwise pass for a guarded one.
			const result = spawnSync("git", ["update-ref", "refs/heads/trunk", divergent], {cwd: clone, encoding: "utf8"});
			expect(result.status).toBe(0);
			expect(result.stderr).toContain("THE GUARD IS NOT RUNNING");
			expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
		} finally {
			// Rewind BEFORE restoring the hook: putting trunk back is itself a backward move, which
			// the working guard refuses — correctly, which is the point of the test above it.
			execFileSync("git", ["update-ref", "refs/heads/trunk", base], {cwd: clone, stdio: "pipe"});
			writeFileSync(hookPath, installed, {mode: 0o755});
		}
	}, HOOK_TIMEOUT);

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
	}, HOOK_TIMEOUT);

	it("allows a raw primary fast-forward without a pipeline caller", () => {
		expect(() => execFileSync("git", ["update-ref", "refs/heads/trunk", remoteTip], {cwd: clone, stdio: "pipe"})).not.toThrow();
		expect(git(clone, "rev-parse", "refs/heads/trunk")).toBe(remoteTip);
	}, HOOK_TIMEOUT);
});
