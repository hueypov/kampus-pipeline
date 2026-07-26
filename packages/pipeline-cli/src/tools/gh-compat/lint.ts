import {parseDocument} from "yaml";
import type {GhCompatibilityPolicy} from "./policy.ts";

export type LintFinding = {readonly file: string; readonly line: number; readonly matched: string; readonly reason: string};
export type FrontmatterFinding = {readonly file: string; readonly reason: string};
export type ScanFile = {readonly file: string; readonly content: string};
export type LintResult = {readonly findings: ReadonlyArray<LintFinding>; readonly frontmatterFindings: ReadonlyArray<FrontmatterFinding>; readonly scanned: ReadonlyArray<string>; readonly frontmatterScanned: ReadonlyArray<string>};

const normalize = (path: string): string => `/${path.replace(/\\/g, "/").replace(/^\/+/, "")}`;
const isSelfExempt = (path: string, policy: GhCompatibilityPolicy): boolean => policy.skillLint.selfExemptPaths.some((suffix) => normalize(path).endsWith(normalize(suffix)));
const isFrontmatterScoped = (path: string): boolean => normalize(path).endsWith("/SKILL.md") || /\/agents\/[^/]+\.md$/.test(normalize(path));

const configuredPatterns = (policy: GhCompatibilityPolicy): ReadonlyArray<{readonly pattern: RegExp; readonly reason: string}> => {
	if (!policy.skillLint.forbidConfiguredGraphqlPaths || policy.graphql.mode !== "rest-only") return [];
	const patterns = policy.graphql.blockVerbs.map((verb) => ({pattern: new RegExp(`\\bgh\\s+${verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), reason: `gh ${verb} is restricted by this repository's configured compatibility policy`}));
	if (policy.graphql.rewriteIssueAndPrEdit) patterns.push({pattern: /\bgh\s+(?:pr|issue)\s+edit\b/g, reason: "gh pr/issue edit must use the configured REST compatibility path"});
	patterns.push({pattern: /\bgh\s+api\s+graphql\b/g, reason: "gh api graphql is restricted by this repository's REST-only compatibility policy"});
	return patterns;
};

const checkFrontmatter = (file: string, content: string): FrontmatterFinding | null => {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (match === null) return null;
	const document = parseDocument(match[1] ?? "", {strict: true});
	return document.errors.length === 0 ? null : {file, reason: document.errors.map((error) => error.message.split("\n")[0]).join("; ")};
};

/** Scan a supplied corpus without I/O. Scope is returned so command callers can fail closed on a no-op lint. */
export const lintCorpus = (files: ReadonlyArray<ScanFile>, policy: GhCompatibilityPolicy): LintResult => {
	const findings: LintFinding[] = [];
	const frontmatterFindings: FrontmatterFinding[] = [];
	const scanned: string[] = [];
	const frontmatterScanned: string[] = [];
	const patterns = configuredPatterns(policy);
	for (const {file, content} of files) {
		if (policy.skillLint.strictYamlFrontmatter && isFrontmatterScoped(file)) {
			frontmatterScanned.push(file);
			const finding = checkFrontmatter(file, content);
			if (finding !== null) frontmatterFindings.push(finding);
		}
		if (isSelfExempt(file, policy)) continue;
		scanned.push(file);
		for (const [index, line] of content.split("\n").entries()) {
			for (const {pattern, reason} of patterns) {
				pattern.lastIndex = 0;
				for (const match of line.matchAll(pattern)) findings.push({file, line: index + 1, matched: match[0], reason});
			}
		}
	}
	return {findings, frontmatterFindings, scanned, frontmatterScanned};
};

export const isZeroScope = (result: LintResult, policy: GhCompatibilityPolicy): boolean =>
	result.scanned.length === 0 || (policy.skillLint.strictYamlFrontmatter && result.frontmatterScanned.length === 0);
