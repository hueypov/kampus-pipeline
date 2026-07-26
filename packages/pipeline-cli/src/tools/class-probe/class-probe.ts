/**
 * Pure changed-path classification for the review fan, ship gate, and delivery workflow.
 * Repository policy supplies every path rule; the core owns only the inclusive fan-out,
 * stable ordering, and fail-closed behavior.
 */

export type ArtifactClass = "has-code" | "has-docs" | "has-skills" | "has-design";
export type ReviewNamespace = "review-code" | "review-doc" | "review-skill" | "review-design";

export type PatternSet = {
	readonly includePatterns: ReadonlyArray<string>;
	readonly excludePatterns: ReadonlyArray<string>;
};

export type ClassificationPolicy = {
	readonly code: PatternSet;
	readonly docs: PatternSet;
	readonly skills: PatternSet;
	readonly design: PatternSet;
};

export type ClassificationResult = {
	readonly classes: ReadonlyArray<ArtifactClass>;
	readonly namespaces: ReadonlyArray<ReviewNamespace>;
	readonly trusted: boolean;
	readonly reason: string | null;
};

const CLASS_ORDER: ReadonlyArray<ArtifactClass> = ["has-code", "has-docs", "has-skills", "has-design"];

const NAMESPACE_OF: Readonly<Record<ArtifactClass, ReviewNamespace>> = {
	"has-code": "review-code",
	"has-docs": "review-doc",
	"has-skills": "review-skill",
	"has-design": "review-design",
};

/** Conservatively classify every non-empty diff when policy cannot be trusted. */
export const FAIL_CLOSED_POLICY: ClassificationPolicy = {
	code: {includePatterns: ["."], excludePatterns: []},
	docs: {includePatterns: ["."], excludePatterns: []},
	skills: {includePatterns: ["."], excludePatterns: []},
	design: {includePatterns: ["."], excludePatterns: []},
};

type CompiledPatternSet = {readonly includes: ReadonlyArray<RegExp>; readonly excludes: ReadonlyArray<RegExp>};

const compile = (rules: PatternSet): CompiledPatternSet | null => {
	try {
		return {includes: rules.includePatterns.map((pattern) => new RegExp(pattern)), excludes: rules.excludePatterns.map((pattern) => new RegExp(pattern))};
	} catch {
		return null;
	}
};

const matches = (path: string, rules: CompiledPatternSet): boolean =>
	rules.includes.some((pattern) => pattern.test(path)) && !rules.excludes.some((pattern) => pattern.test(path));

const allClasses = (): ReadonlyArray<ArtifactClass> => CLASS_ORDER;

const result = (classes: ReadonlyArray<ArtifactClass>, trusted: boolean, reason: string | null): ClassificationResult => ({
	classes,
	namespaces: classes.map((artifact) => NAMESPACE_OF[artifact]),
	trusted,
	reason,
});

/**
 * Classify one repository-relative changed-file set. Classes are inclusive; design is additive.
 * An ordinary unknown file cannot create an unreviewed diff: it rides the code gate.
 */
export const classifyPaths = (files: ReadonlyArray<string>, policy: ClassificationPolicy): ClassificationResult => {
	if (files.length === 0) return result([], true, null);
	const code = compile(policy.code);
	const docs = compile(policy.docs);
	const skills = compile(policy.skills);
	const design = compile(policy.design);
	if (code === null || docs === null || skills === null || design === null) {
		return result(allClasses(), false, "one or more repository classification patterns could not be compiled; dispatching every review namespace");
	}
	const present = new Set<ArtifactClass>();
	for (const path of files) {
		const matchedCode = matches(path, code);
		const matchedDocs = matches(path, docs);
		const matchedSkills = matches(path, skills);
		const matchedDesign = matches(path, design);
		if (matchedCode) present.add("has-code");
		if (matchedDocs) present.add("has-docs");
		if (matchedSkills) present.add("has-skills");
		if (matchedDesign) present.add("has-design");
		if (!matchedCode && !matchedDocs && !matchedSkills && !matchedDesign) present.add("has-code");
	}
	return result(CLASS_ORDER.filter((artifact) => present.has(artifact)), true, null);
};

export const requiredNamespaces = (classes: ReadonlyArray<ArtifactClass>): ReadonlyArray<ReviewNamespace> =>
	classes.map((artifact) => NAMESPACE_OF[artifact]);
