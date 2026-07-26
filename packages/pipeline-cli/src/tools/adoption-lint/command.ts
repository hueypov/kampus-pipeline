import {execFileSync} from "node:child_process";
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join, resolve} from "node:path";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {isZeroScope, lintAdoption, type ScanFile} from "./adoption-lint.ts";
import {readAdoptionPolicy} from "./policy.ts";

const rootFlag = Flag.string("root").pipe(Flag.optional, Flag.withDescription("repository root containing .pipeline/optional-workflow-policy.json (default: current Git root)"));
const repositoryRoot = (cwd = process.cwd()): string | null => { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], {cwd, encoding: "utf8"}).trim() || null; } catch { return null; } };
const escape = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
const filePattern = (glob: string): RegExp => new RegExp(`^${glob.split("/").map((part) => part === "**" ? ".*" : part === "*" ? "[^/]+" : escape(part)).join("/")}$`);

const walk = (root: string, directory = ""): string[] => {
	let entries: string[];
	try { entries = readdirSync(join(root, directory)); } catch { return []; }
	const files: string[] = [];
	for (const entry of entries) {
		if (entry === ".git" || entry === "node_modules") continue;
		const absolute = join(root, directory, entry);
		let stat: ReturnType<typeof statSync>;
		try { stat = statSync(absolute); } catch { continue; }
		const rel = directory ? `${directory}/${entry}` : entry;
		if (stat.isDirectory()) files.push(...walk(root, rel));
		else if (stat.isFile()) files.push(rel);
	}
	return files;
};

const readCorpus = (root: string, globs: ReadonlyArray<string>): {readonly files: ReadonlyArray<ScanFile>; readonly error: string | null} => {
	const all = walk(root).sort();
	const patterns = globs.map(filePattern);
	for (let index = 0; index < patterns.length; index += 1) {
		if (!all.some((file) => patterns[index]?.test(file))) return {files: [], error: `configured corpus glob matched no files: ${globs[index]}`};
	}
	const selected = all.filter((file) => patterns.some((pattern) => pattern.test(file)));
	const files: ScanFile[] = [];
	for (const file of selected) {
		try { files.push({file, content: readFileSync(join(root, file), "utf8")}); }
		catch { return {files, error: `configured corpus file could not be read: ${file}`}; }
	}
	return {files, error: null};
};

const check = Command.make("check", {root: rootFlag}, Effect.fn(function* ({root}) {
	const requested = Option.getOrUndefined(root);
	const resolvedRoot = requested === undefined ? repositoryRoot() : resolve(requested);
	if (resolvedRoot === null) { yield* Console.error("adoption-lint: repository root could not be resolved — enabled policy cannot be evaluated"); return yield* Effect.sync(() => process.exit(2)); }
	const loaded = readAdoptionPolicy(resolvedRoot);
	if (!loaded.trusted || loaded.policy === null) { yield* Console.error(`adoption-lint: ${loaded.reason ?? "policy is unavailable"} (${loaded.source})`); return yield* Effect.sync(() => process.exit(2)); }
	if (!loaded.policy.enabled) { yield* Console.log(`adoption-lint: disabled by repository policy (${loaded.source})`); return; }
	const corpus = readCorpus(resolvedRoot, loaded.policy.corpusGlobs);
	if (corpus.error !== null) { yield* Console.error(`adoption-lint: ${corpus.error}`); return yield* Effect.sync(() => process.exit(2)); }
	const result = lintAdoption(corpus.files, loaded.policy.decisions, loaded.policy.exemptions);
	yield* Console.log(`adoption-lint: scanned ${result.scanned.length} corpus file(s) against ${result.decisionCount} governed concept(s)`);
	for (const file of result.scanned) yield* Console.log(`  scanned: ${file}`);
	for (const file of result.exempted) yield* Console.log(`  exempted (declared + linted): ${file}`);
	if (isZeroScope(result)) { yield* Console.error("adoption-lint: zero corpus or governed-concept scope is fail-closed"); return yield* Effect.sync(() => process.exit(3)); }
	if (result.findings.length === 0 && result.exemptionFindings.length === 0) { yield* Console.log("adoption-lint: clean — every governed claim has its configured authority evidence"); return; }
	for (const finding of result.findings) {
		yield* Console.error(`  ${finding.file}: claim '${finding.decision}' requires authority '${finding.authority}'; missing evidence /${finding.missingEvidence.join("/; /")}/ — ${finding.reason}`);
	}
	for (const finding of result.exemptionFindings) yield* Console.error(`  [${finding.kind}] ${finding.path}: ${finding.reason}`);
	return yield* Effect.sync(() => process.exit(1));
})).pipe(Command.withDescription("Check an explicitly configured corpus for unsupported governed-practice claims; read-only and fail-closed"));

export const adoptionLintCommand = Command.make("adoption-lint").pipe(
	Command.withSubcommands([check]),
	Command.withDescription("Optional, policy-owned authority/evidence governance lint; disabled unless configured"),
);
