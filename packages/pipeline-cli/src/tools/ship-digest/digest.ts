/**
 * `ship-digest` core — a pure, IO-free stakeholder projection of merged work.
 *
 * The gatherer owns repository-specific joins (tracker, pull request, or release
 * provider). This module owns only the total, lossless rendering step. Every entry
 * is placed in one category → milestone → type leaf; incomplete metadata is made
 * visible in an explicit fallback bucket rather than being omitted.
 */

/** The visible fallback bucket shared by every grouping axis. */
export const UNCATEGORIZED = "Uncategorized";

/**
 * The display rules for one grouping axis. Orders are repository policy, not an
 * inferred taxonomy. Labels are presentation-only and never change classification.
 */
export interface ShipDigestAxisDisplayPolicy {
	readonly order: ReadonlyArray<string>;
	readonly labels: Readonly<Record<string, string>>;
	readonly fallbackLabel: string;
}

/**
 * A validated repository display policy. `preserveUnconfiguredValues` is true only
 * for the policy-free generic fallback, where nonblank metadata is still surfaced
 * deterministically instead of being silently collapsed into an assumed taxonomy.
 */
export interface ShipDigestDisplayPolicy {
	readonly categories: ShipDigestAxisDisplayPolicy;
	readonly types: ShipDigestAxisDisplayPolicy;
	readonly preserveUnconfiguredValues: boolean;
}

/**
 * Safe behavior when a repository has not supplied a `github.shipping.shipDigest`
 * policy (or supplied an invalid one). It deliberately names no product, platform,
 * provider, or source-repository taxonomy.
 */
export const GENERIC_SHIP_DIGEST_DISPLAY_POLICY: ShipDigestDisplayPolicy = {
	categories: {order: [], labels: {}, fallbackLabel: UNCATEGORIZED},
	types: {order: [], labels: {}, fallbackLabel: UNCATEGORIZED},
	preserveUnconfiguredValues: true,
};

/** The release-state axis is sourced by a repository gatherer; this core never infers it. */
export const RELEASE_STATE_ORDER = ["live", "awaiting-release", "dark", "unknown"] as const;

export type ReleaseState = (typeof RELEASE_STATE_ORDER)[number];

const RELEASE_STATE_LABEL: Readonly<Record<ReleaseState, string>> = {
	live: "live",
	"awaiting-release": "awaiting release",
	dark: "dark",
	unknown: "release state unknown",
};

/** Only these states have affirmative evidence that release action remains. */
const NOT_YET_LIVE: ReadonlyArray<ReleaseState> = ["dark", "awaiting-release"];

/** A normalized, already validated entry supplied by the command boundary. */
export interface ShipEntry {
	readonly issue?: number | undefined;
	readonly pr: number;
	readonly title: string;
	readonly type?: string | undefined;
	readonly milestone?: string | undefined;
	/** Preferred, direct category signal from the gathered work item. */
	readonly category?: string | undefined;
	/** Fallback category recovered by a repository-owned metadata join. */
	readonly joinedCategory?: string | undefined;
	readonly releaseState?: string | undefined;
}

export interface DigestWindow {
	readonly since: string;
	readonly until: string;
}

const nonblank = (value: string | undefined): string | undefined => {
	const trimmed = value?.trim();
	return trimmed === "" || trimmed === undefined ? undefined : trimmed;
};

const canonicalOrderKey = (value: string, axis: ShipDigestAxisDisplayPolicy): string | undefined => {
	const normalized = value.toLocaleLowerCase();
	return axis.order.find((candidate) => candidate.trim().toLocaleLowerCase() === normalized);
};

/**
 * Category precedence is direct canonical signal → joined canonical signal → visible
 * fallback. The legacy aliases are intentionally absent here: command decoding is the
 * sole compatibility boundary, so the pure core has one vocabulary.
 */
export const resolveCategory = (entry: ShipEntry): string | undefined =>
	nonblank(entry.category) ?? nonblank(entry.joinedCategory);

const axisKey = (
	value: string | undefined,
	axis: ShipDigestAxisDisplayPolicy,
	preserveUnconfiguredValues: boolean,
): string => {
	const present = nonblank(value);
	if (present === undefined) return UNCATEGORIZED;
	const configured = canonicalOrderKey(present, axis);
	if (configured !== undefined) return configured;
	return preserveUnconfiguredValues ? present : UNCATEGORIZED;
};

const milestoneKey = (milestone: string | undefined): string => nonblank(milestone) ?? UNCATEGORIZED;

/** Missing, blank, or unrecognized state is unknown — never an unsupported claim of live. */
export const resolveReleaseState = (state: string | undefined): ReleaseState => {
	const normalized = nonblank(state)?.toLocaleLowerCase();
	return normalized !== undefined && (RELEASE_STATE_ORDER as ReadonlyArray<string>).includes(normalized)
		? (normalized as ReleaseState)
		: "unknown";
};

export interface TypeGroup {
	readonly type: string;
	readonly entries: ReadonlyArray<ShipEntry>;
}

export interface MilestoneGroup {
	readonly milestone: string;
	readonly types: ReadonlyArray<TypeGroup>;
}

export interface CategoryGroup {
	readonly category: string;
	readonly milestones: ReadonlyArray<MilestoneGroup>;
}

const orderWithFallbackLast = (keys: ReadonlyArray<string>, fallback: string): ReadonlyArray<string> => {
	const named = keys.filter((key) => key !== UNCATEGORIZED).sort((a, b) => a.localeCompare(b));
	return keys.includes(UNCATEGORIZED) ? [...named, UNCATEGORIZED] : named;
};

