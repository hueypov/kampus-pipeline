/**
 * The fork marker against the SHIPPED prose, not a fixture.
 *
 * The marker is a contract string held in two places at once: the prose tells an agent how to
 * spell it on a map, and `markdown.ts` decides what counts as a fork by matching it. #165 was
 * the two halves drifting — a rename landed in the prose and never reached the parser, so a
 * fork written exactly as prescribed parsed as ordinary answerable work and the one
 * human-in-the-loop seam went quiet with no error. No fixture can catch a one-sided rename,
 * because a fixture is written by whoever renames. So this crosses the filesystem seam at the
 * real repo root and reads the prose the plugin actually ships.
 */
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {FORK_MARKER, FORK_MARKER_PATTERN, parseMapBody} from "./markdown.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/** Every prose surface that can instruct an agent how to mark a fork. */
const PROSE_ROOT = "claude-plugins";

/** The pre-rename spelling: still parsed for maps charted before #165, gone from the prose. */
const PRE_RENAME_MARKER = "founder-decision-fork";

/**
 * A marker as a map actually carries it — a parenthetical annotation, `(<marker>)` or
 * `(<marker> — awaiting …)`. Matching the written shape rather than every `…-fork` word keeps
 * the scan off anchors, links, and prose that merely discusses forks.
 */
const WRITTEN_MARKER = /\(\s*(\p{L}+(?:-\p{L}+)*-fork)\b/giu;

const markdownFilesUnder = (dir: string): ReadonlyArray<string> =>
	readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return markdownFilesUnder(path);
		return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
	});

const proseFiles = markdownFilesUnder(join(REPO_ROOT, PROSE_ROOT));

/** Every written marker in the shipped prose, tagged with the repo-relative file it came from. */
const writtenMarkers = proseFiles.flatMap((path) =>
	[...readFileSync(path, "utf8").matchAll(WRITTEN_MARKER)].map((match) => ({
		marker: match[1] ?? "",
		file: path.slice(REPO_ROOT.length),
	})),
);

/** A frontier line as the map-shape contract prescribes it, marked with `marker`. */
const frontierLine = (marker: string) =>
	`## Open frontier\n- #104 — Decision (${marker}): should an invited member start at 0 karma?\n`;

const forkFlagFor = (marker: string) =>
	parseMapBody(frontierLine(marker)).openFrontier.entries[0]?.founderDecisionFork;

describe("the fork marker is one contract string across prose and parser (#165)", () => {
	it("the prose writes at least one fork marker, so this scan cannot pass vacuously", () => {
		assert.isAbove(writtenMarkers.length, 0, `no fork marker found under ${PROSE_ROOT}/`);
	});

	it("every marker the prose writes is the spelling the parser recognizes by name", () => {
		// By NAME, not by the parser's unrecognized-marker fail-safe: the fail-safe keeps a
		// one-sided rename safe, and this keeps it from going unnoticed.
		const unrecognized = writtenMarkers.filter((m) => !FORK_MARKER_PATTERN.test(m.marker));
		assert.deepStrictEqual(unrecognized, []);
	});

	it("every marker the prose writes is the prescribed spelling", () => {
		const offSpec = writtenMarkers.filter((m) => m.marker !== FORK_MARKER);
		assert.deepStrictEqual(offSpec, []);
	});

	it("a frontier line marked as the prose prescribes parses as a fork", () => {
		assert.strictEqual(forkFlagFor(FORK_MARKER), true);
	});

	it("no prose surface still prescribes the pre-rename spelling", () => {
		const stale = proseFiles
			.filter((path) => readFileSync(path, "utf8").includes(PRE_RENAME_MARKER))
			.map((path) => path.slice(REPO_ROOT.length));
		assert.deepStrictEqual(stale, []);
	});

	it("the parser still reads the pre-rename spelling maps charted before the rename carry", () => {
		assert.strictEqual(forkFlagFor(PRE_RENAME_MARKER), true);
	});
});
