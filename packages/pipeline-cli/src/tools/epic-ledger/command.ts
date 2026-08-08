/**
 * The `epic-ledger` tool — `pipeline-cli epic-ledger <epic> [--dry-run]`.
 *
 * The operable surface for the `review-plan` gate (the verified-plan transition), moved into the
 * pipeline-cli registry (the originating initiative, Phase 2 / the originating work item). `epic-ledger gate` for real
 * is `pipeline-cli epic-ledger <epic>`: validate → flip `status:planned →
 * triaged` on a clean ledger, or post a per-defect FAIL and flip nothing;
 * `--dry-run` validates and prints the verdict without touching a label or
 * posting a comment.
 *
 * The handler is byte-identical to the package's former `bin.ts`: it requires
 * `Github`, and `GithubLive` is baked in here with `Command.provide(...)` so the
 * registered command's residual requirement is the Node platform union
 * (`GithubLive` needs `ChildProcessSpawner`, a `NodeServices` member the bin
 * provides) — per the registry seam, a tool self-contains its services.
 */
import {Console, Effect} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import * as Exit from "../../exit-codes.ts";
import type {Defect} from "./Defect.ts";
import {runGate} from "./gate.ts";
import {Github, GithubLive} from "./github.ts";
import {validateLedger} from "./validate.ts";

const PLANNED_LABEL = "status:planned";

const refList = (refs: ReadonlyArray<number>): string => refs.map((n) => `#${n}`).join(", ");

const printDefects = (defects: ReadonlyArray<Defect>) =>
	Effect.forEach(defects, (d) => Console.log(`  - ${d.type} (${refList(d.refs)}) — ${d.message}`), {
		concurrency: 1,
		discard: true,
	});

/**
 * Fail the gate through the exit status, which is the only channel a caller can branch on.
 *
 * Both branches printed `✗ … FAIL` and exited 0, so `epic-ledger 39 && release-the-lock` released
 * the lock on a failing gate and `plan-epic`'s SKILL.md carried a prose warning — "do not chain it"
 * — standing in for the missing code. Everywhere else in this toolkit the exit status is the answer
 * and stdout is commentary; `ship-it check` exits 11 rather than printing a refusal and exiting 0.
 *
 * This applies to the real run too, not only `--dry-run`. The argument for leaving that one at 0 was
 * that the label flip is the outcome — but the flip is not something the chaining caller can see, so
 * "FAIL, nothing flipped" and "PASS, flipped three" were the same observation to it. One defect, two
 * branches.
 */
const failGate = Effect.sync(() => process.exit(Exit.GATE_FAIL));

const epicArg = Argument.integer("epic").pipe(
	Argument.withDescription("the epic issue number whose ledger to gate"),
);

const dryRunFlag = Flag.boolean("dry-run").pipe(
	Flag.withDescription(
		"validate and print the verdict only — never flip a label or post a comment",
	),
);

export const epicLedgerCommand = Command.make(
	"epic-ledger",
	{epic: epicArg, dryRun: dryRunFlag},
	Effect.fn(function* ({epic, dryRun}) {
		if (dryRun) {
			const ledger = yield* (yield* Github).epicLedger(epic);
			const defects = validateLedger(ledger);
			const planned = ledger.children
				.filter((c) => c.labels.includes(PLANNED_LABEL))
				.map((c) => c.number);

			if (defects.length === 0) {
				yield* Console.log(`✓ epic #${epic} — PASS (0 hard defects) [dry-run]`);
				yield* Console.log(
					planned.length === 0
						? "  no status:planned child to flip (children already triaged)"
						: `  would flip ${planned.length}: ${refList(planned)}`,
				);
				return;
			}

			yield* Console.log(`✗ epic #${epic} — FAIL (${defects.length} hard defect(s)) [dry-run]`);
			yield* printDefects(defects);
			return yield* failGate;
		}

		const verdict = yield* runGate(epic);
		if (verdict._tag === "pass") {
			yield* Console.log(
				`✓ epic #${epic} — PASS, flipped ${verdict.flipped.length} child(ren) status:planned → status:triaged`,
			);
			if (verdict.flipped.length > 0) yield* Console.log(`  ${refList(verdict.flipped)}`);
			return;
		}
		yield* Console.log(
			`✗ epic #${epic} — FAIL (${verdict.defects.length} hard defect(s)); nothing flipped`,
		);
		yield* printDefects(verdict.defects);
		yield* Console.log(`  signature: ${verdict.signature}`);
		return yield* failGate;
	}),
).pipe(
	Command.withDescription("Run the review-plan structural gate over an epic's ledger"),
	Command.provide(GithubLive),
);
