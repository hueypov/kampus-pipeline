#!/usr/bin/env node

import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";

const [tool, ...args] = process.argv.slice(2);

const option = (name) => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};

const trackerCreateIssue = () => {
	if (args[0] !== "create-issue") return false;
	const title = option("--title");
	if (!title) {
		console.error("pipeline-cli tracker create-issue: --title is required");
		process.exit(1);
	}
	const body = option("--body");
	const repo = option("--repo") ?? process.env.CLAUDE_PIPELINE_REPO;
	const label = option("--label");
	const ghArgs = ["issue", "create", "--title", title, ...(body === undefined ? ["--body-file", "-"] : ["--body", body]), ...(repo ? ["--repo", repo] : []), ...(label ? ["--label", label] : [])];
	const issueBody = body ?? (process.stdin.isTTY ? "" : awaitStdin());
	const result = spawnSync("gh", ghArgs, {input: body === undefined ? issueBody : undefined, encoding: "utf8"});
	if (result.error || result.status !== 0) {
		console.error(result.stderr?.trim() || "pipeline-cli tracker create-issue: gh failed");
		process.exit(result.status ?? 1);
	}
	console.log(`tracker: created — ${result.stdout.trim()}`);
	process.exit(0);
};

const awaitStdin = () => {
	return readFileSync(0, "utf8");
};

const allow = () => {
	process.stdin.resume();
	process.stdin.on("end", () => process.exit(0));
	if (process.stdin.isTTY) process.exit(0);
};

if (tool === "version") {
	console.log("pipeline-cli 0.0.0");
	process.exit(0);
}

if (tool === "tracker" && trackerCreateIssue()) process.exit(0);

if (["worktree-guard", "worktree-sweep", "spawn-guard", "leak-guard", "redact-leaks", "ref-guard", "review-head", "tracker", "trivial-diff", "eval-harness", "intake-dedup", "token-spend"].includes(tool)) {
	allow();
}

if (["decisions-index", "epic-ledger", "epic-lock"].includes(tool)) {
	if (args[0] === "compact") console.log("");
	process.exit(0);
}

console.error(`pipeline-cli: '${tool ?? ""}' is not part of the generic toolkit v1`);
process.exit(1);
