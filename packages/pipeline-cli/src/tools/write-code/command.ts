/**
 * The `write-code` tool — the three verbs `skills/write-code/SKILL.md` calls.
 *
 * Implements the derived contract at
 * `claude-plugins/kampus-pipeline/skills/write-code/contract.md`.
 *
 * `open-pr` is the one that earns its place. `Fixes #N` is the only link three stages read, and
 * nothing checked it existed, resolved, or pointed at the claimed issue — so a PR opened without
 * it looked entirely normal until a merge closed nothing. Here the verb composes the reference and
 * verifies it against what actually landed.
 */
import {readFileSync} from "node:fs";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {GithubTrackerLive, Tracker} from "../tracker/tracker.ts";
import {capState, closesIssue, composePrBody, countFailRounds, rankCandidates} from "./pick.ts";

const DEFAULT_STAGE = "status:triaged";
const DEFAULT_CAP = 2;

const EXIT_REFUSED = 2;
const EXIT_EMPTY = 3;
const EXIT_READ_FAILED = 4;
const EXIT_NOT_OURS = 5;

const refuse = (verb: string, message: string, code: number): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`write-code ${verb}: ${message}\n`);
		process.exit(code);
	});

const readStdin = (): string => {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
};

// ── next ─────────────────────────────────────────────────────────────────────

const stageFlag = Flag.string("stage").pipe(
	Flag.withDefault(DEFAULT_STAGE),
	Flag.withDescription(`the lifecycle stage to pick from (default: ${DEFAULT_STAGE})`),
);
const readyForFlag = Flag.string("ready-for").pipe(
	Flag.withDefault("agent"),
	Flag.withDescription("the audience to pick: agent, human, or any (default: agent)"),
);
const limitFlag = Flag.integer("limit").pipe(
	Flag.withDefault(1),
	Flag.withDescription("how many candidates to print, best first (default: 1)"),
);

const next = Command.make(
	"next",
	{stage: stageFlag, readyFor: readyForFlag, limit: limitFlag},
	Effect.fn(function* ({stage, readyFor, limit}) {
		if (readyFor !== "agent" && readyFor !== "human" && readyFor !== "any") {
			return yield* refuse("next", "--ready-for must be agent, human, or any", EXIT_REFUSED);
		}
		const tracker = yield* Tracker;
		const rows = yield* tracker.listStage(stage);
		const ranked = rankCandidates({rows, readyFor});

		// A claim is a boundary, not a preference: a held issue is excluded rather than ranked
		// lower. Ownership is checked lazily down the ranked list so a long queue costs one read
		// per candidate actually considered, not one per candidate that exists.
		const free: Array<(typeof ranked)[number]> = [];
		for (const row of ranked) {
			if (free.length >= limit) break;
			const owner = yield* tracker.readBack(row.number);
			if (owner._tag !== "owned") free.push(row);
		}

		if (free.length === 0) {
			yield* Console.log("empty");
			return yield* Effect.sync(() => process.exit(EXIT_EMPTY));
		}
		yield* Console.log("pick");
		for (const r of free) {
			const band = r.labels.find((l) => /^p\d$/.test(l)) ?? "-";
			yield* Console.log(`#${r.number}\t${band}\t${r.title}`);
		}
	}),
).pipe(
	Command.withDescription(
		"Which issue to pick up: highest band, oldest, unclaimed, addressed to an agent. exit 3 = nothing pickable",
	),
);

// ── open-pr ──────────────────────────────────────────────────────────────────

const issueFlag = Flag.integer("issue").pipe(
	Flag.withDescription("the issue this PR closes; the closing reference is composed from it"),
);
const headFlag = Flag.string("head").pipe(Flag.withDescription("the branch carrying the work"));
const baseFlag = Flag.string("base").pipe(
	Flag.withDefault("main"),
	Flag.withDescription("the branch to merge into (default: main)"),
);
const titleFlag = Flag.string("title").pipe(Flag.withDescription("the pull request title"));
const draftFlag = Flag.boolean("draft").pipe(Flag.withDescription("open as a draft"));
const dryRunFlag = Flag.boolean("dry-run").pipe(
	Flag.withDescription("run the guards and print the composed body; open nothing"),
);
const sessionFlag = Flag.string("session").pipe(
	Flag.optional,
	Flag.withDescription("the claiming session id (default: $CLAUDE_CODE_SESSION_ID)"),
);

