/**
 * `catalog-guard` pure core — validate one repository-owned dependency declaration
 * convention. The command and policy loader own filesystem and configuration IO;
 * this module deliberately receives only already-enumerated manifest facts.
 *
 * The adapter has no implicit package-manager convention. An adopting repository
 * explicitly enables the `pnpm-catalog` policy and supplies accepted specifier
 * prefixes, dependency fields, package scope, and any reasoned exceptions.
 */

export interface DepEntry {
	readonly field: string;
	readonly name: string;
	readonly value: string;
}

export interface PackageManifest {
	readonly path: string;
	readonly deps: ReadonlyArray<DepEntry>;
}

/** A non-standard declaration must be narrow and carry its retained justification. */
export interface AllowlistEntry {
	readonly name: string;
	readonly path?: string;
	readonly reason: string;
}

export interface CatalogRule {
	readonly allowedSpecifierPrefixes: ReadonlyArray<string>;
	/** Named catalogs accepted in addition to the unqualified `catalog:` form. */
	readonly catalogNames: ReadonlyArray<string>;
	readonly allowlist: ReadonlyArray<AllowlistEntry>;
}

export interface CatalogViolation {
	readonly path: string;
	readonly field: string;
	readonly name: string;
	readonly value: string;
}

export type CatalogGuardVerdict =
	| {readonly pass: true; readonly scanned: ReadonlyArray<string>}
	| {readonly pass: false; readonly reason: "zero-scope"}
	| {readonly pass: false; readonly reason: "nonconforming-declarations"; readonly scanned: ReadonlyArray<string>; readonly violations: ReadonlyArray<CatalogViolation>};

const isCompliantValue = (value: string, rule: CatalogRule): boolean => {
	if (!rule.allowedSpecifierPrefixes.some((prefix) => value.startsWith(prefix))) return false;
	if (!value.startsWith("catalog:")) return true;
	const name = value.slice("catalog:".length);
	return name === "" || rule.catalogNames.includes(name);
};

const isAllowlisted = (entry: DepEntry, path: string, allowlist: ReadonlyArray<AllowlistEntry>): boolean =>
	allowlist.some((item) => item.name === entry.name && (item.path === undefined || item.path === path));

/**
 * Judge an already-scoped manifest set. Zero scope is deliberately a refusal: an
 * enabled guard that cannot prove what it inspected must not report a green check.
 */
export const judge = (manifests: ReadonlyArray<PackageManifest>, rule: CatalogRule): CatalogGuardVerdict => {
	if (manifests.length === 0) return {pass: false, reason: "zero-scope"};
	const scanned = manifests.map((manifest) => manifest.path);
	const violations: CatalogViolation[] = [];
	for (const manifest of manifests) {
		for (const entry of manifest.deps) {
			if (isCompliantValue(entry.value, rule) || isAllowlisted(entry, manifest.path, rule.allowlist)) continue;
			violations.push({path: manifest.path, field: entry.field, name: entry.name, value: entry.value});
		}
	}
	return violations.length === 0
		? {pass: true, scanned}
		: {pass: false, reason: "nonconforming-declarations", scanned, violations};
};

export const manifestDeps = (pkg: Record<string, unknown>, dependencyFields: ReadonlyArray<string>): ReadonlyArray<DepEntry> => {
	const entries: DepEntry[] = [];
	for (const field of dependencyFields) {
		const block = pkg[field];
		if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
		for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
			if (typeof value === "string") entries.push({field, name, value});
		}
	}
	return entries;
};

export const renderReport = (verdict: CatalogGuardVerdict): string => {
	if (verdict.pass) return `catalog-guard: compliant declarations in ${verdict.scanned.length} scoped manifest${verdict.scanned.length === 1 ? "" : "s"}`;
	if (verdict.reason === "zero-scope") {
		return "catalog-guard: scanned ZERO package manifests — enabled policy is fail-closed; verify packageGlobs and repository root";
	}
	const lines = verdict.violations.map((violation) =>
		`  ${violation.path}: ${violation.field} \`${violation.name}\` declares \`${violation.value}\` outside the repository's configured forms`,
	);
	return `catalog-guard: ${verdict.violations.length} nonconforming dependency declaration${verdict.violations.length === 1 ? "" : "s"} across ${verdict.scanned.length} scoped manifest${verdict.scanned.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
};
