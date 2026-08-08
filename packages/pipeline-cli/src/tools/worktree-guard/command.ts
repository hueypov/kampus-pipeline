/**
 * The `worktree-guard` tool — `pipeline-cli worktree-guard <pre-file|pre-bash|pre-enter|reap>`.
 *
 * The worktree-pinning hook surface for an `isolation:worktree` subagent (issue
 * the originating work item), moved into the pipeline-cli registry (the originating initiative, Phase 2 / the originating work item). The four
 * hook subcommands each read the hook's stdin JSON envelope, run a pure core, and
 * emit the matching hook output; a fifth (`assert-clean`, the originating work item) is an operator/skill
 * invocation — not a hook — that fails closed on a dirty worktree.
 *
 * The root each PreToolUse subcommand acts on is RESOLVED, not read: `$WORKTREE_ROOT` first, then
 * the agent's own meta sidecar, then the payload cwd's linked worktree — see `arm.ts` for why an
 * env var a harness may omit cannot be the only signal (#141). Whichever way it lands, every hook
 * emits its arm status on stderr before deciding, so an unarmable guard is visible from outside
 * instead of looking like a clean pass. A root that resolves from none of the signals still makes
 * every subcommand a clean allow/skip no-op, so a non-worktree session is never affected — with
 * ONE exception (the expected-worktree isolation fail-closed rule): `pre-bash` still refuses a head-moving git
 * op when isolation was EXPECTED (a direct coder/reviewer/shipper agent-type, or a nested
 * crew spawn detected via `git-dir == git-common-dir`; the originating work item) yet the root is unset, because
 * that unset root is itself the documented failure harness no-op that would otherwise let the documented failure/the originating work item
 * primary-checkout detach through.
 *
 *   PreToolUse:
 *     pre-file  (matcher Read|Edit|Write) — rewrite/block a main-checkout path
 *     pre-bash  (matcher Bash)            — pin cwd to $WORKTREE_ROOT
 *     pre-enter (matcher EnterWorktree)   — hard-block a nested worktree
 *   SubagentStop:
 *     reap                                — `git worktree remove` (no --force) when clean AND the
 *                                           stopping agent OWNS $WORKTREE_ROOT (the documented failure owner gate)
 *   Skill/operator invocation (not a hook):
 *     assert-clean [--path <d>]           — fail closed LOUD if the tree is dirty (the originating work item)
 *
 * The handlers are byte-identical to the former package's `bin.run.ts`. Its thin
 * `bin.ts` the originating work item stale-tree shim (a dynamic import gated on a dep-resolution probe)
 * is dropped: the `pipeline-cli` bin imports `@effect/platform-node` statically, so
 * by the time a subcommand runs the runtime dep is always resolved.
 *
 * The sync git/fs probe helpers below are best-effort by contract: a hook must never
 * crash on a git/fs hiccup, so every probe degrades to a SAFE fallback (allow / keep /
 * dirty), absorbing the failure into a returned value rather than the `E` channel. That
 * is why each carries a per-line `biome-ignore lint/plugin` — lifting them into
 * `Effect.try` only to re-collapse the error to the same fallback is noise, not the
 * failure-modeling `no-raw-try-catch` targets (the design-capture/upload.ts precedent).
 */
import {execFileSync} from "node:child_process";
import {existsSync, readFileSync, statSync} from "node:fs";
import {resolve} from "node:path";
import {Console, Effect, Option} from "effect";
import * as Schema from "effect/Schema";
import {Command, Flag} from "effect/unstable/cli";
import {formatArmStatus, resolveArm} from "./arm.ts";
import {isIsolationExpected, pinBash} from "./bash-pin.ts";
import {decideCleanTree} from "./clean-tree.ts";
import {guardEnterWorktree} from "./enter-guard.ts";
import {mainCheckoutPrefix, resolvePath} from "./path-resolve.ts";
import {decideReap} from "./reap.ts";

const GATE_FAIL_EXIT_CODE = 1;

const WORKTREE_ROOT = process.env.WORKTREE_ROOT ?? "";

