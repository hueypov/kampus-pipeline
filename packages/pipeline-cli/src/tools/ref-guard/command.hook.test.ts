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
 * cold Node start — `git stash push` fires several, and an 81-ref fetch fires 163. The generous
 * timeouts are headroom for that: measured, the hook costs about 2.4s per commit, the same as v2
 * did whenever v2 actually ran the guard. They are here because the default 5s fails on a loaded
 * machine, which reads as a broken guard rather than a busy one.
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
		// It DRAINS stdin before failing, which is the case the replay exists for and the one a
		// module-load crash cannot reach: the verb reads stdin first, so any later failure — an
		// exception, an OOM, a SIGKILL — leaves git's pipe empty for whoever runs next. A candidate
		// that dies at import time never touches the pipe, so it proves nothing about the replay.
		writeFileSync(join(broken, "bin.ts"), 'await new Response(process.stdin).text();\nprocess.exit(1);\n');
		try {
			// The refusal must still arrive, from the recorded candidate, and the ref must not move.
			expect(() => execFileSync("git", ["update-ref", "refs/heads/trunk", divergent], {cwd: clone, stdio: "pipe"})).toThrow();
			expect(git(clone, "rev-parse", "refs/heads/trunk")).toBe(base);
		} finally {
			rmSync(join(clone, "packages"), {recursive: true, force: true});
		}
	}, HOOK_TIMEOUT);

	/**
	 * The plant is an uninstalled dependency, not a quiet `exit 1`: #85's symptom is the trace
	 * itself, so a fixture that prints nothing measures the fixture. This one reproduces the
	 * reported condition — a real `ERR_MODULE_NOT_FOUND` on stderr, exit 1 — and the two cases below
	 * pin the two halves of the answer: held back when it explains nothing, released when it is the
	 * diagnosis.
	 */
	const plantUninstalledCandidate = (): string => {
		const dir = join(clone, "packages/pipeline-cli/src");
		mkdirSync(dir, {recursive: true});
		writeFileSync(join(dir, "bin.ts"), 'import "@kampus-pipeline/definitely-not-installed";\n');
		return join(clone, "packages");
	};

	it("withholds a crashing candidate's stack trace once a later candidate decides", () => {
		// #85's headline: the guard fail-opened BEHIND a stack trace. Trying candidates fixes the
		// fail-open, but with stderr inherited the trace still landed on every ref update — now
		// describing a copy the hook had already moved past, which is noise that teaches people to
		// ignore the channel the refusal also arrives on.
		const planted = plantUninstalledCandidate();
		try {
			const result = spawnSync("git", ["update-ref", "refs/heads/trunk", divergent], {cwd: clone, encoding: "utf8"});
			// The recorded candidate ran and refused, so the crashing one explained nothing.
			expect(result.status).not.toBe(0);
			expect(git(clone, "rev-parse", "refs/heads/trunk")).toBe(base);
			expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
			// The refusal's own stderr must survive the buffering — it is the whole point of refusing.
			expect(result.stderr).toContain("ref-guard:");
		} finally {
			rmSync(planted, {recursive: true, force: true});
		}
	}, HOOK_TIMEOUT);

	it("releases the buffered trace when no candidate decided", () => {
		const planted = plantUninstalledCandidate();
		const hookPath = join(clone, ".git/hooks/reference-transaction");
		const installed = readFileSync(hookPath, "utf8");
		writeFileSync(hookPath, installed.replaceAll(BIN, join(clone, "no-such-toolkit/bin.ts")), {mode: 0o755});
		try {
			const result = spawnSync("git", ["update-ref", "refs/heads/trunk", divergent], {cwd: clone, encoding: "utf8"});
			expect(result.status).toBe(0);
			// Nothing decided, so the trace is the only evidence of WHY — suppressing it here would
			// trade a misleading message for an unactionable one.
			expect(result.stderr).toContain("ERR_MODULE_NOT_FOUND");
			expect(result.stderr).toContain("THE GUARD IS NOT RUNNING");
		} finally {
			rmSync(planted, {recursive: true, force: true});
			// Rewind before restoring, for the reason spelled out in the case below.
			try {
				execFileSync("git", ["update-ref", "refs/heads/trunk", base], {cwd: clone, stdio: "pipe"});
			} finally {
				writeFileSync(hookPath, installed, {mode: 0o755});
			}
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
			// the working guard refuses — correctly, which is the point of the test above it. The
			// restore must happen even if the rewind fails, or a broken hook would outlive this case
			// and fail every later one for an unrelated reason.
			try {
				execFileSync("git", ["update-ref", "refs/heads/trunk", base], {cwd: clone, stdio: "pipe"});
			} finally {
				writeFileSync(hookPath, installed, {mode: 0o755});
			}
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

	it("creates a detached linked worktree from the primary checkout, and still refuses to detach the primary", () => {
		// `git worktree add --detach` writes the NEW worktree's HEAD, but runs in the primary's
		// context — identical stdin, cwd, env, and rev-parse answers to a real primary detach. The
		// guard used to read that context as "the shared checkout is being detached" and abort every
		// review worktree. Only a real hook invocation shows it, so this case has to drive real git.
		const review = join(root, "review");
		expect(() => execFileSync("git", ["worktree", "add", "--detach", "-q", review, base], {cwd: clone, stdio: "pipe"})).not.toThrow();
		expect(git(review, "rev-parse", "HEAD")).toBe(base);
		expect(git(clone, "symbolic-ref", "HEAD")).toBe("refs/heads/trunk");
		// The pair is the point: an allow-list widened until the worktree passes would also let this
		// through, and the shared checkout would be stranded off its branch.
		expect(() => execFileSync("git", ["checkout", "--detach", base], {cwd: clone, stdio: "pipe"})).toThrow();
		expect(git(clone, "symbolic-ref", "HEAD")).toBe("refs/heads/trunk");
		// The worktree lives under the suite's temp root, so afterAll's rmSync is the only cleanup.
		// The budget is double its neighbours': `worktree add` and the paired `checkout --detach`
		// each fire several transactions, and every one is a cold node start that loads the whole
		// CLI. Measured at 35s on a machine running the other suites beside it, against 30s here.
	}, 60_000);

	it("allows a raw primary fast-forward without a pipeline caller", () => {
		expect(() => execFileSync("git", ["update-ref", "refs/heads/trunk", remoteTip], {cwd: clone, stdio: "pipe"})).not.toThrow();
		expect(git(clone, "rev-parse", "refs/heads/trunk")).toBe(remoteTip);
	}, HOOK_TIMEOUT);
});
