import {execFile} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import * as Exit from "../../exit-codes.ts";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

type Run = {readonly code: number; readonly stdout: string; readonly stderr: string};

const spawn = (args: ReadonlyArray<string>, input: string, cwd?: string): Promise<Run> =>
	new Promise((resolve) => {
		const child = execFile("node", [BIN, "class-probe", "classify", ...args], {cwd}, (error, stdout, stderr) => resolve({
			code: error && typeof (error as {code?: unknown}).code === "number" ? (error as {code: number}).code : 0,
			stdout,
			stderr,
		}));
		child.stdin?.end(input);
	});

const run = (root: string, args: ReadonlyArray<string>, input = ""): Promise<Run> =>
	spawn(["--root", root, ...args], input);

/** No `--root`, so the run resolves its own — the only way to reach the unresolved-root branch. */
const runIn = (cwd: string, args: ReadonlyArray<string>, input = ""): Promise<Run> => spawn(args, input, cwd);

describe("class-probe command", () => {
	let root: string;
	let paths: string;
	let outside: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "class-probe-command-"));
		mkdirSync(join(root, ".pipeline"), {recursive: true});
		writeFileSync(join(root, ".pipeline", "agent-policy.json"), JSON.stringify({schemaVersion: 1, github: {review: {classification: {
			code: {includePatterns: ["^src/"], excludePatterns: []},
			docs: {includePatterns: ["\\.md$"], excludePatterns: ["^skills/"]},
			skills: {includePatterns: ["^skills/"], excludePatterns: []},
			design: {includePatterns: ["^src/ui/"], excludePatterns: []},
		}}}}), "utf8");
		paths = join(root, "changed-files");
		writeFileSync(paths, "src/ui/Panel.tsx\nskills/review/SKILL.md\n", "utf8");
		// A directory under no Git repository, so `repositoryRoot()` resolves null and the verb takes
		// its unresolved-root branch.
		outside = mkdtempSync(join(tmpdir(), "class-probe-no-repo-"));
	});

	afterAll(() => {
		rmSync(root, {recursive: true, force: true});
		rmSync(outside, {recursive: true, force: true});
	});

	it("prints stable review namespaces on stdout and diagnostics on stderr", async () => {
		const result = await run(root, ["--files-from", paths, "--namespaces"]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout.trim().split("\n")).toEqual(["review-code", "review-skill", "review-design"]);
		expect(result.stderr).toContain("policy trusted");
	});

	it("classifies an unreadable policy source conservatively", async () => {
		const result = await run(root, ["--policy-ref", "does-not-exist", "--files-from", paths, "--namespaces"]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout.trim().split("\n")).toEqual(["review-code", "review-doc", "review-skill", "review-design"]);
		expect(result.stderr).toContain("fail-closed");
	});

	it("refuses an empty stdin rather than reporting no review namespace", async () => {
		const result = await run(root, ["--namespaces"], "");
		expect(result.code, result.stderr).toBe(Exit.EMPTY_INPUT);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("held no changed paths");
		expect(result.stderr).not.toContain("no review namespace");
	});

	it("separates a failed read from an empty one", async () => {
		const missing = join(root, "no-such-changed-files");
		const result = await run(root, ["--files-from", missing, "--namespaces"]);
		expect(result.code, result.stderr).toBe(Exit.FAILED);
		expect(result.code).not.toBe(Exit.EMPTY_INPUT);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("could not be read");
	});

	it("keeps exiting 0 for a non-empty diff, including one matching no configured class", async () => {
		const result = await run(root, ["--namespaces"], "Makefile\n");
		expect(result.code, result.stderr).toBe(0);
		// The classifier gives an otherwise-unmatched path to the code gate, so a non-empty diff can
		// never classify to zero namespaces; `no review namespace` is now unreachable rather than
		// merely rare.
		expect(result.stdout.trim().split("\n")).toEqual(["review-code"]);
	});

	it("refuses empty input on the unresolved-root branch too", async () => {
		const proof = await runIn(outside, ["--namespaces"], "src/thing.ts\n");
		expect(proof.stderr, proof.stdout).toContain("repository root could not be resolved");

		const result = await runIn(outside, ["--namespaces"], "");
		expect(result.code, result.stderr).toBe(Exit.EMPTY_INPUT);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("held no changed paths");
	});
});
