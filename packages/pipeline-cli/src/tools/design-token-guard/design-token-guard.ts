/**
 * Pure, repository-neutral CSS custom-property token guard.  The command layer
 * supplies the configured scope and parser expressions; this module never reads
 * the filesystem.  It retains the source guard's three useful invariants:
 * references resolve, raw colour literals stay in declared raw layers, and raw
 * pixel values cannot exceed an explicit per-file ratchet.
 */
export interface TokenRule {
	readonly referencePattern: RegExp;
	readonly declarationPattern: RegExp;
	readonly hexLiteralPattern: RegExp;
	readonly rawPxPattern: RegExp;
	readonly rawPxThreshold: number;
	readonly rawLayerPaths: ReadonlyArray<string>;
	readonly externalProperties: ReadonlyArray<string>;
	readonly grandfatheredMissingTokens: ReadonlyArray<string>;
	readonly rawPxCeilings: Readonly<Record<string, number>>;
}

export interface LocatedValue { readonly value: string; readonly line: number; }
export interface CssFacts {
	readonly path: string;
	readonly declared: ReadonlyArray<string>;
	readonly references: ReadonlyArray<LocatedValue>;
	readonly hex: ReadonlyArray<LocatedValue>;
	readonly rawPx: ReadonlyArray<LocatedValue>;
}

export type Verdict =
	| {readonly pass: true; readonly filesChecked: number; readonly referencesChecked: number}
	| {readonly pass: false; readonly reason: "zero-scope"}
	| {readonly pass: false; readonly reason: "violations"; readonly unresolved: ReadonlyArray<{path: string} & LocatedValue>; readonly rawHex: ReadonlyArray<{path: string} & LocatedValue>; readonly rawPx: ReadonlyArray<{path: string; count: number; ceiling: number | null; samples: ReadonlyArray<LocatedValue>}>};

/** CSS comments are whitespace-preserved so source line numbers remain useful. */
export const stripCssComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
const lineAt = (source: string, index: number): number => source.slice(0, index).split("\n").length;
const matches = (source: string, pattern: RegExp): ReadonlyArray<LocatedValue> => {
	const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
	const expression = new RegExp(pattern.source, flags);
	const out: LocatedValue[] = [];
	for (const match of stripCssComments(source).matchAll(expression)) {
		const value = match[1] ?? match[0];
		if (match.index !== undefined && value !== "") out.push({value, line: lineAt(source, match.index)});
	}
	return out;
};

export const collectCssFacts = (path: string, source: string, rule: Pick<TokenRule, "referencePattern" | "declarationPattern" | "hexLiteralPattern" | "rawPxPattern" | "rawPxThreshold">): CssFacts => ({
	path,
	declared: matches(source, rule.declarationPattern).map((item) => item.value),
	references: matches(source, rule.referencePattern),
	hex: matches(source, rule.hexLiteralPattern),
	rawPx: matches(source, rule.rawPxPattern).filter((item) => Number.parseFloat(item.value) > rule.rawPxThreshold),
});

export const judge = (files: ReadonlyArray<CssFacts>, rule: TokenRule): Verdict => {
	if (files.length === 0) return {pass: false, reason: "zero-scope"};
	const known = new Set(files.flatMap((file) => file.declared));
	for (const name of rule.externalProperties) known.add(name);
	for (const name of rule.grandfatheredMissingTokens) known.add(name);
	const unresolved: Array<{path: string} & LocatedValue> = [];
	const rawHex: Array<{path: string} & LocatedValue> = [];
	const rawPx: Array<{path: string; count: number; ceiling: number | null; samples: ReadonlyArray<LocatedValue>}> = [];
	let referencesChecked = 0;
	for (const file of files) {
		for (const reference of file.references) { referencesChecked++; if (!known.has(reference.value)) unresolved.push({path: file.path, ...reference}); }
		if (rule.rawLayerPaths.includes(file.path)) continue;
		for (const literal of file.hex) rawHex.push({path: file.path, ...literal});
		const ceiling = rule.rawPxCeilings[file.path] ?? null;
		if (file.rawPx.length > (ceiling ?? 0)) rawPx.push({path: file.path, count: file.rawPx.length, ceiling, samples: file.rawPx.slice(0, 3)});
	}
	unresolved.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
	rawHex.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
	rawPx.sort((a, b) => a.path.localeCompare(b.path));
	return unresolved.length || rawHex.length || rawPx.length
		? {pass: false, reason: "violations", unresolved, rawHex, rawPx}
		: {pass: true, filesChecked: files.length, referencesChecked};
};

export const renderReport = (verdict: Verdict): string => {
	if (verdict.pass) return `design-token-guard: ${verdict.filesChecked} configured source file(s), ${verdict.referencesChecked} token reference(s) — clean`;
	if (verdict.reason === "zero-scope") return "design-token-guard: configured source scope produced ZERO files — enabled policy is fail-closed";
	const sections: string[] = [];
	if (verdict.unresolved.length) sections.push(`  UNRESOLVED REFERENCES (${verdict.unresolved.length})\n${verdict.unresolved.map((item) => `    ${item.path}:${item.line}  ${item.value}`).join("\n")}`);
	if (verdict.rawHex.length) sections.push(`  RAW COLOUR LITERALS OUTSIDE CONFIGURED RAW LAYERS (${verdict.rawHex.length})\n${verdict.rawHex.map((item) => `    ${item.path}:${item.line}  ${item.value}`).join("\n")}`);
	if (verdict.rawPx.length) sections.push(`  RAW PIXEL RATCHET REGRESSIONS (${verdict.rawPx.length})\n${verdict.rawPx.map((item) => `    ${item.path}  ${item.count} values; ${item.ceiling === null ? "no configured ceiling" : `ceiling ${item.ceiling}`}; e.g. ${item.samples.map((sample) => `${sample.value}@L${sample.line}`).join(", ")}`).join("\n")}`);
	return `design-token-guard: configured design-token policy failed:\n${sections.join("\n\n")}`;
};
