/**
 * Pure protected-ownership decisions. Repository policy supplies every path,
 * owner syntax, and ownership source; this module has no organisation, provider,
 * or default CODEOWNERS location baked into it.
 */

export type OwnershipSource = "static" | "codeowners";

export type OwnershipRule = {
	readonly pattern: string;
	readonly owners: ReadonlyArray<string>;
};

export type AffectedPath = {
	readonly path: string;
	readonly owners: ReadonlyArray<string>;
	readonly matchedRule: string;
};

export type OwnershipClassification =
	| {readonly kind: "ordinary"; readonly paths: ReadonlyArray<string>}
	| {readonly kind: "affected"; readonly affected: ReadonlyArray<AffectedPath>; readonly ordinaryPaths: ReadonlyArray<string>}
	| {readonly kind: "indeterminate"; readonly reason: "zero-scope" | "ambiguous-rules"; readonly paths: ReadonlyArray<string>};

export type OwnershipVerification =
	| {readonly pass: true; readonly classification: Exclude<OwnershipClassification, {readonly kind: "indeterminate"}>; readonly verified: ReadonlyArray<AffectedPath>}
	| {readonly pass: false; readonly classification: OwnershipClassification; readonly missing: ReadonlyArray<AffectedPath>};

/** Convert the small, documented repository-relative glob language into a matcher. */
export const globMatcher = (pattern: string): RegExp => {
	const normalized = pattern.replace(/^\//, "");
	const directory = normalized.endsWith("/");
	const source = (directory ? normalized.slice(0, -1) : normalized)
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\u0000/g, ".*");
	return new RegExp(`^${source}${directory ? "(?:/.*)?" : ""}$`);
};

export const parseCodeowners = (source: string): ReadonlyArray<OwnershipRule> => {
	const rules: OwnershipRule[] = [];
	for (const raw of source.split("\n")) {
		const line = raw.replace(/\s+#.*$/, "").trim();
		if (!line) continue;
		const [pattern, ...owners] = line.split(/\s+/);
		if (pattern === undefined || owners.length === 0) continue;
		rules.push({pattern: pattern.replace(/^\//, ""), owners});
	}
	return rules;
};

const matches = (path: string, rule: OwnershipRule): boolean => globMatcher(rule.pattern).test(path);

/**
 * CODEOWNERS uses the final matching rule; static mappings intentionally reject
 * overlapping rules so a project cannot silently grant either of two owner sets.
 */
export const classifyOwnership = (
	paths: ReadonlyArray<string>,
	rules: ReadonlyArray<OwnershipRule>,
	source: OwnershipSource,
): OwnershipClassification => {
	if (paths.length === 0) return {kind: "indeterminate", reason: "zero-scope", paths: []};
	const affected: AffectedPath[] = [];
	const ordinaryPaths: string[] = [];
	for (const path of paths) {
		const matching = rules.filter((rule) => matches(path, rule));
		if (matching.length === 0) {
			ordinaryPaths.push(path);
			continue;
		}
		if (source === "static" && matching.length > 1) return {kind: "indeterminate", reason: "ambiguous-rules", paths: [path]};
		const selected = source === "codeowners" ? matching.at(-1)! : matching[0]!;
		affected.push({path, owners: selected.owners, matchedRule: selected.pattern});
	}
	return affected.length === 0 ? {kind: "ordinary", paths: ordinaryPaths} : {kind: "affected", affected, ordinaryPaths};
};

/** Evidence is supplied by a provider or caller; ownership itself never decides approval cardinality. */
export const verifyOwnership = (
	classification: OwnershipClassification,
	approvers: ReadonlyArray<string>,
): OwnershipVerification => {
	if (classification.kind === "indeterminate") return {pass: false, classification, missing: []};
	if (classification.kind === "ordinary") return {pass: true, classification, verified: []};
	const evidence = new Set(approvers);
	const verified = classification.affected.filter((item) => item.owners.some((owner) => evidence.has(owner)));
	const missing = classification.affected.filter((item) => !verified.includes(item));
	return missing.length === 0 ? {pass: true, classification, verified} : {pass: false, classification, missing};
};
