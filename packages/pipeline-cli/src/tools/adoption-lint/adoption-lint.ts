/**
 * `adoption-lint` core — a policy-owned, IO-free governance check. It prevents a
 * corpus from re-implementing a declared authority contract or claiming a governed
 * practice without the evidence the repository configured for that concept.
 *
 * It deliberately does not ship concepts, patterns, corpus paths, labels, URLs, or
 * exemptions. Those are adopter-owned policy inputs, not toolkit defaults.
 */

export interface GovernedDecision {
	readonly id: string;
	readonly authority: string;
	/** Every signature tell must be present before content is considered a claim. */
	readonly signature: ReadonlyArray<RegExp>;
	/** Every evidence marker required to substantiate the claim. */
	readonly evidence: ReadonlyArray<RegExp>;
	readonly reason: string;
}

export type Exemption =
	| {readonly kind: "mirror"; readonly path: string; readonly reason: string}
	| {readonly kind: "grandfathered"; readonly path: string; readonly decision: string; readonly reason: string};

export interface ScanFile { readonly file: string; readonly content: string; }
export interface AdoptionFinding { readonly file: string; readonly decision: string; readonly authority: string; readonly reason: string; readonly missingEvidence: ReadonlyArray<string>; }
export interface ExemptionFinding { readonly path: string; readonly kind: Exemption["kind"]; readonly reason: string; }
export interface AdoptionResult {
	readonly findings: ReadonlyArray<AdoptionFinding>;
	readonly exemptionFindings: ReadonlyArray<ExemptionFinding>;
	readonly scanned: ReadonlyArray<string>;
	readonly exempted: ReadonlyArray<string>;
	readonly decisionCount: number;
}

const normalize = (path: string): string => `/${path.replace(/\\/g, "/").replace(/^\/+/, "")}`;
const pathMatches = (file: string, declared: string): boolean => normalize(file).endsWith(normalize(declared));
const hasClaim = (content: string, decision: GovernedDecision): boolean => decision.signature.every((pattern) => pattern.test(content));
const missingEvidence = (content: string, decision: GovernedDecision): ReadonlyArray<string> =>
	decision.evidence.filter((pattern) => !pattern.test(content)).map((pattern) => pattern.source);

/** A Markdown document can name an authority, so it is never a justified runtime mirror. */
export const isImportableDocument = (path: string): boolean => /\.(?:md|mdx|txt)$/i.test(normalize(path));

export const isClaimWithoutEvidence = (content: string, decision: GovernedDecision): boolean =>
	hasClaim(content, decision) && missingEvidence(content, decision).length > 0;

export const exemptionFor = (file: string, decision: string, exemptions: ReadonlyArray<Exemption>): Exemption | null =>
	exemptions.find((exemption) => pathMatches(file, exemption.path) && (exemption.kind === "mirror" || exemption.decision === decision)) ?? null;

const lintExemption = (exemption: Exemption, files: ReadonlyArray<ScanFile>, decisions: ReadonlyArray<GovernedDecision>): ExemptionFinding | null => {
	const target = files.find((file) => pathMatches(file.file, exemption.path));
	if (target === undefined) return {path: exemption.path, kind: exemption.kind, reason: `declared ${exemption.kind} exemption names a file outside the scanned corpus — remove or correct it`};
	if (exemption.kind === "mirror") {
		return isImportableDocument(exemption.path)
			? {path: exemption.path, kind: exemption.kind, reason: "a document can cite the configured authority and cannot be a runtime mirror"}
			: null;
	}
	const decision = decisions.find((item) => item.id === exemption.decision);
	if (decision === undefined) return {path: exemption.path, kind: exemption.kind, reason: `grandfathers unknown governed concept '${exemption.decision}'`};
	return isClaimWithoutEvidence(target.content, decision)
		? null
		: {path: exemption.path, kind: exemption.kind, reason: `grandfathered claim for '${exemption.decision}' no longer needs an exemption — remove the stale entry`};
};

/** Scan a supplied corpus and self-lint every policy exception; zero scope is handled by `isZeroScope`. */
export const lintAdoption = (files: ReadonlyArray<ScanFile>, decisions: ReadonlyArray<GovernedDecision>, exemptions: ReadonlyArray<Exemption>): AdoptionResult => {
	const scanned: string[] = [];
	const exempted: string[] = [];
	const findings: AdoptionFinding[] = [];
	for (const file of files) {
		scanned.push(file.file);
		for (const decision of decisions) {
			if (!isClaimWithoutEvidence(file.content, decision)) continue;
			if (exemptionFor(file.file, decision.id, exemptions) !== null) { exempted.push(file.file); continue; }
			findings.push({file: file.file, decision: decision.id, authority: decision.authority, reason: decision.reason, missingEvidence: missingEvidence(file.content, decision)});
		}
	}
	const exemptionFindings = exemptions.flatMap((exemption) => {
		const finding = lintExemption(exemption, files, decisions);
		return finding === null ? [] : [finding];
	});
	return {findings, exemptionFindings, scanned, exempted, decisionCount: decisions.length};
};

/** An enabled governance check that scanned no corpus or owns no concepts cannot prove compliance. */
export const isZeroScope = (result: AdoptionResult): boolean => result.scanned.length === 0 || result.decisionCount === 0;
