#!/usr/bin/env node

const [tool, ...args] = process.argv.slice(2);

const allow = () => {
	process.stdin.resume();
	process.stdin.on("end", () => process.exit(0));
	if (process.stdin.isTTY) process.exit(0);
};

if (tool === "version") {
	console.log("pipeline-cli 0.0.0");
	process.exit(0);
}

if (["worktree-guard", "worktree-sweep", "spawn-guard", "leak-guard", "redact-leaks", "ref-guard", "review-head", "tracker", "trivial-diff", "eval-harness", "intake-dedup", "token-spend"].includes(tool)) {
	allow();
}

if (["decisions-index", "epic-ledger", "epic-lock"].includes(tool)) {
	if (args[0] === "compact") console.log("");
	process.exit(0);
}

console.error(`pipeline-cli: '${tool ?? ""}' is not part of the generic toolkit v1`);
process.exit(1);
