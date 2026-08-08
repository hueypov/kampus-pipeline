/**
 * The `verdict` tool — `pipeline-cli verdict read` / `post` / `validate`.
 *
 * The SHA-bound verdict read/post glue, extracted from the inline `jq` the
 * `review-*` / `ship-it` / `write-code`-repair / `heal-ci` skills each hand-rolled (the originating work item).
 *
 * `read --pr N --gate <g> [--expect PASS|FAIL] [--head <sha>]` resolves the (PR, gate)
 * verdict against the PR's current head (author-gated to write+ collaborators, the runtime ACL authorization rule) and
 * **exits 0 only when HEAD is reviewed with the expected polarity** (default PASS) — every
 * refusal (`none`/`sha-less`/`stale`, or a current verdict of the wrong polarity) prints its
 * reason on stderr and exits non-zero, so a caller branches on exit status. The resolved
 * outcome is printed as JSON on stdout for a caller that wants the detail (comment id, sha).
 *
 * `post --pr N --gate <g> [--body-file <f>]` upserts a SHA-bound verdict comment (the SHA-bound, one-verdict-per-gate contract
 * rule 2): it reads the composed verdict body from `--body-file` (or stdin), refuses fail-closed
 * on any `emissionDefect` (wrong namespace, unbindable `@ <sha>`, or a non-full-40-hex/path-glued
 * SHA field), then PATCHes our own prior marker in the namespace if one exists, else POSTs —
 * exactly one verdict comment per (PR, gate). It then re-fetches the landed comment and re-runs
 * `emissionDefect` on its body (the folded-in self-verify, the originating work item), failing non-zero if the marker
 * didn't land clean rather than reporting a false success. It prints `patched <id>` / `posted <id>`.
 *
 * `validate --gate <g> [--body-file <f>]` runs that same `emissionDefect` gate WITHOUT posting —
 * the read-back assertion an emit path (review-code's native `APPROVE`) runs before a channel
 * `post` can't guard, exiting non-zero on a malformed marker (the mktemp-path leak, the originating work item).
 *
 * `GithubLive` is baked in with `Command.provide(...)` so the registered command's residual
 * requirement is the Node platform union (the registry seam, the originating initiative).
 */
import {readFileSync} from "node:fs";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {readClassificationPolicy, repositoryRoot} from "../class-probe/policy.ts";
import {namespaceCheck} from "../ship-it/preconditions.ts";
import {GithubTrackerLive, Tracker} from "../tracker/tracker.ts";
import * as Exit from "../../exit-codes.ts";
import {Github, GithubLive} from "./github.ts";
import {
	emissionDefect,
	GATES,
	nextRounds,
	outcomeReason,
	parseVerdict,
	type Polarity,
	roundsOf,
	type VerdictGate,
	withRounds,
} from "./verdict-match.ts";

const FAIL_EXIT_CODE = 1;

const prFlag = Flag.integer("pr").pipe(Flag.withDescription("the pull request number"));

const gateFlag = Flag.string("gate").pipe(
	Flag.withDescription(`the gate namespace: one of ${GATES.join(" | ")} (review-<gate>)`),
);

const headFlag = Flag.string("head").pipe(
	Flag.optional,
	Flag.withDescription(
		"override the head SHA to bind against (default: the PR's current head via REST)",
	),
);

const expectFlag = Flag.string("expect").pipe(
	Flag.optional,
	Flag.withDescription("the polarity a `read` treats as satisfied: PASS (default) or FAIL"),
);

const bodyFileFlag = Flag.string("body-file").pipe(
	Flag.optional,
	Flag.withDescription("path to the composed verdict body (default: read the body from stdin)"),
);

/** Print `reason` on stderr and exit non-zero — the "not satisfied / bad input" signal a caller branches on. */
const fail = (reason: string): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`verdict: ${reason}\n`);
		process.exit(FAIL_EXIT_CODE);
	});

const parseGate = (raw: string): Effect.Effect<VerdictGate, never> => {
	const supplied = raw.trim().toLowerCase();
	const gate = supplied.startsWith("review-") ? supplied.slice("review-".length) : supplied;
	return (GATES as ReadonlyArray<string>).includes(gate)
		? Effect.succeed(gate as VerdictGate)
		: fail(`unknown gate '${raw}' — expected one of ${GATES.join(" | ")} or its review-* namespace`);
};

const parseExpect = (raw: Option.Option<string>): Effect.Effect<Polarity, never> => {
	const value = Option.getOrElse(raw, () => "PASS")
		.trim()
		.toUpperCase();
	if (value === "PASS" || value === "FAIL") return Effect.succeed(value);
	return fail(`invalid --expect '${Option.getOrElse(raw, () => "")}' — expected PASS or FAIL`);
};

