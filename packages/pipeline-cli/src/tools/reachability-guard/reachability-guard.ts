/**
 * The pure core of the optional `reachability-guard` adapter.  A repository that
 * explicitly enables this adapter declares how it represents feature keys, which
 * source files are user-facing consumers, and how a journey is registered.  The
 * core deliberately knows none of those repository details: its only job is to
 * preserve the two-part completeness contract once the filesystem boundary has
 * gathered the configured facts.
 *
 * A feature is reachable iff its declared symbol is consumed by at least one
 * configured user-facing source file AND a configured journey registration names
 * the feature key.  A definition may opt out only with a stated exemption reason.
 * Zero definitions and an unknown key fail closed.  The adapter is optional; the
 * command reports a disabled adapter without scanning when repository policy has
 * not enabled it.
 */

/** One configured feature declaration. */
export interface FeatureDefinition {
	/** The declared symbol a consumer references (for example, a feature-key constant). */
	readonly symbol: string;
	/** The repository's release/feature identifier. */
	readonly featureKey: string;
	/** A stated exemption reason, or null when the feature needs both assertions. */
	readonly exemptReason: string | null;
}

/** The IO-gathered evidence passed into the deterministic judge. */
export interface ReachabilityFacts {
	readonly featureKey: string;
	readonly definitions: ReadonlyArray<FeatureDefinition>;
	readonly consumingSymbols: ReadonlySet<string>;
	readonly journeyKeys: ReadonlySet<string>;
}

/** A pass never carries failures; each failure retains the evidence a caller needs. */
export type ReachabilityVerdict =
	| {readonly pass: true; readonly featureKey: string; readonly mode: "reachable"}
	| {readonly pass: true; readonly featureKey: string; readonly mode: "exempt"; readonly exemptReason: string}
	| {readonly pass: false; readonly featureKey: string; readonly reason: "zero-scope"}
	| {readonly pass: false; readonly featureKey: string; readonly reason: "unknown-feature"}
	| {
			readonly pass: false;
			readonly featureKey: string;
			readonly reason: "unreachable";
			readonly symbol: string;
			readonly missingConsumer: boolean;
			readonly missingJourney: boolean;
	  };

/**
 * Judge only gathered facts.  Ordering is intentional: a broken definition scope
 * is never a vacuous pass; an unknown feature is never silently treated as exempt;
 * and an explicit exemption is honored before the consumer/journey assertions.
 */
export const judge = (facts: ReachabilityFacts): ReachabilityVerdict => {
	const {featureKey, definitions, consumingSymbols, journeyKeys} = facts;
	if (definitions.length === 0) return {pass: false, featureKey, reason: "zero-scope"};
	const definition = definitions.find((item) => item.featureKey === featureKey);
	if (definition === undefined) return {pass: false, featureKey, reason: "unknown-feature"};
	if (definition.exemptReason !== null) {
		return {pass: true, featureKey, mode: "exempt", exemptReason: definition.exemptReason};
	}
	const missingConsumer = !consumingSymbols.has(definition.symbol);
	const missingJourney = !journeyKeys.has(featureKey);
	if (missingConsumer || missingJourney) {
		return {pass: false, featureKey, reason: "unreachable", symbol: definition.symbol, missingConsumer, missingJourney};
	}
	return {pass: true, featureKey, mode: "reachable"};
};

/** Render an actionable, repository-neutral explanation of the verdict. */
export const renderReport = (verdict: ReachabilityVerdict): string => {
	if (verdict.pass) {
		return verdict.mode === "exempt"
			? `reachability-guard: ${verdict.featureKey} is explicitly exempt — passing without a consumer or registered journey. Stated reason: ${verdict.exemptReason}`
			: `reachability-guard: ${verdict.featureKey} is reachable — a configured consumer references its declared symbol and a configured journey is registered.`;
	}
	if (verdict.reason === "zero-scope") {
		return "reachability-guard: parsed ZERO configured feature definitions — fail-closed. Check optionalAdapters.featureReachability definitionsPath and definitionPattern.";
	}
	if (verdict.reason === "unknown-feature") {
		return `reachability-guard: '${verdict.featureKey}' is not declared by the configured definition source — an unknown feature fails closed. Add the declaration or check the key you passed.`;
	}
	const lines: string[] = [];
	if (verdict.missingConsumer) lines.push(`  MISSING CONSUMER — no configured consumer source references ${verdict.symbol} (the declared symbol for ${verdict.featureKey}). Build and wire the user-facing slice, or add an explicit configured exemption with a reason.`);
	if (verdict.missingJourney) lines.push(`  MISSING JOURNEY — no configured journey registration names ${verdict.featureKey}. Register a journey that exercises the feature path.`);
	return `reachability-guard: ${verdict.featureKey} is UNREACHABLE — its configured user-facing slice is incomplete:\n${lines.join("\n")}`;
};

/**
 * Parse definition rows using a repository-owned regular expression.  Capture 1 is
 * the declared symbol and capture 2 is the feature key.  Exemptions are read only
 * from the immediately preceding doc comment, so a distant rationale cannot leak
 * onto a later declaration.
 */
export const parseFeatureDefinitions = (
	source: string,
	definitionPattern: RegExp,
	exemptionPattern: RegExp,
): ReadonlyArray<FeatureDefinition> => {
	const comments: Array<{readonly end: number; readonly body: string}> = [];
	for (const match of source.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
		if (match.index !== undefined && match[1] !== undefined) comments.push({end: match.index + match[0].length, body: match[1]});
	}
	const global = new RegExp(definitionPattern.source, definitionPattern.flags.includes("g") ? definitionPattern.flags : `${definitionPattern.flags}g`);
	const definitions: FeatureDefinition[] = [];
	for (const match of source.matchAll(global)) {
		const symbol = match[1];
		const featureKey = match[2];
		if (symbol === undefined || featureKey === undefined || match.index === undefined || !symbol.trim() || !featureKey.trim()) continue;
		const nearest = comments.reduce<{readonly end: number; readonly body: string} | undefined>((current, comment) =>
			comment.end <= match.index! && /^\s*$/.test(source.slice(comment.end, match.index!)) && (current === undefined || comment.end > current.end) ? comment : current, undefined);
		const exemptionMatch = nearest === undefined ? null : new RegExp(exemptionPattern.source, exemptionPattern.flags.replace("g", "")).exec(nearest.body);
		const exemptReason = exemptionMatch?.[1]?.trim() || null;
		definitions.push({symbol: symbol.trim(), featureKey: featureKey.trim(), exemptReason});
	}
	return definitions;
};

/** Whole-word consumer detection prevents a short symbol matching within a longer one. */
export const consumedSymbolsIn = (source: string, candidateSymbols: ReadonlyArray<string>): ReadonlyArray<string> =>
	candidateSymbols.filter((symbol) => new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(source));

/** Extract configured journey registration keys; capture 1 is the key. */
export const parseJourneyKeys = (source: string, journeyPattern: RegExp): ReadonlyArray<string> => {
	const global = new RegExp(journeyPattern.source, journeyPattern.flags.includes("g") ? journeyPattern.flags : `${journeyPattern.flags}g`);
	const keys: string[] = [];
	for (const match of source.matchAll(global)) if (match[1]?.trim()) keys.push(match[1].trim());
	return keys;
};
