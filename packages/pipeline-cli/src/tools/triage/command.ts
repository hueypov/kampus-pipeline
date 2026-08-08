/**
 * The `triage` tool — the nine verbs `skills/triage/SKILL.md` calls.
 *
 * Implements the derived contract at
 * `claude-plugins/pipeline/skills/triage/contract.md`.
 *
 * The exit codes are the interface. Three of them exist because a wrong answer at this seam is
 * indistinguishable from a right one downstream:
 *
 *  - `claim` exits **3** when another session holds the issue. That is an expected, correct
 *    outcome during a concurrent sweep, so it must never share a code with a broken invocation.
 *  - `provenance` exits **3** for human and **5** for ambiguous, so a caller reading only stdout
 *    still cannot reach a close by accident.
 *  - `kill` re-resolves provenance itself and refuses on anything but `agent`. A protection that
 *    depends on the caller having run the check separately fails the first time somebody forgets.
 */
import {readFileSync} from "node:fs";
import {Console, Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {Github, GithubLive} from "../intake-dedup/github.ts";
import {redactLeaks} from "../redact-leaks/redact-leaks.ts";
import {GithubTrackerLive, Tracker} from "../tracker/tracker.ts";
import {checkEnrichInput, composeEnriched, preservedOriginal, provenanceOf} from "./body.ts";
import * as Exit from "../../exit-codes.ts";

const DEFAULT_STAGE = "status:needs-triage";


const refuse = (verb: string, message: string, code: number): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`triage ${verb}: ${message}\n`);
		process.exit(code);
	});

const readStdin = (): string => {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
};

const targetArg = Argument.integer("target").pipe(
	Argument.withDescription("the issue number the verb acts on"),
);

const sessionFlag = Flag.string("session").pipe(
	Flag.optional,
	Flag.withDescription("the claiming session id (default: $CLAUDE_CODE_SESSION_ID)"),
);

const resolveSession = (s: Option.Option<string>): string =>
	Option.getOrElse(s, () => process.env.CLAUDE_CODE_SESSION_ID ?? "").trim();

// ── queue ────────────────────────────────────────────────────────────────────

const stageFlag = Flag.string("stage").pipe(
	Flag.withDefault(DEFAULT_STAGE),
	Flag.withDescription(`the lifecycle stage to list (default: ${DEFAULT_STAGE})`),
);

const limitFlag = Flag.integer("limit").pipe(
	Flag.withDefault(50),
	Flag.withDescription("maximum issues to print (default: 50)"),
);

const queue = Command.make(
	"queue",
	{stage: stageFlag, limit: limitFlag},
	Effect.fn(function* ({stage, limit}) {
		const gh = yield* Github;
		const rows = yield* gh.queue(stage).pipe(
			// A failed read is UNKNOWN. Printing `empty` here would report "nothing left to triage"
			// while the backlog sits untouched — the one outcome this code exists to prevent.
			Effect.catchTags({
				"intake-dedup/GhCommandError": (e) =>
					refuse("queue", `could not read stage '${stage}' (gh exited ${e.exitCode}) — contents UNKNOWN`, Exit.PRECONDITION_UNKNOWN),
				"intake-dedup/GhParseError": (e) =>
					refuse("queue", `could not read stage '${stage}' (${e.message}) — contents UNKNOWN`, Exit.PRECONDITION_UNKNOWN),
				"intake-dedup/RepoResolutionError": () =>
					refuse("queue", "target repo unresolved — contents UNKNOWN", Exit.PRECONDITION_UNKNOWN),
			}),
		);
		if (rows.length === 0) {
			yield* Console.log("empty");
			return;
		}
		yield* Console.log("queue");
		for (const r of rows.slice(0, limit)) yield* Console.log(`#${r.number}\t${r.title}`);
	}),
).pipe(Command.withDescription("List what is waiting to be triaged; `empty` is the only result that ends a sweep"));

// ── claim / release ──────────────────────────────────────────────────────────

const claim = Command.make(
	"claim",
	{target: targetArg, session: sessionFlag},
	Effect.fn(function* ({target, session}) {
		const id = resolveSession(session);
		if (id === "") {
			return yield* refuse(
				"claim",
				"no session id (set $CLAUDE_CODE_SESSION_ID or pass --session) — refusing an indistinguishable claim",
				Exit.MALFORMED_INPUT,
			);
		}
		const result = yield* (yield* Tracker).claim(target, {session: id});
		switch (result._tag) {
			case "claimed":
				return yield* Console.log(`triage: claimed #${target} (session ${result.session}) — proceed.`);
			case "held-by-other":
				return yield* refuse(
					"claim",
					`#${target} is held by session ${result.owner.session} since ${result.owner.claimedAt} — back off, do not mutate`,
					Exit.HELD_BY_OTHER,
				);
			case "lost":
				return yield* refuse("claim", `lost the claim race on #${target} — back off, do not mutate`, Exit.HELD_BY_OTHER);
		}
	}),
).pipe(Command.withDescription("Take a sweep-scoped hold (exit 0 = ours; exit 6 = someone else's, back off)"));