const read = Command.make(
	"read",
	{pr: prFlag, gate: gateFlag, head: headFlag, expect: expectFlag},
	Effect.fn(function* ({pr, gate, head, expect}) {
		const g = yield* parseGate(gate);
		const polarity = yield* parseExpect(expect);
		const result = yield* (yield* Github).read(pr, g, polarity, Option.getOrUndefined(head));
		// The resolved detail goes to stdout as JSON (a caller may want the comment id / bound sha);
		// the human-readable verdict + refusal reason goes to stderr, mirroring resume-policy.
		yield* Console.log(JSON.stringify({...result.outcome, headSha: result.headSha, gate: g}));
		if (result.satisfied) {
			process.stderr.write(`verdict: ${outcomeReason(result.outcome, polarity)}\n`);
			return;
		}
		return yield* fail(outcomeReason(result.outcome, polarity));
	}),
).pipe(
	Command.withDescription(
		"Resolve a PR's SHA-bound gate verdict against its current head (exit 0 = reviewed with --expect polarity)",
	),
);

const readBody = (bodyFile: Option.Option<string>): Effect.Effect<string, never> =>
	Effect.sync(() =>
		Option.match(bodyFile, {
			onNone: () => readFileSync(0, "utf8"),
			onSome: (path) => readFileSync(path, "utf8"),
		}),
	);

/**
 * The reviewing identity, compared against the PR's author. Defaults to the session id, falling
 * back to the authenticated login when no session is set.
 */
const asFlag = Flag.string("as").pipe(
	Flag.optional,
	Flag.withDescription(
		"the reviewing identity, compared against the PR's author (default: $CLAUDE_CODE_SESSION_ID)",
	),
);



/** Refuse a self-verdict with its own exit code, so it is never confused with a malformed body. */
/**
 * Refuse a verdict in a namespace this diff does not classify to.
 *
 * A verdict is a gate artifact, and a gate the diff does not require is one nothing will read. The
 * damage is not that the stray verdict is ignored — it is that the REQUIRED gate stays unmet while
 * the reviewer believes it reviewed. Two of this repository's own merges went that way: skill diffs
 * carrying a `review-code` PASS, with the missing `review-skill` invisible because the merge gate
 * was separately deriving its scope from the verdicts that existed (#60).
 *
 * `ship-it` catches this at the merge. Catching it here is better: the reviewer learns while it
 * still has the diff in hand, and the stray verdict never enters the record.
 */
const refuseWrongNamespace = (
	pr: number,
	gate: VerdictGate,
	required: ReadonlyArray<VerdictGate>,
): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(
			`verdict post: #${pr} classifies to ${required.map((g) => `review-${g}`).join(", ")}, not review-${gate} — a verdict in a namespace the diff does not require leaves the one it does require unmet\n`,
		);
		process.exit(Exit.ZERO_SCOPE);
	});

const refuseSelfVerdict = (pr: number): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(
			`verdict post: #${pr} was authored by this identity — an author may not post a verdict on their own work\n`,
		);
		process.exit(Exit.REFUSED_POLICY);
	});

