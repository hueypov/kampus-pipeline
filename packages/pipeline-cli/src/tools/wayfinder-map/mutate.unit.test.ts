import {assert, describe, it} from "@effect/vitest";
import {annotatedMapBody, cleanMapBody} from "./fixtures.ts";
import type {WayfinderMapLedger} from "./Map.ts";
import {parseMapBody} from "./markdown.ts";
import type {Graduation} from "./mutate.ts";
import {bodyPrecondition, checkGraduation, graduateBody, introducedDefects} from "./mutate.ts";
import {validateMap} from "./validate.ts";

const plan = (overrides: Partial<Graduation> = {}): Graduation => ({
	ticket: 103,
	decision: "The session model mints a single-use token with no new table",
	spawned: [],
	...overrides,
});

const ledgerOf = (body: string, subIssues: ReadonlyArray<number>): WayfinderMapLedger => ({
	number: 100,
	map: parseMapBody(body),
	subIssues,
});

/** The graduated body, or a failed assertion naming the refusal that stopped it. */
const mutated = (body: string, p: Graduation = plan()): string => {
	const result = graduateBody(body, p);
	assert.strictEqual(result.ok, true, result.ok ? "" : result.refusal.message);
	return result.ok ? result.body : "";
};

describe("graduateBody — one atomic graduation", () => {
	it("appends the decision, drops the frontier ticket, and lands it in the fog", () => {
		const after = parseMapBody(mutated(cleanMapBody));

		assert.deepStrictEqual(
			after.decisionsSoFar.entries.map((d) => d.fromIssue),
			[101, 102, 103],
		);
		assert.deepStrictEqual(
			after.openFrontier.entries.map((t) => t.issue),
			[104],
		);
		assert.deepStrictEqual(
			after.graduatedFog.entries.map((e) => e.issue),
			[101, 102, 103],
		);
	});

	it("emits the contract's entry shapes: `— from #N`, and the ticket first on the fog line", () => {
		const result = graduateBody(cleanMapBody, plan({spawned: ["#131 — Investigation: rotation?"]}));
		assert.strictEqual(result.ok, true);
		if (!result.ok) return;

		assert.strictEqual(
			result.decisionLine,
			"- The session model mints a single-use token with no new table — from #103",
		);
		assert.strictEqual(
			result.fogLine,
			"- #103 — The session model mints a single-use token with no new table → spawned #131",
		);
		assert.deepStrictEqual(result.frontierLines, ["- #131 — Investigation: rotation?"]);

		// Read back through the parser: the fog line's subject is the graduated ticket,
		// never the ref it spawned.
		const fog = parseMapBody(result.body).graduatedFog.entries.find((e) => e.issue === 103);
		assert.deepStrictEqual(fog?.spawned, [131]);
	});

	it("a distinct --fog-note records how the fog cleared, not what was decided", () => {
		const result = graduateBody(
			cleanMapBody,
			plan({fogNote: "Cleared by a better-auth spike."}),
		);
		assert.strictEqual(result.ok, true);
		if (!result.ok) return;
		assert.strictEqual(result.fogLine, "- #103 — Cleared by a better-auth spike.");
	});

	it("a refusal yields no body at all — no partial graduation is reachable", () => {
		// The lockstep rule as an API-shape constraint: every refusal returns the
		// `ok: false` arm, so a caller can never obtain a body with the decision
		// appended but the ticket still on the frontier.
		const result = graduateBody(cleanMapBody, plan({ticket: 999}));
		assert.strictEqual(result.ok, false);
		assert.notProperty(result, "body");
	});
});

describe("graduateBody — newly-revealed frontier", () => {
	it("adds each spawned ticket to `## Open frontier` and notes it on the fog line", () => {
		const after = parseMapBody(
			mutated(
				cleanMapBody,
				plan({spawned: ["#131 — Investigation: token rotation?", "- #132 — Decision: TTL?"]}),
			),
		);
		assert.deepStrictEqual(
			after.openFrontier.entries.map((t) => t.issue),
			[104, 131, 132],
		);
		const fog = after.graduatedFog.entries.find((e) => e.issue === 103);
		assert.deepStrictEqual(fog?.spawned, [131, 132]);
	});
});