const release = Command.make(
	"release",
	{target: targetArg, session: sessionFlag},
	Effect.fn(function* ({target, session}) {
		const id = resolveSession(session);
		if (id === "") return yield* refuse("release", "no session id — nothing to release", Exit.MALFORMED_INPUT);
		const result = yield* (yield* Tracker).releaseClaim(target, {session: id});
		yield* Console.log(`triage: released #${target} (${result.retracted} marker(s) retracted).`);
	}),
).pipe(
	Command.withDescription(
		"Drop this session's hold. Idempotent — releasing a hold we do not have is success, since the goal is that none is held",
	),
);

// ── provenance ───────────────────────────────────────────────────────────────

const provenance = Command.make(
	"provenance",
	{target: targetArg},
	Effect.fn(function* ({target}) {
		const issue = yield* (yield* Tracker).readIssue(target);
		const who = provenanceOf(issue.body);
		yield* Console.log(who);
		if (who === "human") {
			return yield* refuse("provenance", `#${target} is hand-filed — protected from closure`, Exit.REFUSED_POLICY);
		}
		if (who === "ambiguous") {
			return yield* refuse(
				"provenance",
				`#${target} carries an unreadable footer — treat as human`,
				Exit.PRECONDITION_UNKNOWN,
			);
		}
	}),
).pipe(
	Command.withDescription(
		"Was this filed by a human or an agent? Prints agent|human|ambiguous; exit 10 = human, 11 = ambiguous — both protected",
	),
);

// ── split ────────────────────────────────────────────────────────────────────

const titleFlag = Flag.string("title").pipe(Flag.withDescription("the child's single-unit title"));

const split = Command.make(
	"split",
	{target: targetArg, title: titleFlag},
	Effect.fn(function* ({target, title}) {
		const body = readStdin();
		if (body.trim() === "") return yield* refuse("split", "empty body on stdin — nothing to file", Exit.EMPTY_INPUT);
		const tracker = yield* Tracker;
		// The back-reference is composed here, not by the caller: it is the create-once key a retry
		// is recognised by, and a key only works when the thing that reads it also wrote it.
		const child = yield* tracker.createIssue({
			title,
			body: `split from #${target}\n\n${body.replace(/\s+$/, "")}\n`,
		});
		yield* Console.log(`triage: split #${target} -> created #${child.target} — ${child.url}`);
	}),
).pipe(Command.withDescription("File one child of a bundle, carrying the split-from back-reference; body on stdin"));

// ── enrich ───────────────────────────────────────────────────────────────────

const epicFlag = Flag.boolean("epic").pipe(
	Flag.withDescription("wrap the original in place under an epic header instead of rewriting above it"),
);
const redactFlag = Flag.boolean("redact").pipe(
	Flag.withDescription("mask machine-local paths in the preserved original rather than refusing"),
);
const dryRunFlag = Flag.boolean("dry-run").pipe(
	Flag.withDescription("compose and print the resulting body; write nothing"),
);

const enrich = Command.make(
	"enrich",
	{target: targetArg, epic: epicFlag, redact: redactFlag, dryRun: dryRunFlag},
	Effect.fn(function* ({target, epic, redact, dryRun}) {
		const rewrite = readStdin();
		const tracker = yield* Tracker;
		const current = yield* tracker.readIssue(target);

		const refusal = checkEnrichInput({current: current.body, rewrite, epic});
		if (refusal) return yield* refuse("enrich", refusal.message, refusal.code);

		const original = redact ? redactLeaks(current.body) : current.body;
		const composed = composeEnriched({original, rewrite, epic});

		if (dryRun) {
			yield* Console.log(composed);
			process.stderr.write("triage enrich: dry-run — nothing written\n");
			return;
		}

		const landed = yield* tracker.replaceBody(target, composed);
		// The round-trip proof: pull the original back out of what actually landed. A rewrite that
		// ate the original is otherwise silent — the caller sees a successful PATCH either way.
		const recovered = preservedOriginal(landed.body);
		if (recovered === null || recovered !== original.replace(/\s+$/, "")) {
			return yield* refuse(
				"enrich",
				`read-back on #${target} shows the original was not preserved`,
				Exit.READBACK_MISMATCH,
			);
		}
		yield* Console.log(`triage: enriched #${target} — original preserved (${recovered.length} bytes).`);
	}),
).pipe(
	Command.withDescription(
		"Replace the body, preserving the original beneath and proving it survived; rewrite on stdin",
	),
);

// ── apply ────────────────────────────────────────────────────────────────────

