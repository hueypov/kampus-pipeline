import {spawnSync} from "node:child_process";
import {statSync} from "node:fs";
import {resolve} from "node:path";
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {readLifecyclePolicy, remotePrimaryBranch, repositoryRoot} from "../lifecycle-policy.ts";
import {decideSweep, isManagedRoot, isReviewWorktree, safeRemoveArgs, type WorktreeRecord} from "./worktree-sweep.ts";

type ListedWorktree = {readonly path: string; readonly head: string | null; readonly branch: string | null; readonly prunable: boolean; readonly locked: boolean; readonly bare: boolean};
const executeFlag = Flag.boolean("execute").pipe(Flag.withDescription("remove only candidates proven safe by the sweep (default: inspection only)"));

const git = (root: string, args: ReadonlyArray<string>) => {
	const result = spawnSync("git", [...args], {cwd: root, encoding: "utf8"});
	return {ok: result.status === 0 && !result.error, stdout: result.stdout ?? "", stderr: result.stderr ?? ""};
};

const parseWorktrees = (output: string): ReadonlyArray<ListedWorktree> => {
	const entries: ListedWorktree[] = [];
	let path: string | null = null;
	let head: string | null = null;
	let branch: string | null = null;
	let prunable = false;
	let locked = false;
	let bare = false;
	const flush = () => {
		if (path !== null) entries.push({path, head, branch, prunable, locked, bare});
		path = null; head = null; branch = null; prunable = false; locked = false; bare = false;
	};
	for (const line of output.split("\n")) {
		if (line === "") { flush(); continue; }
		if (line.startsWith("worktree ")) { flush(); path = line.slice("worktree ".length); }
		else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
		else if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length);
		else if (line === "detached") branch = null;
		else if (line === "bare") bare = true;
		else if (line.startsWith("locked")) locked = true;
		else if (line.startsWith("prunable")) prunable = true;
	}
	flush();
	return entries;
};

const dirty = (path: string): boolean => {
	const result = spawnSync("git", ["-C", path, "status", "--porcelain"], {encoding: "utf8"});
	return result.status !== 0 || Boolean(result.stdout?.trim());
};

const recentlyActive = (path: string, idleMinutes: number): boolean => {
	try { return Date.now() - statSync(path).mtimeMs < idleMinutes * 60_000; } catch { return true; }
};

const integrated = (root: string, head: string | null, primaryBranch: string | null): boolean => {
	if (head === null || primaryBranch === null) return false;
	const primary = `origin/${primaryBranch}`;
	if (git(root, ["merge-base", "--is-ancestor", head, primary]).ok) return true;
	const cherry = git(root, ["cherry", primary, head]);
	return cherry.ok && cherry.stdout.trim() !== "" && cherry.stdout.trim().split("\n").every((line) => line.startsWith("-"));
};

const hasOpenPr = (root: string, branch: string | null): boolean => {
	if (branch === null) return false;
	const result = spawnSync("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number", "--jq", "length"], {cwd: root, encoding: "utf8"});
	if (result.status !== 0 || result.error) return true;
	const count = Number.parseInt(result.stdout.trim(), 10);
	return !Number.isFinite(count) || count > 0;
};

const fail = (message: string): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`worktree-sweep: ${message}\n`);
		process.exit(1);
	});

const worktreeSweep = Command.make(
	"worktree-sweep",
	{execute: executeFlag},
	Effect.fn(function* ({execute}) {
		const root = repositoryRoot();
		if (root === null) return yield* fail("not inside a Git repository");
		const policy = readLifecyclePolicy(root);
		if (policy === null) return yield* fail("repository lifecycle policy is unavailable; refusing to inspect unknown worktrees");
		const listed = git(root, ["worktree", "list", "--porcelain"]);
		if (!listed.ok) return yield* fail(`could not list worktrees: ${listed.stderr.trim() || "unknown Git error"}`);
		const roots = policy.worktrees.managedRoots.map((path) => resolve(root, path));
		const primary = policy.git.primaryBranch ?? remotePrimaryBranch(root);
		const candidates = parseWorktrees(listed.stdout).filter((entry) => !entry.bare).map((entry) => {
			const managed = isManagedRoot(entry.path, roots);
			const review = isReviewWorktree(entry.path, policy.worktrees.reviewPrefixes);
			const record: WorktreeRecord = {
				path: entry.path, branch: entry.branch, prunable: entry.prunable,
				dirty: entry.prunable ? false : dirty(entry.path), locked: entry.locked,
				recentlyActive: entry.prunable ? false : recentlyActive(entry.path, policy.worktrees.idleMinutes),
				integrated: entry.prunable ? false : integrated(root, entry.head, primary),
				hasOpenPr: entry.prunable ? false : hasOpenPr(root, entry.branch),
			};
			return {entry, managed, review, decision: decideSweep(record, managed, review)};
		});
		const removable = candidates.filter((candidate) => candidate.decision.kind === "remove");
		yield* Console.log(`worktree-sweep: ${candidates.length} worktree(s) inspected; ${removable.length} removable${execute ? " (EXECUTE)" : " (dry-run)"}`);
		for (const candidate of candidates) yield* Console.log(`  ${candidate.decision.kind === "remove" ? "REMOVE" : "KEEP  "} ${candidate.decision.reason.padEnd(32)} ${candidate.entry.path}`);
		if (!execute) return;
		const unscopedPrunable = candidates.some((candidate) => candidate.entry.prunable && !candidate.managed && !candidate.review);
		for (const candidate of removable.filter((item) => !item.entry.prunable)) {
			const removed = git(root, safeRemoveArgs(candidate.entry.path));
			if (removed.ok) yield* Console.log(`  removed ${candidate.entry.path}`);
			else yield* Console.error(`  kept ${candidate.entry.path}: git refused removal (${removed.stderr.trim() || "unknown Git error"})`);
		}
		const gone = removable.filter((item) => item.entry.prunable);
		if (gone.length > 0 && !unscopedPrunable) {
			const pruned = git(root, ["worktree", "prune", "--verbose"]);
			if (pruned.ok) yield* Console.log(`  pruned ${gone.length} gone-directory worktree record(s)`);
			else yield* Console.error(`  kept gone-directory metadata: ${pruned.stderr.trim() || "Git prune refused"}`);
		} else if (gone.length > 0) {
			yield* Console.error("  kept gone-directory metadata: an unconfigured worktree is also prunable, so global prune is unsafe");
		}
	}),
).pipe(Command.withDescription("Conservatively inspect or reclaim configured abandoned worktrees; dry-run by default and never force-remove"));

export const worktreeSweepCommand = worktreeSweep;
