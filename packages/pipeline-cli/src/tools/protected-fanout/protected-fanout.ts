/** Pure dependency/fan-out obligation decision over repository-supplied facts. */
export type FanoutRule = {readonly id: string; readonly triggerPatterns: ReadonlyArray<string>; readonly companionPatterns: ReadonlyArray<string>; readonly requiredChecks: ReadonlyArray<string>; readonly requiredRoles: ReadonlyArray<string>};
export type FanoutObligation = {readonly rule: string; readonly kind: "companion-path" | "check" | "role"; readonly expected: string};
export type FanoutVerdict =
	| {readonly pass: true; readonly triggered: ReadonlyArray<{readonly rule: string; readonly paths: ReadonlyArray<string>}>; readonly satisfied: ReadonlyArray<FanoutObligation>}
	| {readonly pass: false; readonly reason: "zero-scope" | "missing-obligations"; readonly triggered: ReadonlyArray<{readonly rule: string; readonly paths: ReadonlyArray<string>}>; readonly missing: ReadonlyArray<FanoutObligation>; readonly satisfied: ReadonlyArray<FanoutObligation>};

export const globMatcher = (pattern: string): RegExp => {
	const directory = pattern.endsWith("/");
	const source = (directory ? pattern.slice(0, -1) : pattern)
		.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
	return new RegExp(`^${source}${directory ? "(?:/.*)?" : ""}$`);
};

export const judgeProtectedFanout = (paths: ReadonlyArray<string>, checks: ReadonlyArray<string>, roles: ReadonlyArray<string>, rules: ReadonlyArray<FanoutRule>): FanoutVerdict => {
	if (paths.length === 0) return {pass: false, reason: "zero-scope", triggered: [], missing: [], satisfied: []};
	const triggered = rules.map((rule) => ({rule, paths: paths.filter((path) => rule.triggerPatterns.some((pattern) => globMatcher(pattern).test(path)))})).filter((item) => item.paths.length > 0);
	const satisfied: FanoutObligation[] = [];
	const missing: FanoutObligation[] = [];
	for (const item of triggered) {
		for (const pattern of item.rule.companionPatterns) (paths.some((path) => globMatcher(pattern).test(path)) ? satisfied : missing).push({rule: item.rule.id, kind: "companion-path", expected: pattern});
		for (const check of item.rule.requiredChecks) (checks.includes(check) ? satisfied : missing).push({rule: item.rule.id, kind: "check", expected: check});
		for (const role of item.rule.requiredRoles) (roles.includes(role) ? satisfied : missing).push({rule: item.rule.id, kind: "role", expected: role});
	}
	const renderedTriggers = triggered.map((item) => ({rule: item.rule.id, paths: item.paths}));
	return missing.length === 0 ? {pass: true, triggered: renderedTriggers, satisfied} : {pass: false, reason: "missing-obligations", triggered: renderedTriggers, missing, satisfied};
};