// Is this run sitting on the PRIMARY checkout, and if not, which linked worktree is the cwd in?
// Env-independent signal (see the expected-worktree isolation fail-closed rule amendment,
// the originating work item): `git rev-parse --absolute-git-dir` equals the (cwd-resolved) `--git-common-dir` on the
// primary checkout, but differs in a linked worktree (whose per-tree git dir is
// `.git/worktrees/<id>`) — the same signal write-code Step-4 uses. This corroborates the isolation
// gate for a NESTED crew spawn whose inherited $CLAUDE_CODE_AGENT (engineering-manager) masks the
// direct agent-type regex, and doubles as the last-resort root derivation (#141). Resolved against
// the hook's reported cwd; unknowable ⇒ not-primary, no derived root (degrade to today's allow,
// never a spurious refusal).
//
// `linkedWorktreeTop` is derived ONLY from a cwd the PAYLOAD named: the hook process's own cwd is
// unreliable by construction — the worktree-agent cwd reset is the hazard this guard exists for —
// so seeding a root from it would invent a target (path-resolve's rule).
const probeCwdGit = (
	cwd: string,
): {readonly onPrimaryCheckout: boolean; readonly linkedWorktreeTop: string} => {
	const base = cwd || process.cwd();
	// biome-ignore lint/plugin: best-effort probe — an unknowable git dir degrades to not-primary with no derived root, never E (see file header).
	try {
		const opts = {cwd: base, encoding: "utf8" as const};
		const gitDir = resolve(
			base,
			execFileSync("git", ["rev-parse", "--absolute-git-dir"], opts).trim(),
		);
		const commonDir = resolve(
			base,
			execFileSync("git", ["rev-parse", "--git-common-dir"], opts).trim(),
		);
		if (gitDir === commonDir) return {onPrimaryCheckout: true, linkedWorktreeTop: ""};
		return {
			onPrimaryCheckout: false,
			linkedWorktreeTop: cwd
				? execFileSync("git", ["rev-parse", "--show-toplevel"], opts).trim()
				: "",
		};
	} catch {
		return {onPrimaryCheckout: false, linkedWorktreeTop: ""};
	}
};

// A non-force `git worktree remove` that errors means git judged the tree unsafe to
// remove — we KEEP it (never escalate to --force). Tagged so the error channel stays typed.
class RemoveRefused extends Schema.TaggedErrorClass<RemoveRefused>()("RemoveRefused", {
	path: Schema.String,
}) {}

/** A stdin read that rejected — absorbed to the `{}` envelope so a hook never crashes on it. */
class StdinUnreadable extends Schema.TaggedErrorClass<StdinUnreadable>()("StdinUnreadable", {
	cause: Schema.Unknown,
}) {}

const readStdin = (): Effect.Effect<unknown> =>
	Effect.tryPromise({
		try: async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
			const raw = Buffer.concat(chunks).toString("utf8").trim();
			if (raw === "") return {};
			// biome-ignore lint/plugin: best-effort parse — a malformed stdin envelope degrades to {} (no fields), never E (see file header).
			try {
				return JSON.parse(raw) as unknown;
			} catch {
				return {};
			}
		},
		catch: (cause) => new StdinUnreadable({cause}),
	}).pipe(Effect.orElseSucceed(() => ({})));

const field = (obj: unknown, ...path: string[]): unknown => {
	let cur: unknown = obj;
	for (const key of path) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Read the running agent's own meta sidecar out of any hook payload. The harness writes one next
 * to each subagent transcript (`…/subagents/agent-<id>.meta.json`) recording the worktree that
 * agent OWNS (`worktreePath`) and the agent type it was actually spawned as (`agentType`), and
 * every hook envelope's `transcript_path` points at that transcript.
 *
 * Both fields are the env-independent truth the guard needs: `worktreePath` arms the guard when a
 * harness omits `$WORKTREE_ROOT` (#141), and `agentType` is the agent's REAL type where the
 * inherited `$CLAUDE_CODE_AGENT` reports its parent's (a coder spawned under the crew reads
 * `engineering-manager`, which is what makes the isolation gate go inert for a nested spawn).
 *
 * Anything unreadable ⇒ empty strings ⇒ the caller degrades to the env-only behaviour.
 */
const readAgentMeta = (
	input: unknown,
): {readonly worktreePath: string; readonly agentType: string} => {
	const empty = {worktreePath: "", agentType: ""};
	const transcriptPath = str(field(input, "transcript_path"));
	if (!transcriptPath) return empty;
	const metaPath = transcriptPath.replace(/\.jsonl$/, ".meta.json");
	if (metaPath === transcriptPath || !existsSync(metaPath)) return empty;
	// biome-ignore lint/plugin: best-effort read — an unreadable/malformed sidecar degrades to empty (env-only behaviour), never E (see file header).
	try {
		const meta = JSON.parse(readFileSync(metaPath, "utf8")) as unknown;
		return {
			worktreePath: str(field(meta, "worktreePath")),
			agentType: str(field(meta, "agentType")),
		};
	} catch {
		return empty;
	}
};

/**
 * Everything a PreToolUse subcommand needs before it decides: the root it will act on (or "" when
 * the guard could not arm), whether isolation was expected, and the one-line status to report.
 */
const armPreToolUse = (
	subcommand: string,
	input: unknown,
): {readonly root: string; readonly isolationExpected: boolean; readonly status: string} => {
	const meta = readAgentMeta(input);
	const git = probeCwdGit(str(field(input, "cwd")));
	const arm = resolveArm({
		envRoot: WORKTREE_ROOT,
		sidecarWorktree: meta.worktreePath,
		cwdWorktree: git.linkedWorktreeTop,
	});
	const isolationExpected = isIsolationExpected({
		agentType: meta.agentType || (process.env.CLAUDE_CODE_AGENT ?? ""),
		onPrimaryCheckout: git.onPrimaryCheckout,
	});
	return {
		root: arm.kind === "armed" ? arm.root : "",
		isolationExpected,
		status: formatArmStatus({subcommand, arm, isolationExpected}),
	};
};

const allow = (updatedInput?: Record<string, unknown>, systemMessage?: string) =>
	Console.log(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				...(updatedInput ? {updatedInput} : {}),
			},
			...(systemMessage ? {systemMessage} : {}),
		}),
	);

