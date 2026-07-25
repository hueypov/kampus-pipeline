/**
 * Golden real-payload guard for the WorktreeCreate hook script (create-worktree.sh,
 * the originating work item/the worktree-creation provisioning hook) — retrofitted to the CAPTURED real payload per the captured-runtime-artifact rule (the originating work item).
 *
 * The handler is asserted against a committed golden fixture captured from a live spawn
 * (`__fixtures__/worktree-create.payload.golden.json`), never a hand-authored shape. the originating work item
 * shipped this hook built to an INFERRED `{ worktree_path, base_ref }` contract; the real
 * harness sends `{ session_id, transcript_path, cwd, prompt_id, agent_type, hook_event_name,
 * name }` and expects the path CONSTRUCTED as `<cwd>/.claude/worktrees/<name>`. The unit test
 * passed against the fabricated shape, so all three gates went green on a hook that fail-closed
 * on every spawn. These tests reproduce that catch: driving the golden payload through the
 * handler FAILS against the old `worktree_path` contract and passes only against the real one.
 *
 * As with command.hook.test.ts, this drives the REAL script against a REAL throwaway git repo.
 * The temp repo has NO lefthook config, so `git worktree add` here does NOT fire the example-repo
 * post-checkout `bootstrap-deps` install (that ~13s install, and the live 600s-budgeted harness
 * firing that motivates the whole hook, only reproduce on a real harness spawn). What IS
 * unit-testable is the script's PURE decision logic: stdin JSON parse → the path it constructs
 * from cwd+name → the git command it runs → the stdout path contract → the fail-closed exits.
 */
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {loadGoldenPayload, readGoldenFixture} from "../../golden-fixture.ts";

const SCRIPT = fileURLToPath(
	new URL(
		"../../../../../claude-plugins/kampus-pipeline/hooks/create-worktree.sh",
		import.meta.url,
	),
);

const GOLDEN = "__fixtures__/worktree-create.payload.golden.json";

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