describe("graduateBody — content the parser does not model survives", () => {
	const subIssues = [101, 103, 104, 131];
	const before = annotatedMapBody;
	const after = mutated(before, plan({spawned: ["#131 — Investigation: token rotation?"]}));

	it("every unmodelled line survives the mutation byte-for-byte", () => {
		const removed = [
			"- #103 — Investigation: does better-auth's session model let us mint a single-use",
			"  invite token without a new table?",
		];
		const inserted = [
			"- The session model mints a single-use token with no new table — from #103",
			"- #131 — Investigation: token rotation?",
			"- #103 — The session model mints a single-use token with no new table → spawned #131",
		];
		assert.deepStrictEqual(
			after.split("\n").filter((line) => !inserted.includes(line)),
			before.split("\n").filter((line) => !removed.includes(line)),
		);
	});

	it("the notes and prose the parser drops are all still there", () => {
		for (const line of [
			"<!-- charted by wayfinder -->",
			"This map tracks the kefil invite flow. Do not renumber its tickets.",
			"  Note: nothing is deleted here; a revision lands as a new superseding line.",
			"Frontier tickets are listed oldest sub-issue first.",
			"## Notes",
			"Freeform prose the four-section parser never models.",
		]) {
			assert.include(after, `${line}\n`);
		}
	});

	it("the mutated body re-parses and introduces no defect the original lacked", () => {
		const beforeLedger = ledgerOf(before, subIssues);
		const afterLedger = ledgerOf(after, subIssues);
		assert.deepStrictEqual(validateMap(beforeLedger), []);
		assert.deepStrictEqual(introducedDefects(beforeLedger, afterLedger), []);
		assert.strictEqual(checkGraduation(
			{body: before, ledger: beforeLedger},
			{body: after, ledger: afterLedger},
			103,
		), null);
	});

	it("`## Destination` is untouched, wrapped lines and all", () => {
		assert.include(
			after,
			"## Destination\nkamp.us has a working invite (kefil) flow: an existing yazar can vouch a new\nperson in, and that person lands as a çaylak with a clear first-run path.\n",
		);
		assert.strictEqual(
			parseMapBody(after).destination.text,
			parseMapBody(before).destination.text,
		);
	});

	it("`## Decisions-so-far` is append-only", () => {
		const had = parseMapBody(before).decisionsSoFar.entries.map((d) => d.text);
		const now = parseMapBody(after).decisionsSoFar.entries.map((d) => d.text);
		assert.deepStrictEqual(now.slice(0, had.length), had);
		assert.strictEqual(now.length, had.length + 1);
	});
});

// Build a defective body by substituting a literal out of the clean fixture, asserting the
// substitution actually fired. A plain `.replace()` whose search string has drifted matches nothing
// and returns the clean body unchanged — so the defect is never introduced, the code under test
// correctly accepts a valid map, and the assertion fails for a reason unrelated to the behaviour
// being tested. That is precisely how this suite broke: PR #175 renamed the fork marker in
// `fixtures.ts` (`founder-decision-fork` → `decision-owner-fork`), silently voiding a search string
// here. The two PRs never touched the same lines, so both stayed green until they met on `main`.
const mutateFixture = (find: string, replace: string) => {
	assert.ok(cleanMapBody.includes(find), `fixture drift: cleanMapBody no longer contains ${find}`);
	return cleanMapBody.replace(find, replace);
};

