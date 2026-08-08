/**
 * The guard behind ADR 0001: no eval set may live inside a skill directory.
 *
 * The decision's whole force is structural — a directory outside the skill cannot be installed by
 * linking the skill — and that property survives exactly as long as nobody puts one back. The ADR
 * names the cost it imposes (an author editing a skill no longer sees its cases next door), which
 * is a standing reason for someone to restore colocation. This is what refuses that.
 *
 * **Why it reuses `collectPayloadFiles` instead of walking directories itself.** The obvious
 * hand-rolled walk — `readdirSync(…, {withFileTypes: true})`, recurse on `isDirectory()`, match
 * `evals.json` — finds NOTHING when `evals` is a symlink to a directory:
 *
 *     skills/report/evals -> ../../evals/report        naive walk: []
 *                                                      this guard: 1 finding
 *
 * A symlinked directory is precisely the move an author reaches for to restore colocation without
 * "moving" anything, so it is the case the guard most needs to catch and the one a dirent walk is
 * blind to. Matching on the entry NAME first does not rescue it either: the dirent is named `evals`,
 * not `evals.json`. `collectPayloadFiles` resolves real paths, follows links that stay inside the
 * repository, drops escapes and dangling links, and de-dupes entered realpaths against cycles — the
 * same semantics that made it the fix for #36, for the same reason.
 */
import {realpathSync} from "node:fs";
import {basename} from "node:path";
import {collectPayloadFiles} from "./portable-files.ts";

/** The tree a skill is installed from; anything here is installed when the skill is linked. */
export const SKILLS_ROOT = "claude-plugins/kampus-pipeline/skills";

/** Where ADR 0001 puts eval sets instead. */
export const EVALS_ROOT = "claude-plugins/kampus-pipeline/evals";

/**
 * Every eval set REACHABLE from inside the skill tree, as repository-relative paths.
 *
 * Empty is the only clean answer. A non-empty result violates ADR 0001 whether the file was authored
 * there, copied there, or linked there — reachability is the property that matters, because
 * reachability is what an installed skill hands to a graded run.
 *
 * Each path names where the DATA lives, not the route taken to it: a link inside a skill resolves to
 * its target, so a violation reached through `skills/report/evals -> ../../evals/report` is reported
 * as `…/evals/report/evals.json`. That is what "reachable" means and why the name says so — the
 * finding is that something in the skill tree reaches this file, and the link is what to delete.
 */
export const evalSetsReachableFromSkills = (root: string): ReadonlyArray<string> => {
	// `collectPayloadFiles` returns paths under the REAL root, so relativising against the caller's
	// spelling of it silently mangles every result wherever the two differ — on macOS a temp dir is
	// handed out as /var/... and resolves to /private/var/..., which is how the fixtures first
	// reported findings whose paths were sliced mid-string.
	const real = realpathSync(root);
	return collectPayloadFiles(root, SKILLS_ROOT)
		// Whole filename, not a suffix: `endsWith("evals.json")` also matched `not-evals.json` and
		// `sample-evals.json`, which are not eval sets. A false red is safer than a false green, but
		// it is not harmless — a guard that refuses something legitimate is a guard someone edits to
		// make their build pass, and then it is weaker for the real case too.
		.filter((absolute) => basename(absolute) === "evals.json")
		.map((absolute) => absolute.slice(real.length + 1))
		.sort();
};