const openPr = Command.make(
	"open-pr",
	{
		issue: issueFlag,
		head: headFlag,
		base: baseFlag,
		title: titleFlag,
		draft: draftFlag,
		dryRun: dryRunFlag,
		session: sessionFlag,
	},
	Effect.fn(function* ({issue, head, base, title, draft, dryRun, session}) {
		const description = readStdin();
		if (description.trim() === "") {
			return yield* refuse("open-pr", "empty description on stdin", EXIT_REFUSED);
		}
		const tracker = yield* Tracker;

		// The claim check belongs at the write, not only at the pick: opening a PR against an issue
		// another session holds is how two builders land competing PRs for one ticket.
		const mine = Option.getOrElse(session, () => process.env.CLAUDE_CODE_SESSION_ID ?? "").trim();
		const owner = yield* tracker.readBack(issue);
		if (owner._tag === "owned" && owner.owner.session.toLowerCase() !== mine.toLowerCase()) {
			return yield* refuse(
				"open-pr",
				`#${issue} is claimed by session ${owner.owner.session}, not this one`,
				EXIT_NOT_OURS,
			);
		}

		const body = composePrBody(description, issue);
		if (dryRun) {
			yield* Console.log(body);
			process.stderr.write("write-code open-pr: dry-run — nothing opened\n");
			return;
		}

		const opened = yield* tracker.openPullRequest({head, base, title, body, draft});
		// Verify against what landed, unconditionally. This is the whole reason the verb exists.
		const landed = yield* tracker.readPullRequest(opened.pr);
		if (!closesIssue(landed.body, issue)) {
			return yield* refuse(
				"open-pr",
				`opened #${opened.pr} but its closing reference does not resolve to #${issue}`,
				EXIT_READ_FAILED,
			);
		}
		yield* Console.log(`write-code: opened #${opened.pr} — closes #${issue} — ${opened.url}`);
	}),
).pipe(
	Command.withDescription(
		"Open a PR that provably closes its issue: the closing reference is composed and verified against what landed",
	),
);

// ── rounds ───────────────────────────────────────────────────────────────────

const prFlag = Flag.integer("pr").pipe(
	Flag.withDescription("the pull request whose repair rounds to count"),
);
const gateFlag = Flag.string("gate").pipe(
	Flag.optional,
	Flag.withDescription("restrict the count to one gate namespace (code|doc|skill|design)"),
);
const capFlag = Flag.integer("cap").pipe(
	Flag.withDefault(DEFAULT_CAP),
	Flag.withDescription(`the repair-round cap (default: ${DEFAULT_CAP})`),
);

const rounds = Command.make(
	"rounds",
	{pr: prFlag, gate: gateFlag, cap: capFlag},
	Effect.fn(function* ({pr, gate, cap}) {
		const comments = yield* (yield* Tracker).listComments(pr);
		const n = countFailRounds(comments, Option.getOrUndefined(gate));
		const state = capState(n, cap);
		yield* Console.log(`rounds ${n} cap ${cap} ${state}`);
		if (state !== "under") {
			// Exit 3 is the escalation signal. A bound nobody counts is not a bound — without this
			// a directly-invoked run with no orchestrator can repair indefinitely.
			return yield* Effect.sync(() => process.exit(EXIT_EMPTY));
		}
	}),
).pipe(
	Command.withDescription(
		"How many repair rounds this PR has had against the cap. exit 3 = at or over — escalate, do not repair again",
	),
);

export const writeCodeCommand = Command.make("write-code").pipe(
	Command.withSubcommands([next, openPr, rounds]),
	Command.withDescription(
		"The execution verbs: pick the next issue, open a PR that provably closes it, and count repair rounds against the cap",
	),
	Command.provide(GithubTrackerLive),
);
