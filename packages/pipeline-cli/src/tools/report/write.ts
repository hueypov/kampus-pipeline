/**
 * The write half of the `report` verbs: the two subcommands that mutate.
 *
 * Split from `command.ts` so the read-only `dedup` keeps its narrow dependency on the dedup
 * `Github` capability while these two take the `Tracker`, rather than every verb carrying both.
 *
 * Both guard first and write second. Every refusal in `./body.ts` runs before any request leaves
 * the process, which is what makes them refusals rather than cleanup — and both prove what landed
 * by reading it back, because a create that reports success while landing something else is
 * otherwise invisible to the caller.
 */
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {redactLeaks} from "../redact-leaks/redact-leaks.ts";
import {Tracker} from "../tracker/tracker.ts";
import {assembleBody, checkFileInput, checkNoteInput, composeFooter, hasFooter} from "./body.ts";
import * as Exit from "../../exit-codes.ts";



const refuse = (verb: string, message: string, code: number): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`report ${verb}: ${message}\n`);
		process.exit(code);
	});

/** stdin, or empty when the stream is absent or unreadable — an unread pipe reads as empty. */
const readStdin = (): string => {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
};

/**
 * Machine context for the footer, every field best-effort.
 *
 * `git` is consulted for the branch and a failure is swallowed: a filer outside a checkout still
 * files, it just files without that field. Nothing here reads identity — no `user.name`, no
 * `user.email` — because the footer is machine context and a shared artifact.
 */
const footerContext = () => {
	let branch: string | undefined;
	try {
		branch =
			execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || undefined;
	} catch {
		branch = undefined;
	}
	return {
		session: process.env.CLAUDE_CODE_SESSION_ID || undefined,
		model: process.env.CLAUDE_CODE_MODEL || undefined,
		branch,
		timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
	};
};

const redactFlag = Flag.boolean("redact").pipe(
	Flag.withDescription(
		"mask machine-local paths to their class instead of refusing — for when such a path is itself the evidence",
	),
);

const dryRunFlag = Flag.boolean("dry-run").pipe(
	Flag.withDescription("run every guard and print the composed body; write nothing"),
);

const titleFlag = Flag.string("title").pipe(
	Flag.withDescription("the issue title: specific, type-neutral, no classification prefix"),
);

const issueFlag = Flag.integer("issue").pipe(
	Flag.withDescription("the existing issue this observation belongs to"),
);

const file = Command.make(
	"file",
	{title: titleFlag, redact: redactFlag, dryRun: dryRunFlag},
	Effect.fn(function* ({title, redact, dryRun}) {
		const raw = readStdin();
		const refusal = checkFileInput({title, body: raw, redact});
		if (refusal) return yield* refuse("file", refusal.message, refusal.code);

		// Redaction happens AFTER the guards pass so a `--redact` run still gets the section and
		// title refusals; masking is about the path class, not a bypass for a malformed body.
		const body = redact ? redactLeaks(raw) : raw;
		const composed = assembleBody(body, composeFooter(footerContext()));

		if (dryRun) {
			yield* Console.log(composed);
			process.stderr.write("report file: dry-run — no issue created\n");
			return;
		}

		const tracker = yield* Tracker;
		const created = yield* tracker.createIssue({title, body: composed});
		// Prove it landed. The footer is what `triage` keys auto-close eligibility on, so an issue
		// that reported success without one is the failure this read-back exists to catch.
		const landed = yield* tracker.readIssue(created.target);
		if (!hasFooter(landed.body)) {
			return yield* refuse(
				"file",
				`read-back mismatch on #${created.target} — created, but the landed body carries no provenance footer`,
				Exit.READBACK_MISMATCH,
			);
		}
		yield* Console.log(`report: created #${created.target} — ${created.url}`);
	}),
).pipe(
	Command.withDescription(
		"Compose, guard and create the intake issue, then prove what landed; body on stdin",
	),
);

const note = Command.make(
	"note",
	{issue: issueFlag, redact: redactFlag, dryRun: dryRunFlag},
	Effect.fn(function* ({issue, redact, dryRun}) {
		const raw = readStdin();
		const refusal = checkNoteInput({body: raw, redact});
		if (refusal) return yield* refuse("note", refusal.message, refusal.code);

		const body = redact ? redactLeaks(raw) : raw;
		const composed = assembleBody(body, composeFooter(footerContext()));

		if (dryRun) {
			yield* Console.log(composed);
			process.stderr.write("report note: dry-run — no comment created\n");
			return;
		}

		const tracker = yield* Tracker;
		// Read before writing: a note on a closed issue succeeds and reaches nobody, which the
		// filer cannot tell from success. Refusing costs one request and saves a lost observation.
		const target = yield* tracker.readIssue(issue);
		if (target.closed) {
			return yield* refuse(
				"note",
				`#${issue} is closed — a note on a closed issue reaches nobody`,
				Exit.ZERO_SCOPE,
			);
		}
		const commented = yield* tracker.createComment(issue, {body: composed});
		yield* Console.log(`report: noted on #${issue} (ref ${commented.ref})`);
	}),
).pipe(
	Command.withDescription("Add what an existing issue lacks; body on stdin, no section template"),
);

export const writeSubcommands = [file, note] as const;