const typeFlag = Flag.string("type").pipe(Flag.withDescription("the classification: bug|feature|chore|decision|investigation|epic"));
const priorityFlag = Flag.string("priority").pipe(Flag.withDescription("the priority band"));
const readyForFlag = Flag.string("ready-for").pipe(
	Flag.withDefault("agent"),
	Flag.withDescription("who the work is addressed to: agent or human (default: agent)"),
);
const laneFlag = Flag.string("lane").pipe(
	Flag.optional,
	Flag.withDescription("a standing-lane label applied instead of a milestone"),
);
const statusFlag = Flag.string("status").pipe(
	Flag.optional,
	Flag.withDescription("the lifecycle stage to move to (default: triaged)"),
);

const apply = Command.make(
	"apply",
	{target: targetArg, type: typeFlag, priority: priorityFlag, readyFor: readyForFlag, lane: laneFlag, status: statusFlag},
	Effect.fn(function* ({target, type, priority, readyFor, lane, status}) {
		if (readyFor !== "agent" && readyFor !== "human") {
			return yield* refuse("apply", `--ready-for must be agent or human, got '${readyFor}'`, Exit.MALFORMED_INPUT);
		}
		const result = yield* (yield* Tracker).applyTriage(target, {
			type,
			priority,
			readyFor,
			...(Option.isSome(lane) ? {lane: lane.value} : {}),
			...(Option.isSome(status) ? {status: status.value} : {}),
		});
		yield* Console.log(
			`triage: #${target} — type:${result.type} ${result.priority} ready-for:${result.readyFor ?? "?"} stage:${result.status} lane:${result.lane ?? "none"}`,
		);
	}),
).pipe(Command.withDescription("Stamp the classification and leave the intake queue, reading back what landed"));

// ── park / kill ──────────────────────────────────────────────────────────────

const park = Command.make(
	"park",
	{target: targetArg},
	Effect.fn(function* ({target}) {
		const questions = readStdin();
		// Parking in silence is worse than leaving it queued: the issue stops resurfacing and
		// nobody knows what would unblock it.
		if (questions.trim() === "") {
			return yield* refuse("park", "empty body on stdin — parking without questions strands the issue", Exit.EMPTY_INPUT);
		}
		const tracker = yield* Tracker;
		yield* tracker.createComment(target, {body: questions});
		const result = yield* tracker.applyTriage(target, {
			type: "question",
			priority: "p2",
			status: "needs-info",
			readyFor: "human",
		});
		yield* Console.log(`triage: parked #${target} at ${result.status} — questions posted.`);
	}),
).pipe(Command.withDescription("Leave the queue awaiting a human's answer. Never closes, and no flag makes it"));

const confirmFlag = Flag.boolean("confirm").pipe(
	Flag.withDescription("your attestation that salvage was genuinely attempted"),
);
const duplicateOfFlag = Flag.integer("duplicate-of").pipe(
	Flag.optional,
	Flag.withDescription("the surviving issue this one duplicates; its content is folded there first"),
);

const kill = Command.make(
	"kill",
	{target: targetArg, confirm: confirmFlag, duplicateOf: duplicateOfFlag},
	Effect.fn(function* ({target, confirm, duplicateOf}) {
		if (!confirm) {
			return yield* refuse("kill", "--confirm is required — it attests salvage was attempted", Exit.MALFORMED_INPUT);
		}
		const reason = readStdin();
		if (reason.trim() === "") {
			return yield* refuse("kill", "empty reason on stdin — a kill with no audit trail is unreviewable", Exit.EMPTY_INPUT);
		}
		const tracker = yield* Tracker;
		const issue = yield* tracker.readIssue(target);
		// Re-resolved here rather than trusted from the caller: this is the only thing between a
		// person's issue and machine closure, and a check the caller may skip is not a protection.
		const who = provenanceOf(issue.body);
		if (who !== "agent") {
			return yield* refuse(
				"kill",
				`#${target} is ${who}-filed — park it instead; it may not be closed`,
				Exit.REFUSED_POLICY,
			);
		}
		if (Option.isSome(duplicateOf)) {
			// Fold strictly before closing. A close that lands first with a failed fold destroys the
			// content the fold existed to save.
			yield* tracker.createComment(duplicateOf.value, {
				body: `Folded from #${target}:\n\n${issue.body}`,
			});
			yield* Console.log(`triage: folded #${target} into #${duplicateOf.value}.`);
		}
		yield* tracker.createComment(target, {body: `closed-by-triage\n\n${reason.trim()}`});
		yield* tracker.closeNotPlanned(target);
		yield* Console.log(`triage: killed #${target} — closed not-planned.`);
	}),
).pipe(Command.withDescription("Close an agent filing not-planned, folding its content into a survivor first"));

export const triageCommand = Command.make("triage").pipe(
	Command.withSubcommands([queue, claim, release, provenance, split, enrich, apply, park, kill]),
	Command.withDescription(
		"The guardrail between raw intake and pickable work: claim, read, classify, enrich, and stamp one issue — or park it for a human, or kill it",
	),
	Command.provide(GithubLive),
	Command.provide(GithubTrackerLive),
);