describe("create-worktree.sh — WorktreeCreate hook against the golden real payload (#2936/the captured-runtime-artifact rule)", () => {
	let mainRepo: string;
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"});

	// Run the hook script with `payload` on stdin, cwd inside the repo — exactly as
	// Claude Code fires it. Never throws: a non-zero exit is captured, not raised.
	const run = (cwd: string, payload: string): RunResult => {
		try {
			const stdout = execFileSync("bash", [SCRIPT], {cwd, input: payload, encoding: "utf8"});
			return {code: 0, stdout, stderr: ""};
		} catch (e) {
			const err = e as {status?: number; stdout?: string; stderr?: string};
			return {code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? ""};
		}
	};

	// A payload with the GOLDEN captured shape but this run's cwd + name. The shape (which
	// keys exist) comes wholly from the committed fixture — the fabrication-proof property —
	// while cwd/name are the only per-run values a fixed fixture cannot pin (the temp repo
	// path is materialized here). If the handler ever regresses to reading `worktree_path`,
	// the golden shape (which has none) drives the failure.
	const goldenPayloadFor = (cwd: string, name: string): string => {
		const golden = loadGoldenPayload(import.meta.url, GOLDEN);
		return JSON.stringify({...golden, cwd, name});
	};

	beforeAll(() => {
		mainRepo = mkdtempSync(join(tmpdir(), "wtc-main-"));
		git(mainRepo, "init", "-q", "-b", "trunk");
		git(mainRepo, "config", "user.email", "t@t.t");
		git(mainRepo, "config", "user.name", "t");
		writeFileSync(join(mainRepo, "README.md"), "x");
		git(mainRepo, "add", ".");
		git(mainRepo, "commit", "-q", "-m", "init");
		// Exercise a non-`main` upstream branch: the hook must derive it from Git.
		git(mainRepo, "remote", "add", "origin", mainRepo);
		git(mainRepo, "fetch", "-q", "origin");
		git(mainRepo, "branch", "--set-upstream-to", "origin/trunk", "trunk");
	});

	afterAll(() => rmSync(mainRepo, {recursive: true, force: true}));

	// The the originating work item lesson, encoded as the contract: the captured payload has name+cwd and
	// NEITHER worktree_path NOR base_ref. Asserting against the committed fixture is what makes
	// "the documented contract is wrong" a red test rather than a green false-confidence.
	it("the golden fixture is the REAL captured shape — name+cwd, no worktree_path, no base_ref", () => {
		const p = loadGoldenPayload(import.meta.url, GOLDEN);
		for (const key of [
			"session_id",
			"transcript_path",
			"cwd",
			"prompt_id",
			"agent_type",
			"hook_event_name",
			"name",
		]) {
			assert.property(p, key, `WorktreeCreate payload must carry \`${key}\``);
		}
		assert.strictEqual(p.hook_event_name, "WorktreeCreate");
		assert.match(String(p.name), /^agent-[0-9a-f]+$/, "name is the `agent-<hex>` worktree id");
		assert.isTrue(String(p.cwd).startsWith("/"), "cwd is an absolute repo path");
		assert.notProperty(p, "worktree_path", "the real payload does NOT carry worktree_path (#2925)");
		assert.notProperty(p, "base_ref", "the real payload does NOT carry base_ref (#2925)");
	});

	// The the originating work item catch: driving the real payload constructs the path from cwd+name and prints
	// ONLY it. Against the OLD fabricated `worktree_path` handler this FAILS — the golden
	// payload has no worktree_path, so the old script fail-closes with a non-zero exit.
	it("constructs the path as <cwd>/.claude/worktrees/<name> and prints ONLY that path", () => {
		const name = "agent-deadbeef01";
		const expected = join(mainRepo, ".claude", "worktrees", name);
		const {code, stdout} = run(mainRepo, goldenPayloadFor(mainRepo, name));
		assert.strictEqual(code, 0, "the real payload must provision, not fail-close");
		assert.strictEqual(
			stdout.trim(),
			expected,
			"stdout must be ONLY the constructed worktree path",
		);
		assert.isTrue(existsSync(expected), "the worktree must actually be created");
		assert.isTrue(
			existsSync(join(expected, "README.md")),
			"the configured upstream tree must be checked out",
		);
	});

	it("parses correctly without jq (grep/sed fallback) — the same constructed path", () => {
		// Force the jq-less branch deterministically across OSes: run under `env -i` with a
		// PATH pointing at a bindir that has ONLY the tools the parse needs (bash + coreutils),
		// and crucially NO jq. The script parses under this PATH before it prepends the standard
		// toolchain dirs, so `command -v jq` genuinely misses and the grep/sed fallback runs.
		const bindir = mkdtempSync(join(tmpdir(), "wtc-nojq-bin-"));
		const which = (tool: string) =>
			execFileSync("bash", ["-lc", `command -v ${tool}`], {encoding: "utf8"}).trim();
		for (const tool of ["bash", "cat", "grep", "sed", "head", "git", "mkdir", "dirname", "printf"]) {
			try {
				symlinkSync(which(tool), join(bindir, tool));
			} catch {
				/* printf is often a shell builtin with no binary — the parse still works without it */
			}
		}
		const name = "agent-nojqfa11";
		const expected = join(mainRepo, ".claude", "worktrees", name);
		let stdout = "";
		let code = 0;
		try {
			stdout = execFileSync("bash", [SCRIPT], {
				cwd: mainRepo,
				input: goldenPayloadFor(mainRepo, name),
				encoding: "utf8",
				// env -i: PATH=bindir ONLY (jq-free — no /usr/bin, which carries jq on Linux) so
				// the parser deterministically takes the fallback while every required Git/core
				// utility is provided explicitly by this fixture.
				env: {PATH: bindir, HOME: mainRepo},
			});
		} catch (e) {
			const err = e as {status?: number; stdout?: string};
			code = err.status ?? 1;
			stdout = err.stdout ?? "";
		} finally {
			rmSync(bindir, {recursive: true, force: true});
		}
		assert.strictEqual(code, 0);
		assert.strictEqual(
			stdout.trim(),
			expected,
			"the jq-less fallback must construct the same path",
		);
		assert.isTrue(existsSync(expected));
	});

	it("fail-closes (non-zero) when name is absent — never a silent no-op", () => {
		const golden = loadGoldenPayload(import.meta.url, GOLDEN);
		const {name: _name, ...noName} = golden;
		const {code} = run(mainRepo, JSON.stringify({...noName, cwd: mainRepo}));
		assert.notStrictEqual(code, 0, "a payload with no name must be rejected");
	});

	it("fail-closes (non-zero) when cwd is absent — never a silent no-op", () => {
		const golden = loadGoldenPayload(import.meta.url, GOLDEN);
		const {cwd: _cwd, ...noCwd} = golden;
		const {code} = run(mainRepo, JSON.stringify({...noCwd, name: "agent-nocwd001"}));
		assert.notStrictEqual(code, 0, "a payload with no cwd must be rejected");
	});

	it("uses the current HEAD when a local repository has no remote", () => {
		// A generic local repository has no upstream to refresh, but remains a valid
		// source for an isolated checkout. The hook must not invent an `origin/main`.
		const bare = mkdtempSync(join(tmpdir(), "wtc-noorigin-"));
		git(bare, "init", "-q", "-b", "release");
		git(bare, "config", "user.email", "t@t.t");
		git(bare, "config", "user.name", "t");
		writeFileSync(join(bare, "README.md"), "x");
		git(bare, "add", ".");
		git(bare, "commit", "-q", "-m", "init");
		const name = "agent-localbase01";
		const expected = join(bare, ".claude", "worktrees", name);
		const {code, stdout} = run(bare, goldenPayloadFor(bare, name));
		assert.strictEqual(code, 0, "a local-only Git repository is supported");
		assert.strictEqual(stdout.trim(), expected);
		assert.isTrue(existsSync(join(expected, "README.md")));
		rmSync(bare, {recursive: true, force: true});
	});

	// Reproduce the stale-local-branch trap and prove the hook fetches the configured upstream.
	// A consumer whose cached upstream and local branch both predate a sibling lane's merge must
	// still base its new worktree on a tip that INCLUDES that merge — and must do so WITHOUT moving
	// the primary's local branch.
	it("fetches the configured upstream before branching without moving the local branch", () => {
		const originRepo = mkdtempSync(join(tmpdir(), "wtc-origin-"));
		git(originRepo, "init", "-q", "-b", "trunk");
		git(originRepo, "config", "user.email", "t@t.t");
		git(originRepo, "config", "user.name", "t");
		writeFileSync(join(originRepo, "README.md"), "x");
		git(originRepo, "add", ".");
		git(originRepo, "commit", "-q", "-m", "init");

		// Consumer tracks the non-default-named upstream at the init commit.
		const consumer = mkdtempSync(join(tmpdir(), "wtc-consumer-"));
		git(consumer, "init", "-q", "-b", "trunk");
		git(consumer, "config", "user.email", "t@t.t");
		git(consumer, "config", "user.name", "t");
		git(consumer, "remote", "add", "origin", originRepo);
		git(consumer, "fetch", "-q", "origin");
		git(consumer, "checkout", "-q", "-B", "trunk", "origin/trunk");
		const staleTip = git(consumer, "rev-parse", "trunk").trim();

		// A sibling lane merges to origin AFTER the consumer last fetched — the exact stale window.
		writeFileSync(join(originRepo, "sibling.txt"), "merged-by-sibling");
		git(originRepo, "add", ".");
		git(originRepo, "commit", "-q", "-m", "sibling merge");
		const freshTip = git(originRepo, "rev-parse", "HEAD").trim();

		const name = "agent-stale01";
		const expected = join(consumer, ".claude", "worktrees", name);
		const {code, stdout} = run(consumer, goldenPayloadFor(consumer, name));
		assert.strictEqual(code, 0, "the hook must provision, fetching fresh");
		assert.strictEqual(stdout.trim(), expected);

		const wtHead = git(expected, "rev-parse", "HEAD").trim();
		assert.strictEqual(
			wtHead,
			freshTip,
			"the worktree base must be the freshly fetched upstream tip, not the stale local branch",
		);
		assert.isTrue(
			existsSync(join(expected, "sibling.txt")),
			"the sibling's just-merged file must be present in the base",
		);
		assert.notStrictEqual(wtHead, staleTip, "the base must NOT be the pre-merge stale tip");

		// The load-bearing no-corruption constraint: the fetch advances only remote-tracking refs,
		// never the primary's local branch HEAD.
		const consumerLocalBranch = git(consumer, "rev-parse", "trunk").trim();
		assert.strictEqual(
			consumerLocalBranch,
			staleTip,
			"the hook must NOT move the primary's local branch — only remote-tracking refs",
		);

		rmSync(consumer, {recursive: true, force: true});
		rmSync(originRepo, {recursive: true, force: true});
	});

	// Guard the anti-fabrication invariant directly: the raw fixture bytes fed to the handler
	// must be the committed file's, so no future edit can quietly inline a fabricated payload.
	it("loads the payload from the committed fixture file, not an inline literal", () => {
		const raw = readGoldenFixture(import.meta.url, GOLDEN);
		assert.include(raw, '"hook_event_name": "WorktreeCreate"');
		assert.notInclude(
			raw,
			"worktree_path",
			"the committed fixture must not carry the fabricated field",
		);
	});
});
