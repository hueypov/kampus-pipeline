/**
 * The `wayfinder-map` tool — `pipeline-cli wayfinder-map <verb> <map> …`.
 *
 * The machine-readable substrate the `wayfinder` skill's WORK and emission modes
 * use instead of prose-guessing — and hand-editing — a map's state. Two verbs:
 *
 *  - **`read`** parses a `wayfinder:map` issue body into its four sections,
 *    validates it against the structural floor, and reports graduation-readiness.
 *  - **`graduate`** is the map's sanctioned mutation path: WORK's steps 4 and 5 in
 *    **one** invocation. The skill requires that WORK mutate the map only through
 *    this CLI (`wayfinder/SKILL.md` §Map state is read and written through the
 *    `wayfinder-map` CLI), so the write lives here rather than in ad-hoc markdown
 *    slicing by an agent.
 *
 * `graduate` is one verb rather than three (append a decision / drop a frontier
 * line / add a fog line) because the contract's lockstep rule constrains the API
 * shape: see `mutate.ts`, which owns that reasoning and the edits themselves.
 *
 * `read`'s default output is a human verdict (PASS/FAIL + the graduation-ready
 * flag); `--json` emits the full parsed state + defects as one JSON object, the
 * form the skill modes and any CI hook consume. Both handlers require `Github`,
 * and `GithubLive` is baked in with `Command.provide(...)` so the registered
 * command's residual requirement is the Node platform union — per the registry
 * seam, a tool self-contains its services.
 */
import {Console, Effect} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import type {Defect} from "./Defect.ts";
import {Github, GithubLive} from "./github.ts";
import {parseMapBody} from "./markdown.ts";
import type {Refusal} from "./mutate.ts";
import {bodyPrecondition, checkGraduation, graduateBody} from "./mutate.ts";
import {answerableFrontier, isGraduationReady, mapSignature, validateMap} from "./validate.ts";
import * as Exit from "../../exit-codes.ts";

const refList = (refs: ReadonlyArray<number>): string => refs.map((n) => `#${n}`).join(", ");

const printDefects = (defects: ReadonlyArray<Defect>) =>
	Effect.forEach(defects, (d) => Console.log(`  - ${d.type} (${refList(d.refs)}) — ${d.message}`), {
		concurrency: 1,
		discard: true,
	});

const refuse = (verb: string, refusal: Refusal): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`wayfinder-map ${verb}: ${refusal.message}\n`);
		process.exit(refusal.code);
	});

const mapArg = Argument.integer("map").pipe(
	Argument.withDescription("the wayfinder:map issue number the verb acts on"),
);

// ── read ─────────────────────────────────────────────────────────────────────

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the full parsed map state + defects as one JSON object"),
);

const read = Command.make(
	"read",
	{map: mapArg, json: jsonFlag},
	Effect.fn(function* ({map, json}) {
		const ledger = yield* (yield* Github).mapLedger(map);
		const defects = validateMap(ledger);
		const ready = isGraduationReady(ledger.map);

		if (json) {
			yield* Console.log(
				JSON.stringify(
					{
						number: ledger.number,
						map: ledger.map,
						subIssues: ledger.subIssues,
						graduationReady: ready,
						answerableFrontier: answerableFrontier(ledger.map).map((t) => t.issue),
						valid: defects.length === 0,
						signature: mapSignature(ledger),
						defects,
					},
					null,
					2,
				),
			);
			return;
		}

		const readyLine = ready
			? "  graduation-ready: open frontier holds no answerable unknown"
			: `  not graduation-ready: ${answerableFrontier(ledger.map).length} answerable frontier ticket(s) remain`;

		if (defects.length === 0) {
			yield* Console.log(`✓ map #${map} — valid (0 defects)`);
			yield* Console.log(readyLine);
			return;
		}
		yield* Console.log(`✗ map #${map} — malformed (${defects.length} defect(s))`);
		yield* printDefects(defects);
		yield* Console.log(`  signature: ${mapSignature(ledger)}`);
		yield* Console.log(readyLine);
	}),
).pipe(Command.withDescription("Parse and validate a wayfinder:map issue's state (read-only)"));

// ── graduate ─────────────────────────────────────────────────────────────────

const ticketFlag = Flag.integer("ticket").pipe(
	Flag.withDescription("the `## Open frontier` sub-issue being graduated"),
);
const decisionFlag = Flag.string("decision").pipe(
	Flag.withDescription(
		"what was decided or found; the `— from #<ticket>` origin is composed, not written by you",
	),
);
const fogNoteFlag = Flag.string("fog-note").pipe(
	Flag.withDefault(""),
	Flag.withDescription("the `## Graduated fog` line's note (default: the decision text)"),
);
const spawnFlag = Flag.string("spawn").pipe(
	Flag.atLeast(0),
	Flag.withDescription(
		"a frontier line this answer revealed, e.g. '#131 — Investigation: …'; repeatable, each already filed as a sub-issue",
	),
);
const dryRunFlag = Flag.boolean("dry-run").pipe(
	Flag.withDescription("compose and print the resulting body; write nothing"),
);

const graduate = Command.make(
	"graduate",
	{
		map: mapArg,
		ticket: ticketFlag,
		decision: decisionFlag,
		fogNote: fogNoteFlag,
		spawn: spawnFlag,
		dryRun: dryRunFlag,
	},
	Effect.fn(function* ({map, ticket, decision, fogNote, spawn, dryRun}) {
		const gh = yield* Github;
		const source = yield* gh.mapSource(map);

		const result = graduateBody(source.body, {
			ticket,
			decision,
			fogNote: fogNote.trim() === "" ? undefined : fogNote,
			spawned: spawn,
		});
		if (!result.ok) return yield* refuse("graduate", result.refusal);

		const after = {
			body: result.body,
			ledger: {
				number: source.ledger.number,
				map: parseMapBody(result.body),
				subIssues: source.ledger.subIssues,
			},
		};
		const broken = checkGraduation({body: source.body, ledger: source.ledger}, after, ticket);
		if (broken) return yield* refuse("graduate", broken);

		if (dryRun) {
			yield* Console.log(result.body);
			process.stderr.write("wayfinder-map graduate: dry-run — nothing written\n");
			return;
		}

		const current = yield* gh.mapBody(map);
		const raced = bodyPrecondition(source.body, current);
		if (raced) return yield* refuse("graduate", raced);

		const landed = yield* gh.replaceMapBody(map, result.body);
		// The read-back proof: a last-write-wins PATCH reports success either way, so
		// what landed is compared against what was sent rather than assumed.
		if (landed !== result.body) {
			return yield* refuse("graduate", {
				message: `read-back on #${map} does not match what was sent; the map body needs a human`,
				code: Exit.READBACK_MISMATCH,
			});
		}

		yield* Console.log(`wayfinder-map: graduated #${ticket} on map #${map}.`);
		yield* Console.log(`  decisions-so-far += ${result.decisionLine}`);
		yield* Console.log(`  graduated-fog   += ${result.fogLine}`);
		for (const line of result.frontierLines) {
			yield* Console.log(`  open-frontier   += ${line}`);
		}
	}),
).pipe(
	Command.withDescription(
		"Graduate one frontier ticket in a single atomic edit: record its answer, drop it from the frontier, land it in the fog, and lay down any frontier it revealed",
	),
);

export const wayfinderMapCommand = Command.make("wayfinder-map").pipe(
	Command.withSubcommands([read, graduate]),
	Command.withDescription(
		"Read and write a wayfinder:map issue's four-section state — the sanctioned map-state seam for the `wayfinder` skill's CHART and WORK modes",
	),
	Command.provide(GithubLive),
);