const orderedAxisKeys = (
	keys: ReadonlyArray<string>,
	axis: ShipDigestAxisDisplayPolicy,
): ReadonlyArray<string> => {
	const fallback = keys.includes(UNCATEGORIZED);
	const configured = axis.order.filter((key) => keys.includes(key));
	const configuredSet = new Set(configured);
	const dynamic = keys
		.filter((key) => key !== UNCATEGORIZED && !configuredSet.has(key))
		.sort((a, b) => a.localeCompare(b));
	return fallback ? [...configured, ...dynamic, UNCATEGORIZED] : [...configured, ...dynamic];
};

/**
 * Group every entry exactly once, preserving input order inside a leaf. A configured
 * taxonomy fixes category/type ordering; policy-free rendering uses a deterministic
 * alphabetical order for the metadata it was given. Fallback buckets are always last.
 */
export const groupEntries = (
	entries: ReadonlyArray<ShipEntry>,
	policy: ShipDigestDisplayPolicy = GENERIC_SHIP_DIGEST_DISPLAY_POLICY,
): ReadonlyArray<CategoryGroup> => {
	const byCategory = new Map<string, Map<string, Map<string, ShipEntry[]>>>();
	for (const entry of entries) {
		const category = axisKey(resolveCategory(entry), policy.categories, policy.preserveUnconfiguredValues);
		const milestone = milestoneKey(entry.milestone);
		const type = axisKey(entry.type, policy.types, policy.preserveUnconfiguredValues);
		const milestones = byCategory.get(category) ?? new Map<string, Map<string, ShipEntry[]>>();
		byCategory.set(category, milestones);
		const types = milestones.get(milestone) ?? new Map<string, ShipEntry[]>();
		milestones.set(milestone, types);
		const bucket = types.get(type) ?? [];
		types.set(type, bucket);
		bucket.push(entry);
	}

	return orderedAxisKeys([...byCategory.keys()], policy.categories).flatMap((category) => {
		const milestones = byCategory.get(category);
		if (milestones === undefined) return [];
		const groups = orderWithFallbackLast([...milestones.keys()], UNCATEGORIZED).flatMap((milestone) => {
			const types = milestones.get(milestone);
			if (types === undefined) return [];
			const typeGroups = orderedAxisKeys([...types.keys()], policy.types).flatMap((type) => {
				const bucket = types.get(type);
				return bucket === undefined || bucket.length === 0 ? [] : [{type, entries: bucket}];
			});
			return typeGroups.length === 0 ? [] : [{milestone, types: typeGroups}];
		});
		return groups.length === 0 ? [] : [{category, milestones: groups}];
	});
};

const labelFor = (key: string, axis: ShipDigestAxisDisplayPolicy): string =>
	key === UNCATEGORIZED ? axis.fallbackLabel : axis.labels[key] ?? key;

const backlink = (entry: ShipEntry): string => `(#${entry.pr})`;

const renderEntry = (entry: ShipEntry): string =>
	`- ${entry.title} ${backlink(entry)} — ${RELEASE_STATE_LABEL[resolveReleaseState(entry.releaseState)]}`;

/**
 * Render the affirmative release-action callout before category grouping. Unknown is
 * intentionally excluded: uncertainty is shown inline but is never asserted as pending.
 */
const renderReleaseActionCallout = (entries: ReadonlyArray<ShipEntry>): string => {
	const blocks = NOT_YET_LIVE.flatMap((state) => {
		const inState = entries.filter((entry) => resolveReleaseState(entry.releaseState) === state);
		if (inState.length === 0) return [];
		const lines = inState.map((entry) => `- ${entry.title} ${backlink(entry)}`).join("\n");
		return [`### ${RELEASE_STATE_LABEL[state]}\n\n${lines}`];
	});
	return blocks.length === 0 ? "" : `## Needs release attention\n\n${blocks.join("\n\n")}`;
};

/**
 * Render a stakeholder-neutral ship digest. The caller supplies gathered, validated
 * facts and an optional display policy; no filesystem, subprocess, date, network, or
 * release-provider behavior exists in this pure core.
 */
export const deriveShipDigest = (
	entries: ReadonlyArray<ShipEntry>,
	window: DigestWindow,
	policy: ShipDigestDisplayPolicy = GENERIC_SHIP_DIGEST_DISPLAY_POLICY,
): string => {
	const heading = `# Ship digest — ${window.since} → ${window.until}`;
	const categories = groupEntries(entries, policy);
	if (categories.length === 0) return `${heading}\n\n_Nothing shipped in this window._\n`;
	const callout = renderReleaseActionCallout(entries);
	const categoryBlocks = categories.map((category) => {
		const milestoneBlocks = category.milestones.map((milestone) => {
			const typeBlocks = milestone.types.map((type) => {
				const lines = type.entries.map(renderEntry).join("\n");
				return `#### ${labelFor(type.type, policy.types)}\n\n${lines}`;
			});
			return `### ${milestone.milestone}\n\n${typeBlocks.join("\n\n")}`;
		});
		return `## ${labelFor(category.category, policy.categories)}\n\n${milestoneBlocks.join("\n\n")}`;
	});
	return `${heading}\n\n${(callout === "" ? categoryBlocks : [callout, ...categoryBlocks]).join("\n\n")}\n`;
};