describe("graduateBody — refusals", () => {
	const refusalOf = (body: string, p: Graduation) => {
		const result = graduateBody(body, p);
		assert.strictEqual(result.ok, false);
		return result.ok ? undefined : result.refusal;
	};

	it("refuses a ticket that is not on the open frontier (proven absent, not a failed read)", () => {
		assert.strictEqual(refusalOf(cleanMapBody, plan({ticket: 999}))?.code, 7);
	});

	it("refuses a --decision that writes its own attribution", () => {
		const refusal = refusalOf(cleanMapBody, plan({decision: "Settled it — from #103"}));
		assert.strictEqual(refusal?.code, 4);
		assert.match(refusal?.message ?? "", /composes/);
	});

	it("refuses an empty --decision", () => {
		assert.strictEqual(refusalOf(cleanMapBody, plan({decision: "   "}))?.code, 4);
	});

	it("refuses a --spawn that names no sub-issue", () => {
		const refusal = refusalOf(cleanMapBody, plan({spawned: ["Investigation: what next?"]}));
		assert.strictEqual(refusal?.code, 4);
		assert.match(refusal?.message ?? "", /MALFORMED_FRONTIER_ENTRY/);
	});

	it("refuses a --spawn that re-opens the ticket being graduated", () => {
		assert.strictEqual(refusalOf(cleanMapBody, plan({spawned: ["#103 — again?"]}))?.code, 4);
	});

	it("refuses a map missing a section it would have to write to", () => {
		const body = "## Destination\nsomewhere\n\n## Open frontier\n- #103 — Q?\n";
		const refusal = refusalOf(body, plan());
		assert.strictEqual(refusal?.code, 4);
		assert.match(refusal?.message ?? "", /Decisions-so-far/);
	});

	it("refuses a map whose drifted heading levels nest one section inside another", () => {
		// `### Open frontier` under `## Decisions-so-far` makes the frontier a child of
		// the decisions span; two splices into overlapping ranges would shred both.
		const body = [
			"## Destination",
			"somewhere",
			"",
			"## Decisions-so-far",
			"- Chose X. — from #1",
			"",
			"### Open frontier",
			"- #103 — Q?",
			"",
			"## Graduated fog",
			"- #1 — done.",
		].join("\n");
		const refusal = refusalOf(body, plan());
		assert.strictEqual(refusal?.code, 4);
		assert.match(refusal?.message ?? "", /nest/);
	});

	it("refuses a frontier that names the same ticket twice", () => {
		const body = mutateFixture(
			"- #104 — Decision (decision-owner-fork): should an invited çaylak start at 0 karma?",
			"- #103 — Investigation: duplicate entry for the same ticket",
		);
		const refusal = refusalOf(body, plan());
		assert.strictEqual(refusal?.code, 4);
		assert.match(refusal?.message ?? "", /both open and graduated/);
	});
});

describe("checkGraduation — the pre-write proof", () => {
	it("catches a spawn that names an issue which is not a real sub-issue yet", () => {
		const subIssues = [101, 102, 103, 104];
		const after = mutated(cleanMapBody, plan({spawned: ["#999 — Investigation: unfiled?"]}));
		const refusal = checkGraduation(
			{body: cleanMapBody, ledger: ledgerOf(cleanMapBody, subIssues)},
			{body: after, ledger: ledgerOf(after, subIssues)},
			103,
		);
		assert.strictEqual(refusal?.code, 4);
		assert.match(refusal?.message ?? "", /DANGLING_FRONTIER_REF:999/);
	});

	it("does not fault a mutation for a defect the map already had", () => {
		// An already-malformed map stays the caller's problem: only defects the write
		// introduced are grounds to refuse.
		const body = mutateFixture("— from #101", "");
		const subIssues = [101, 102, 103, 104];
		const after = mutated(body);
		assert.isNotEmpty(validateMap(ledgerOf(body, subIssues)));
		assert.deepStrictEqual(introducedDefects(ledgerOf(body, subIssues), ledgerOf(after, subIssues)), []);
	});
});

describe("bodyPrecondition — a concurrent edit is refused, never overwritten", () => {
	it("passes when the body is byte-identical to the one the edit was computed against", () => {
		assert.strictEqual(bodyPrecondition(cleanMapBody, cleanMapBody), null);
	});

	it("refuses with the back-off code when another session moved the body", () => {
		const refusal = bodyPrecondition(cleanMapBody, `${cleanMapBody}- #105 — a peer's edit\n`);
		assert.strictEqual(refusal?.code, 6);
		assert.match(refusal?.message ?? "", /another session/);
	});
});
