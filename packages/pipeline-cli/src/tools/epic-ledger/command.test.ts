/**
 * Spawned-bin witnesses for `epic-ledger`'s exit contract (#43).
 *
 * The module had six unit-test files and none covering the command layer, which is exactly where the
 * defect lived: `validateLedger` returned its defects correctly, the command printed them correctly,
 * and then exited 0 — so `epic-ledger 39 && release-the-lock` released the lock on a failing gate
 * while every unit test stayed green. Only a spawned process observes an exit code.
 *
 * These are HERMETIC. `github.ts` reaches GitHub by shelling `gh api`, so a `gh` shim first on PATH
 * serves a fixture ledger and the whole gate runs offline, deterministically, in CI, on a fresh
 * clone. That matters for two reasons review found in the first version, which probed live epics:
 *
 *   - **The FAIL branch's coverage was scheduled to evaporate.** A live probe needs a failing epic to
 *     exist, and an all-clean board is this pipeline's attractor state — it exists to repair exactly
 *     the defect the probe depended on. With the fix absent and every probe epic passing, the whole
 *     suite went green. A witness whose evidence the system is actively working to delete is a
 *     witness with an expiry date on it.
 *   - **The real (label-flipping) run could not be witnessed at all**, because witnessing it meant
 *     letting it flip labels and post comments on a live epic. The shim absorbs those writes, so the
 *     branch that mutates is now the one that is easiest to test.
 *
 * The shim refuses any request it was not built to answer rather than returning an empty success, so
 * a call this file did not anticipate fails loudly instead of quietly grading a ledger with a hole
 * in it.
 */
import {execFile} from "node:child_process";
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));
const REPO = "fixture/repo";

/** One issue as `gh api repos/…/issues/<n>` returns it — only the fields the ledger decodes. */
const issue = (number: number, body: string, labels: ReadonlyArray<string>) => ({
	number,
	title: `fixture #${number}`,
	body,
	labels: labels.map((name) => ({name})),
});

/**
 * A ledger that validates clean, verified by running the gate against it rather than by assuming.
 *
 * Every part of both bodies is load-bearing and each was added because the gate refused without it:
 * the epic needs `### User stories` (a `**Stories:**` field is the CHILD's form and leaves the epic
 * MISSING_STORIES_SECTION) and a `## Dependencies` section listing the child under a `### Phase`
 * heading (a bare mermaid block parses to zero nodes, so the child reads as an ORPHAN_CHILD); the
 * child needs an `### Acceptance criteria` checkbox, a `**Stories:**` ref, and a `**Containment:**`
 * marker.
 */
const CLEAN = {
	100: issue(100, "### User stories\n\n1. the one story\n\n## Dependencies\n\n### Phase 1\n\n- #101 — the one child\n", [
		"type:epic",
		"p1",
		"status:triaged",
	]),
	101: issue(101, "**Stories:** 1\n\n### Acceptance criteria\n\n- [ ] the one criterion\n\n**Containment:** exempt\n", [
		"type:feature",
		"p1",
		"status:triaged",
	]),
};

/**
 * The same ledger with the child left on `status:needs-triage` — NEEDS_TRIAGE_LABEL, a hard defect,
 * and the one the issue's original reproduction hit.
 */
const DEFECTIVE = {
	100: CLEAN[100],
	101: issue(101, CLEAN[101].body, ["type:feature", "p1", "status:needs-triage"]),
};

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

