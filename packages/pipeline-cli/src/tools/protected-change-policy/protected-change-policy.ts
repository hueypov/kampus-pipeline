/**
 * Pure protected-change path classification. The repository supplies the complete
 * boundary through `github.shipping.controlPlanePaths`; this core deliberately
 * owns no product, provider, or source-tree taxonomy.
 */

export type ProtectedChangeClassification = {
	readonly protectedPaths: ReadonlyArray<string>;
	readonly ordinaryPaths: ReadonlyArray<string>;
	readonly trusted: boolean;
	readonly reason: string | null;
};

const compile = (patterns: ReadonlyArray<string>): ReadonlyArray<RegExp> | null => {
	try {
		return patterns.map((pattern) => new RegExp(pattern));
	} catch {
		return null;
	}
};

/**
 * Classify repository-relative changed paths under the configured protected boundary.
 * An invalid boundary is never interpreted as no boundary: every supplied path becomes
 * protected so callers retain the stronger route.
 */
export const classifyProtectedChanges = (
	paths: ReadonlyArray<string>,
	patterns: ReadonlyArray<string>,
): ProtectedChangeClassification => {
	const rules = compile(patterns);
	if (rules === null) return {protectedPaths: [...paths], ordinaryPaths: [], trusted: false, reason: "one or more protected-path patterns could not be compiled"};
	const protectedPaths = paths.filter((path) => rules.some((rule) => rule.test(path)));
	const protectedSet = new Set(protectedPaths);
	return {protectedPaths, ordinaryPaths: paths.filter((path) => !protectedSet.has(path)), trusted: true, reason: null};
};

/**
 * Render the configured boundary for POSIX `grep -E` consumers. Policy patterns must
 * already be start-anchored; removing that one leading anchor and supplying a single
 * outer anchor keeps the generated expression both portable and derived only from the
 * configured policy. `^$` intentionally matches no repository-relative changed path — it is this
 * pure function's total-input contract, not a reachable gate state, because a trusted policy can
 * no longer carry an empty boundary (`parseProtectedChangePolicy` refuses one).
 */
export const renderProtectedChangeRegex = (patterns: ReadonlyArray<string>): string => {
	if (patterns.length === 0) return "^$";
	return `^(${patterns.map((pattern) => `(${pattern.slice(1)})`).join("|")})`;
};
