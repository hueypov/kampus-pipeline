import {execFileSync, spawnSync} from "node:child_process";
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {readLifecyclePolicy, remotePrimaryBranch, repositoryRoot} from "../lifecycle-policy.ts";
import {decideMainSync} from "./main-sync.ts";

const executeFlag = Flag.boolean("execute").pipe(Flag.withDescription("perform the safe fetch and fast-forward (default: dry-run)"));
const postMergeFlag = Flag.boolean("post-merge").pipe(Flag.withDescription("run the repository-owned post-sync command after a successful sync"));

const git = (root: string, args: ReadonlyArray<string>): {readonly ok: boolean; readonly stdout: string; readonly stderr: string} => {
	const result = spawnSync("git", [...args], {cwd: root, encoding: "utf8"});
	return {ok: result.status === 0 && !result.error, stdout: result.stdout ?? "", stderr: result.stderr ?? ""};
};

const currentBranch = (root: string): string | null => {
	const result = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	return result.ok && result.stdout.trim() ? result.stdout.trim() : null;
};

const hasTrackedChanges = (root: string): boolean => {
	const result = git(root, ["status", "--porcelain", "--untracked-files=no"]);
	return !result.ok || result.stdout.trim() !== "";
};

const fail = (message: string): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`main-sync: ${message}\n`);
		process.exit(1);
	});

const mainSync = Command.make(
	"main-sync",
	{execute: executeFlag, postMerge: postMergeFlag},
	Effect.fn(function* ({execute, postMerge}) {
		const root = repositoryRoot();
		if (root === null) return yield* fail("not inside a Git repository");
		const policy = readLifecyclePolicy(root);
		const primaryBranch = policy?.git.primaryBranch ?? remotePrimaryBranch(root);
		const postSyncCommand = policy?.git.postSyncCommand ?? null;
		const decision = decideMainSync({primaryBranch, currentBranch: currentBranch(root), trackedChanges: hasTrackedChanges(root)});
		if (decision.kind === "refuse") return yield* fail(`${decision.reason}; refusing to alter the checkout`);
		const branch = primaryBranch as string;
		yield* Console.log(`main-sync: primary ${branch}; ${decision.checkoutPrimary ? "would reattach" : "already attached"}${execute ? " (EXECUTE)" : " (dry-run)"}`);
		if (!execute) {
			yield* Console.log(`  would fetch origin ${branch} and merge --ff-only origin/${branch}`);
			if (postMerge && postSyncCommand !== null) yield* Console.log(`  would run repository-owned post-sync command: ${postSyncCommand.join(" ")}`);
			return;
		}
		if (decision.checkoutPrimary) {
			const checkout = git(root, ["checkout", branch]);
			if (!checkout.ok) return yield* fail(`could not attach ${branch}: ${checkout.stderr.trim() || "unknown Git error"}`);
		}
		const fetched = git(root, ["fetch", "origin", branch]);
		if (!fetched.ok) return yield* fail(`fetch failed: ${fetched.stderr.trim() || "unknown Git error"}`);
		const merged = git(root, ["merge", "--ff-only", `origin/${branch}`]);
		if (!merged.ok) return yield* fail(`fast-forward merge refused: ${merged.stderr.trim() || "resolve divergence manually"}`);
		yield* Console.log(`main-sync: synced to origin/${branch}`);
		if (postMerge && postSyncCommand !== null) {
			const [command, ...args] = postSyncCommand;
			if (command === undefined) return yield* fail("post-sync command has no executable");
			const refresh = spawnSync(command, args, {cwd: root, encoding: "utf8"});
			if (refresh.status !== 0 || refresh.error) return yield* fail(`post-sync command failed: ${refresh.stderr ?? refresh.error?.message ?? "unknown error"}`);
			yield* Console.log("main-sync: repository-owned post-sync command completed");
		}
	}),
).pipe(Command.withDescription("Safely synchronize the primary checkout: dry-run by default, fast-forward only, never reset or force-checkout"));

export const mainSyncCommand = mainSync;