const deny = (reason: string) =>
	Console.log(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: reason,
			},
			systemMessage: reason,
		}),
	);

const preFile = Command.make(
	"pre-file",
	{},
	Effect.fn(function* () {
		const input = yield* readStdin();
		const toolInput = (field(input, "tool_input") as Record<string, unknown>) ?? {};
		const candidate = str(toolInput.file_path);
		const cwd = str(field(input, "cwd"));
		const {root, status} = armPreToolUse("pre-file", input);
		yield* Console.error(status);
		const decision = resolvePath({
			worktreeRoot: root,
			cwd,
			candidatePath: candidate,
			existsInWorktree: (p) => {
				// biome-ignore lint/plugin: best-effort probe — an unstattable path degrades to false (absent), never E (see file header).
				try {
					return existsSync(p);
				} catch {
					return false;
				}
			},
		});
		switch (decision.kind) {
			case "allow":
				return yield* allow();
			case "rewrite":
				return yield* allow(
					{...toolInput, file_path: decision.absolutePath},
					`worktree-guard: rewrote file_path → ${decision.absolutePath} (${decision.reason})`,
				);
			case "block":
				return yield* deny(`worktree-guard: ${decision.reason}. Use: ${decision.corrected}`);
		}
	}),
).pipe(Command.withDescription("PreToolUse Read|Edit|Write: pin/rewrite paths to $WORKTREE_ROOT"));

const preBash = Command.make(
	"pre-bash",
	{},
	Effect.fn(function* () {
		const input = yield* readStdin();
		const toolInput = (field(input, "tool_input") as Record<string, unknown>) ?? {};
		const command = str(toolInput.command);
		const {root, isolationExpected, status} = armPreToolUse("pre-bash", input);
		yield* Console.error(status);
		const decision = pinBash({worktreeRoot: root, command, isolationExpected});
		if (decision.kind === "allow") return yield* allow();
		if (decision.kind === "refuse") return yield* deny(`worktree-guard: ${decision.reason}`);
		return yield* allow(
			{...toolInput, command: decision.command},
			`worktree-guard: ${decision.reason}`,
		);
	}),
).pipe(
	Command.withDescription(
		"PreToolUse Bash: cd-pin to $WORKTREE_ROOT; refuse a bare working-state-mutating git op — checkout/switch/reset/rebase/stash/merge (#1571, #2030)",
	),
);

const preEnter = Command.make(
	"pre-enter",
	{},
	Effect.fn(function* () {
		const input = yield* readStdin();
		const {root, status} = armPreToolUse("pre-enter", input);
		yield* Console.error(status);
		// A non-managed `$WORKTREE_ROOT` disarms the guard but must still block nesting: this hook's
		// question is "am I already inside SOME worktree", which any non-empty root answers.
		const decision = guardEnterWorktree(WORKTREE_ROOT.trim() !== "" ? WORKTREE_ROOT : root);
		if (decision.kind === "allow") return yield* allow();
		return yield* deny(`worktree-guard: ${decision.reason}`);
	}),
).pipe(
	Command.withDescription("PreToolUse EnterWorktree: hard-block when already inside a worktree"),
);

/** Is the worktree dirty? `git status --porcelain` non-empty ⇒ dirty (also dirty if we can't tell — fail-safe to KEEP). */
const worktreeIsDirty = (root: string): boolean => {
	// biome-ignore lint/plugin: best-effort probe — an indeterminate status degrades to dirty (never reap), never E (see file header).
	try {
		const out = execFileSync("git", ["-C", root, "status", "--porcelain"], {
			encoding: "utf8",
		});
		return out.trim() !== "";
	} catch {
		// Can't determine status → treat as dirty so we never reap an indeterminate tree.
		return true;
	}
};

