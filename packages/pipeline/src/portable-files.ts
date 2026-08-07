/**
 * The file walk behind the portable-payload audit.
 *
 * Split out of the audit test because the rule it encodes is not obvious and was wrong: **the
 * payload is what lives inside this repository, so the walk never leaves it.**
 *
 * A plain `readdirSync` + `statSync` recursion follows symlinks, and a symlink inside a payload
 * directory is almost never payload — it is local environment. The kampus toolkit's own install
 * hook plants `.claude/.pipeline -> ~/.claude/plugins/cache/<...>` beside the directory a skill
 * runs from, so a walk that follows links reads an entire *other* copy of the pipeline and
 * attributes its contents to this repository. That is how the audit came to report 66 forbidden
 * strings that no file in the repository contains (#36) — and it failed precisely when the
 * toolkit was installed, which is every environment that actually adopts it.
 */
import {lstatSync, readdirSync, realpathSync, statSync} from "node:fs";
import {join, sep} from "node:path";

/** Does `candidate` (already real) sit inside `root` (already real)? */
const within = (root: string, candidate: string): boolean =>
	candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Every real file under `root/path`, recursively.
 *
 * Three cases are deliberately not the same:
 *
 * - **Resolves outside `root`** — out of scope, not unread. Whatever is over there is not what
 *   this repository ships, so the audit has nothing to say about it.
 * - **Resolves nowhere** (a dangling link) — likewise nothing shipped behind it, so it is skipped.
 * - **Absent entirely** — still throws. Callers derive their path list from the payload manifest,
 *   so a path the tree lacks means manifest and tree disagree. That is an answer, and swallowing
 *   it would let the audit pass by scanning nothing.
 *
 * A symlink pointing back *inside* the repository is payload however it is reached, and is
 * followed like any other path; each real directory is entered once, so a link cycle terminates.
 */
export const collectPayloadFiles = (root: string, path: string): string[] => {
	const realRoot = realpathSync(root);
	const entered = new Set<string>();
	const walk = (relative: string): string[] => {
		const absolute = join(realRoot, relative);
		// Throws when nothing is there at all — an absent manifest path must not read as empty.
		lstatSync(absolute);
		let real: string;
		try {
			real = realpathSync(absolute);
		} catch {
			return [];
		}
		if (!within(realRoot, real)) return [];
		if (!statSync(real).isDirectory()) return [real];
		if (entered.has(real)) return [];
		entered.add(real);
		return readdirSync(real, {withFileTypes: true}).flatMap((entry) =>
			walk(join(relative, entry.name)),
		);
	};
	return walk(path);
};