const post = Command.make(
	"post",
	{pr: prFlag, gate: gateFlag, bodyFile: bodyFileFlag, as: asFlag},
	Effect.fn(function* ({pr, gate, bodyFile, as}) {
		const g = yield* parseGate(gate);
		const body = (yield* readBody(bodyFile)).replace(/\s+$/, "");
		if (body.length === 0) {
			return yield* fail(
				"empty verdict body — nothing to post (pass --body-file or pipe the body on stdin)",
			);
		}
		// The split-role firewall, enforced rather than asked for. It was prose in write-code and
		// prose in the reviewer skills, and two documents agreeing not to cross a line is a
		// convention. Comparing the posting identity against the PR's author is a boundary.
		//
		// An UNRESOLVABLE identity refuses rather than allows: that is exactly the state a caller
		// trying to grade its own work would produce, so the failure has to fall closed.
		const reviewer = Option.getOrElse(as, () => process.env.CLAUDE_CODE_SESSION_ID ?? "").trim();
		// A read that fails resolves to the empty string, which routes into the fail-closed branch
		// below rather than silently permitting the post.
		const unresolved = Effect.succeed("");
		const author = yield* (yield* Tracker).readPullRequest(pr).pipe(
			Effect.map((r) => r.author),
			Effect.catchTags({
				"@kampus/gh-io/GhCommandError": () => unresolved,
				"@kampus/gh-io/GhParseError": () => unresolved,
				"@kampus/gh-io/RepoResolutionError": () => unresolved,
			}),
		);
		if (reviewer === "" || author === "" || reviewer.toLowerCase() === author.toLowerCase()) {
			if (reviewer !== "" && author !== "") return yield* refuseSelfVerdict(pr);
			return yield* fail(
				`cannot resolve the reviewing identity or #${pr}'s author — refusing rather than posting an ungated verdict`,
			);
		}
		// The namespace must be one the diff actually requires. Deliberately AFTER the split-role
		// check, because who is posting matters more than where.
		//
		// A classification that cannot be made warns and allows, rather than refusing. This is not
		// the last line of defence — `ship-it` re-derives the same scope at the merge and refuses
		// there — and blocking every review on an unreadable classification would stop all work to
		// prevent something already caught downstream.
		const changed = yield* (yield* Tracker).listPrFiles(pr).pipe(
			Effect.catchTags({
				"@kampus/gh-io/GhCommandError": () => Effect.succeed([] as ReadonlyArray<string>),
				"@kampus/gh-io/GhParseError": () => Effect.succeed([] as ReadonlyArray<string>),
				"@kampus/gh-io/RepoResolutionError": () => Effect.succeed([] as ReadonlyArray<string>),
				SchemaError: () => Effect.succeed([] as ReadonlyArray<string>),
			}),
		);
		const root = repositoryRoot();
		const policy = root === null ? null : readClassificationPolicy(root, null);
		// The policy passes through nullable — NEVER defaulted to the fail-closed classify-everything
		// policy, which contains every gate and turns this refusal guard fail-open (its first live
		// probe posted a design verdict on a code diff from a policy-less worktree that way).
		const scope = namespaceCheck(g, changed, policy?.policy ?? null);
		if (scope._tag === "refused") return yield* refuseWrongNamespace(pr, g, scope.required);
		if (scope._tag === "unchecked") {
			// Said aloud rather than skipped silently — a check that did not run must never read as
			// one that passed. ship-it re-derives this scope at the merge and refuses there.
			yield* Console.error(
				`verdict post: #${pr}'s namespace check did NOT run (no readable policy or file list from ${root ?? "an unresolved root"}) — ship-it re-derives this at the merge`,
			);
		}

		// Carry the repair-round count across the upsert. Counting FAIL markers cannot work: one
		// verdict per gate is upserted, so the FAIL a repair answered is destroyed by the PASS that
		// follows it (#21). The count lives in the surviving marker and the verb maintains it, so a
		// reviewer never has to track state it has no way to read.
		const parsed = parseVerdict(body, g);
		const prior = roundsOf(
			(yield* (yield* Tracker).listComments(pr).pipe(
				Effect.catchTags({
					"@kampus/gh-io/GhCommandError": () => Effect.succeed([]),
					"@kampus/gh-io/GhParseError": () => Effect.succeed([]),
					"@kampus/gh-io/RepoResolutionError": () => Effect.succeed([]),
				}),
			)).find((c) => parseVerdict(c.body, g) !== null)?.body ?? "",
		);
		const counted = parsed
			? withRounds(body, nextRounds(prior, parsed.polarity))
			: body;
		const result = yield* (yield* Github).post(pr, g, counted).pipe(
			Effect.catchTag("@kampus/verdict/VerdictInputError", (error) => fail(error.message)),
			// The landed-comment self-verify (the originating work item): a body that passed the input gate but did not
			// land as a clean in-namespace, leak-free marker fails the post — never a false success.
			Effect.catchTag("@kampus/verdict/VerdictVerifyError", (error) => fail(error.message)),
		);
		yield* Console.log(`${result._tag} ${result.commentId}`);
	}),
).pipe(
	Command.withDescription(
		"Upsert a SHA-bound verdict comment for a PR gate (PATCH own prior marker, else POST — one per gate, the SHA-bound, one-verdict-per-gate contract rule 2)",
	),
);

/**
 * `validate --gate <g> [--body-file <f>]` — the read-back assertion a marker-emit path runs on a
 * composed body BEFORE posting it through a channel `post` can't guard (review-code's native
 * `APPROVE` review). It runs the SAME `emissionDefect` gate `post` enforces and exits non-zero on
 * any defect — so a malformed `@ <sha>` (the mktemp-path leak, the originating work item) fails loud at emission rather
 * than landing in a public comment. Does no IO: pure body-shape validation, so it needs no `Github`.
 */
const validate = Command.make(
	"validate",
	{gate: gateFlag, bodyFile: bodyFileFlag},
	Effect.fn(function* ({gate, bodyFile}) {
		const g = yield* parseGate(gate);
		const body = (yield* readBody(bodyFile)).replace(/\s+$/, "");
		if (body.length === 0) {
			return yield* fail(
				"empty verdict body — nothing to validate (pass --body-file or pipe on stdin)",
			);
		}
		const defect = emissionDefect(body, g);
		if (defect !== null) return yield* fail(defect);
		yield* Console.log("ok");
	}),
).pipe(
	Command.withDescription(
		"Assert a composed verdict body is postable (clean full-40-hex @ <sha>, right namespace) — exit 0 = ok, non-zero = malformed",
	),
);

export const verdictCommand = Command.make("verdict").pipe(
	Command.withSubcommands([read, post, validate]),
	Command.withDescription(
		"Read/post the SHA-bound, one-verdict-per-gate contract SHA-bound gate verdicts (review-code/doc/skill/design) — the shared verdict-match glue",
	),
	Command.provide(GithubLive),
	Command.provide(GithubTrackerLive),
);