const reap = Command.make(
	"reap",
	{},
	Effect.fn(function* () {
		const input = yield* readStdin();
		// The reaper's root stays ENV-ONLY, deliberately. Its owner gate compares the INHERITED
		// `$WORKTREE_ROOT` against the sidecar's `worktreePath`, so deriving the root from that same
		// sidecar would compare a value with itself and pass every nested-descendant stop — turning
		// the gate that keeps a live parent's worktree alive into a no-op. The status line below is
		// what #141 asks of this entry point; the derivation is not.
		yield* Console.error(
			formatArmStatus({
				subcommand: "reap",
				arm: resolveArm({envRoot: WORKTREE_ROOT, sidecarWorktree: "", cwdWorktree: ""}),
				isolationExpected: false,
			}),
		);
		if (!WORKTREE_ROOT || !existsSync(WORKTREE_ROOT)) {
			return yield* Console.error("worktree-guard reap: no $WORKTREE_ROOT to reap (skip)");
		}
		let dir = true;
		// biome-ignore lint/plugin: best-effort probe — an unstattable root degrades to not-a-directory (skip), never E (see file header).
		try {
			dir = statSync(WORKTREE_ROOT).isDirectory();
		} catch {
			dir = false;
		}
		if (!dir) {
			return yield* Console.error("worktree-guard reap: $WORKTREE_ROOT is not a directory (skip)");
		}
		const decision = decideReap({
			worktreeRoot: WORKTREE_ROOT,
			ownedWorktree: readAgentMeta(input).worktreePath,
			isDirty: worktreeIsDirty(WORKTREE_ROOT),
		});
		switch (decision.kind) {
			case "skip":
			case "refuse":
				return yield* Console.error(`worktree-guard reap: ${decision.reason} (${WORKTREE_ROOT})`);
			case "reap": {
				// No --force, by contract: a dirty tree would error here and be KEPT. Run the
				// remove with `-C` at the MAIN checkout — it owns the worktree list, and the
				// hook's own cwd is unreliable (it may be the main checkout or anywhere).
				const mainRoot = mainCheckoutPrefix(WORKTREE_ROOT) ?? WORKTREE_ROOT;
				return yield* Effect.try({
					try: () => {
						execFileSync("git", ["-C", mainRoot, "worktree", "remove", WORKTREE_ROOT], {
							encoding: "utf8",
						});
					},
					catch: () => new RemoveRefused({path: WORKTREE_ROOT}),
				}).pipe(
					Effect.matchEffect({
						onSuccess: () =>
							Console.error(`worktree-guard reap: reaped clean worktree ${WORKTREE_ROOT}`),
						// A non-force remove that errors means git judged it unsafe — KEEP, never escalate to --force.
						onFailure: () =>
							Console.error(
								`worktree-guard reap: \`git worktree remove\` refused ${WORKTREE_ROOT} — KEPT (never --force)`,
							),
					}),
				);
			}
		}
	}),
).pipe(
	Command.withDescription(
		"SubagentStop: reap a CLEAN worktree (git worktree remove, never --force)",
	),
);

const pathFlag = Flag.string("path").pipe(
	Flag.optional,
	Flag.withDescription("the worktree to assert clean (default: $WORKTREE_ROOT)"),
);

// Read `git status --porcelain` at a path; null when git cannot run there (not a repo, missing
// dir) — the null is the fail-closed signal decideCleanTree maps to DIRTY, never a false clean.
const readPorcelain = (path: string): string | null => {
	// biome-ignore lint/plugin: best-effort probe — a non-repo/missing dir degrades to null (decideCleanTree maps to DIRTY, fail-closed), never E (see file header).
	try {
		return execFileSync("git", ["-C", path, "status", "--porcelain"], {encoding: "utf8"});
	} catch {
		return null;
	}
};

const assertClean = Command.make(
	"assert-clean",
	{path: pathFlag},
	Effect.fn(function* ({path: pathOpt}) {
		const target = Option.getOrElse(pathOpt, () => WORKTREE_ROOT);
		if (!target) {
			yield* Console.error(
				"worktree-guard assert-clean: no target — pass --path or set $WORKTREE_ROOT.",
			);
			return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
		}
		const decision = decideCleanTree({path: target, porcelain: readPorcelain(target)});
		if (decision.kind === "clean") {
			return yield* Console.error(`worktree-guard assert-clean: ${decision.reason}`);
		}
		yield* Console.error(
			`worktree-guard assert-clean FAILED (fail-closed, LOUD): ${decision.reason}`,
		);
		return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
	}),
).pipe(
	Command.withDescription(
		"Assert a worktree is clean (git status --porcelain); fail-closed LOUD on a dirty fresh tree (#2666)",
	),
);

export const worktreeGuardCommand = Command.make("worktree-guard").pipe(
	Command.withSubcommands([preFile, preBash, preEnter, reap, assertClean]),
	Command.withDescription("Worktree-pinning PreToolUse hooks + a SubagentStop reaper (the originating work item)"),
);