describe("epic-ledger — the exit status IS the verdict (#43)", () => {
	let dir: string;

	/** Write a `gh` shim serving `ledger`, and return a PATH with it in front. */
	const shimPath = (name: string, ledger: Record<number, unknown>): string => {
		const binDir = join(dir, name);
		mkdirSync(binDir, {recursive: true});
		const data = join(binDir, "ledger.json");
		writeFileSync(data, JSON.stringify(ledger));
		const writes = join(binDir, "writes.jsonl");
		writeFileSync(
			join(binDir, "gh"),
			`#!/usr/bin/env node
const {readFileSync, appendFileSync} = require("node:fs");
const argv = process.argv.slice(2);
const ledger = JSON.parse(readFileSync(${JSON.stringify(data)}, "utf8"));
const path = argv.find((a) => a.startsWith("repos/")) ?? "";
const method = argv.includes("-X") ? argv[argv.indexOf("-X") + 1] : "GET";

// Every write the real run performs is recorded and acknowledged, so the label flip and the
// verdict comment happen against this file instead of a live repository.
if (method !== "GET") {
  appendFileSync(${JSON.stringify(writes)}, JSON.stringify({method, path, argv}) + "\\n");
  process.stdout.write("{}");
  process.exit(0);
}
const sub = path.match(/^repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)\\/sub_issues/);
if (sub) {
  const parent = Number(sub[1]);
  process.stdout.write(JSON.stringify(Object.keys(ledger).map(Number).filter((n) => n !== parent).map((number) => ({number}))));
  process.exit(0);
}
const one = path.match(/^repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)$/);
if (one) {
  const found = ledger[one[1]];
  if (!found) { process.stderr.write("gh: Not Found (HTTP 404)"); process.exit(1); }
  process.stdout.write(JSON.stringify(found));
  process.exit(0);
}
if (path.includes("/contents/product-development-cycle.md")) {
  process.stderr.write("gh: Not Found (HTTP 404)");
  process.exit(1);
}
// Anything unanticipated refuses loudly. An empty success here would let the gate grade a
// ledger with a hole in it and call the result clean.
process.stderr.write("gh shim: unhandled request: " + argv.join(" "));
process.exit(64);
`,
			{mode: 0o755},
		);
		chmodSync(join(binDir, "gh"), 0o755);
		return `${binDir}:${process.env.PATH ?? ""}`;
	};

	const run = (path: string, args: ReadonlyArray<string>): Promise<RunResult> =>
		new Promise((resolve) => {
			execFile(
				"node",
				[BIN, "epic-ledger", ...args],
				{env: {...process.env, PATH: path, CLAUDE_PIPELINE_REPO: REPO}},
				(error, stdout, stderr) => {
					const code =
						error && typeof (error as {code?: unknown}).code === "number"
							? (error as {code: number}).code
							: 0;
					resolve({code, stdout, stderr});
				},
			);
		});

	let clean: string;
	let defective: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "epic-ledger-"));
		clean = shimPath("clean", CLEAN);
		defective = shimPath("defective", DEFECTIVE);
	});
	afterAll(() => rmSync(dir, {recursive: true, force: true}));

	it("--dry-run on a clean ledger: PASS, exit 0", async () => {
		const {code, stdout, stderr} = await run(clean, ["100", "--dry-run"]);
		assert.include(stdout, "PASS", `stderr: ${stderr}`);
		assert.strictEqual(code, 0);
	}, 60_000);

	it("--dry-run on a defective ledger: FAIL, exit 14", async () => {
		// The witness the live-epic version could not keep: this defect is in a fixture, so no one
		// can repair it out from under the test.
		const {code, stdout, stderr} = await run(defective, ["100", "--dry-run"]);
		assert.include(stdout, "FAIL", `stderr: ${stderr}`);
		assert.include(stdout, "NEEDS_TRIAGE_LABEL");
		assert.strictEqual(code, 14, "a printed FAIL and a zero exit is the defect this closes");
	}, 60_000);

	it("the REAL run also fails through its exit status, not only its stdout", async () => {
		// Unwitnessable against a live repository — it flips labels and posts comments. The shim
		// absorbs both, so the branch that mutates is the one that is easiest to test.
		const {code, stdout, stderr} = await run(defective, ["100"]);
		assert.include(stdout, "FAIL", `stderr: ${stderr}`);
		assert.include(stdout, "nothing flipped");
		assert.strictEqual(code, 14, "`epic-ledger 100 && next` must not run `next` on a failing gate");
	}, 60_000);

	it("the real run on a clean ledger still exits 0", async () => {
		const {code, stdout, stderr} = await run(clean, ["100"]);
		assert.include(stdout, "PASS", `stderr: ${stderr}`);
		assert.strictEqual(code, 0);
	}, 60_000);

	it("an unanticipated gh request refuses rather than grading a partial ledger", async () => {
		// Pins the shim's own honesty: if a future change makes the gate call something this file
		// does not serve, these tests must fail rather than silently grade less than they claim to.
		const {code} = await run(clean, ["999", "--dry-run"]);
		assert.notStrictEqual(code, 0, "a ledger the shim cannot serve must not read as a clean gate");
	}, 60_000);
});
