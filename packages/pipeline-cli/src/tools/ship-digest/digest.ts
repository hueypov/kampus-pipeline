/**
 * `ship-digest` core — the pure, IO-free founder-facing projection of merged-since work
 * (the originating work item, stories 1/2/7).
 *
 * Where `changelog-derive` renders a *builder's* Keep-a-Changelog (`## [version]` release
 * sections keyed on `type:*`), this renders a *founder's* ship digest for a `--since`
 * window: what shipped, grouped so a non-builder reader can scan it. The top-level split is
 * **product vs infra** (does this touch a kamp.us user surface, or the pipeline/infra
 * substrate?), then by **milestone** (the strategic campaign — `Uncategorized` when none),
 * then by **`type:*`**. This is deliberately NOT the version-heading shape of
 * `changelog-derive`; do not overload that contract.
 *
 * Everything here is total over `ShipEntry[]`. An entry with no milestone / area / type is
 * never dropped — a missing area lands under `Infra` only when it *declares* infra, else it
 * is surfaced under the product tree's `Uncategorized` milestone / `Uncategorized` type, per
 * the "flag, never drop" rule the changelog core also honors. The git-log/`gh` gather that
 * builds the entries JSON is the `/what-shipped` skill's job; this core never touches IO.
 *
 * The **merged-vs-live-to-users axis** (the originating work item, stories 3/4) rides on top of that
 * grouping: each entry carries a `releaseState` — `live` / `awaiting-release` / `dark` /
 * `unknown` — and the render adds (a) an inline live/dark annotation per entry and (b) a
 * distinct "currently dark — awaiting your release" callout listing the not-yet-live work.
 * Per the authoritative live-state source the *sourcing* of that state is the `/what-shipped` gather's IO job (it reads
 * authoritative Cloudflare Flagship values via `cf-utils` for flag-gated work, merged-equals-
 * live for non-flag-gated work); this core stays pure and consumes the state as passed-in
 * input. A merged item with no resolvable state is surfaced as `unknown`, never silently
 * treated as live (the `resolveReleaseState` default).
 */

/**
 * The top-level split of a founder digest. `Product` = a kamp.us user-facing surface;
 * `Infra` = the pipeline / infra / platform substrate. An entry's `area` selects the
 * section; an absent or unrecognized `area` defaults to `Product` (the reader's default
 * frame is the product) and is surfaced there, never dropped.
 */
export const SECTION_ORDER = ["Product", "Infra"] as const;

export type Section = (typeof SECTION_ORDER)[number];

/**
 * The `type:*` render order within a milestone group. Mirrors the `type:*` taxonomy from
 * `skills/gh-issue-intake-formats.md`. An entry whose `type` is absent or not listed here
 * renders under the trailing `Uncategorized` type bucket — flagged, never dropped.
 */
export const TYPE_ORDER = [
	"feature",
	"bug",
	"chore",
	"decision",
	"investigation",
	"epic",
	"Uncategorized",
] as const;

/** The label rendered for a bare `type:*` value (or the Uncategorized fallback). */
const TYPE_LABEL: Readonly<Record<string, string>> = {
	feature: "Features",
	bug: "Fixes",
	chore: "Chores",
	decision: "Decisions",
	investigation: "Investigations",
	epic: "Epics",
	Uncategorized: "Uncategorized",
};

/** The fallback bucket name shared by the milestone and type axes for a missing key. */
export const UNCATEGORIZED = "Uncategorized";

/**
 * The merged-vs-live-to-users axis (the authoritative live-state source). Ordered most-live → least-known:
 * - `live` — served to users now (a flag-gated feature whose Flagship value is on, or
 *   non-flag-gated work that is live at merge).
 * - `awaiting-release` — merged and queued, not yet flipped live to users.
 * - `dark` — merged behind a default-off flag; live only once a human flips it (the human-release boundary).
 * - `unknown` — no resolvable flag/release state; surfaced, NEVER silently treated as live.
 * The state is sourced by the `/what-shipped` gather (the authoritative live-state source); this core consumes it.
 */
export const RELEASE_STATE_ORDER = ["live", "awaiting-release", "dark", "unknown"] as const;

export type ReleaseState = (typeof RELEASE_STATE_ORDER)[number];

/** The inline annotation rendered after each entry's backlink for its release state. */
const RELEASE_STATE_LABEL: Readonly<Record<ReleaseState, string>> = {
	live: "live",
	"awaiting-release": "awaiting release",
	dark: "dark",
	unknown: "release state unknown",
};

/** The release states the "currently dark — awaiting your release" callout collects. */
const NOT_YET_LIVE: ReadonlyArray<ReleaseState> = ["dark", "awaiting-release"];

export interface ShipEntry {
	/** The closed issue number, when the merged work traces to one. */
	readonly issue?: number | undefined;
	/** The merged-PR number — the primary `(#NNN)` backlink; always present. */
	readonly pr: number;
	/** The human-readable line — the closed-issue title (preferred) or merged-PR title. */
	readonly title: string;
	/** The bare `type:*` value WITHOUT the `type:` prefix (e.g. `feature`), or undefined. */
	readonly type?: string | undefined;
	/** The strategic milestone title this work shipped under, or undefined. */
	readonly milestone?: string | undefined;
	/**
	 * The PR's own product/infra signal — `product` or `infra`, set join-free from the merged
	 * PR's `area:*` label (the convention in `gh-issue-intake-formats.md`). The PREFERRED
	 * source; absent/unknown ⇒ consult `joinedArea`, then default Product.
	 */
	readonly area?: string | undefined;
	/**
	 * The area recovered by the gather's PR→issue→milestone join — the FALLBACK signal, used
	 * only when the PR carries no direct `area:*` label. Prefer `area` (join-free) over this;
	 * absent here too ⇒ default Product. See `resolveSection`.
	 */
	readonly joinedArea?: string | undefined;
	/**
	 * The merged-vs-live-to-users state the gather resolved (the authoritative live-state source) — a `ReleaseState`
	 * string (`live` / `awaiting-release` / `dark` / `unknown`). Absent or unrecognized ⇒
	 * `unknown` (never assumed live). See `resolveReleaseState`.
	 */
	readonly releaseState?: string | undefined;
}

/** The `--since` window the digest reports over, rendered into the heading. */
export interface DigestWindow {
	/** ISO date (`YYYY-MM-DD`) — the `--since` lower bound. */
	readonly since: string;
	/** ISO date (`YYYY-MM-DD`) — the upper bound (typically today). */
	readonly until: string;
}

/** Map a raw area string to its top-level section; absent/unrecognized ⇒ Product. */
export const sectionFor = (area: string | undefined): Section => {
	if (area === undefined) return "Product";
	const normalized = area.trim().toLowerCase();
	return normalized === "infra" ? "Infra" : "Product";
};

/**
 * Resolve an entry's top-level section with the PR-signal-preferred precedence of the
 * `area:*` PR-label convention (the originating work item, documented in `gh-issue-intake-formats.md`):
 * the PR's own product/infra signal (`entry.area`, set join-free from the merged PR's
 * `area:*` label) wins; when it is absent the gather's PR→issue→milestone join fallback
 * (`entry.joinedArea`) is consulted; when neither is present the digest defaults to
 * `Product`. A present-but-blank signal is treated as absent (trimmed); each usable signal
 * is classified through `sectionFor`. This is where "prefer the PR signal, fall back to the
 * join" lives — the join-free readout and its graceful degradation to the child work item's behavior.
 */
export const resolveSection = (entry: ShipEntry): Section => {
	const pr = entry.area?.trim();
	if (pr !== undefined && pr !== "") return sectionFor(pr);
	const joined = entry.joinedArea?.trim();
	if (joined !== undefined && joined !== "") return sectionFor(joined);
	return "Product";
};

/**
 * Resolve an entry's merged-vs-live-to-users state (the authoritative live-state source). Case- and
 * whitespace-insensitive; an absent, blank, or unrecognized value resolves to `unknown` —
 * the "never silently treated as live" default the live axis exists to enforce.
 */
export const resolveReleaseState = (state: string | undefined): ReleaseState => {
	if (state === undefined) return "unknown";
	const normalized = state.trim().toLowerCase();
	return (RELEASE_STATE_ORDER as ReadonlyArray<string>).includes(normalized)
		? (normalized as ReleaseState)
		: "unknown";
};

/** The milestone bucket key for an entry — its title, or `Uncategorized` when absent/blank. */
const milestoneKey = (milestone: string | undefined): string => {
	if (milestone === undefined) return UNCATEGORIZED;
	const trimmed = milestone.trim();
	return trimmed === "" ? UNCATEGORIZED : trimmed;
};

/** The `type:*` bucket key for an entry — a known type, or `Uncategorized` otherwise. */
const typeKey = (type: string | undefined): string => {
	if (type === undefined) return UNCATEGORIZED;
	const trimmed = type.trim();
	return (TYPE_ORDER as ReadonlyArray<string>).includes(trimmed) && trimmed !== UNCATEGORIZED
		? trimmed
		: UNCATEGORIZED;
};

/** A `type:*` bucket with its entries, in `TYPE_ORDER`. */
export interface TypeGroup {
	readonly type: string;
	readonly entries: ReadonlyArray<ShipEntry>;
}

/** A milestone bucket with its type groups. */
export interface MilestoneGroup {
	readonly milestone: string;
	readonly types: ReadonlyArray<TypeGroup>;
}

/** A top-level section with its milestone groups. */
export interface SectionGroup {
	readonly section: Section;
	readonly milestones: ReadonlyArray<MilestoneGroup>;
}

/**
 * Group entries product/infra → milestone → type, totally and losslessly. Milestones sort
 * with a real title before the trailing `Uncategorized`, then alphabetically among titles;
 * types follow `TYPE_ORDER`. Empty buckets are omitted; input order is preserved within a
 * type bucket. Every input entry lands in exactly one leaf — the count is conserved.
 */
export const groupEntries = (entries: ReadonlyArray<ShipEntry>): ReadonlyArray<SectionGroup> => {
	// section -> milestone -> type -> entries
	const bySection = new Map<Section, Map<string, Map<string, ShipEntry[]>>>();
	for (const entry of entries) {
		const section = resolveSection(entry);
		const mKey = milestoneKey(entry.milestone);
		const tKey = typeKey(entry.type);
		const milestones = bySection.get(section) ?? new Map<string, Map<string, ShipEntry[]>>();
		bySection.set(section, milestones);
		const types = milestones.get(mKey) ?? new Map<string, ShipEntry[]>();
		milestones.set(mKey, types);
		const bucket = types.get(tKey) ?? [];
		types.set(tKey, bucket);
		bucket.push(entry);
	}

	const orderMilestones = (keys: ReadonlyArray<string>): ReadonlyArray<string> => {
		const named = keys.filter((k) => k !== UNCATEGORIZED).sort((a, b) => a.localeCompare(b));
		return keys.includes(UNCATEGORIZED) ? [...named, UNCATEGORIZED] : named;
	};

	return SECTION_ORDER.flatMap((section) => {
		const milestones = bySection.get(section);
		if (!milestones || milestones.size === 0) return [];
		const milestoneGroups: MilestoneGroup[] = orderMilestones([...milestones.keys()]).flatMap(
			(mKey) => {
				const types = milestones.get(mKey);
				if (!types || types.size === 0) return [];
				const typeGroups: TypeGroup[] = TYPE_ORDER.flatMap((tKey) => {
					const bucket = types.get(tKey);
					return bucket && bucket.length > 0 ? [{type: tKey, entries: bucket}] : [];
				});
				return typeGroups.length > 0 ? [{milestone: mKey, types: typeGroups}] : [];
			},
		);
		return milestoneGroups.length > 0 ? [{section, milestones: milestoneGroups}] : [];
	});
};

/** The `(#NNN)` backlink — the merged PR (always present) is the primary reference. */
const backlink = (entry: ShipEntry): string => `(#${entry.pr})`;

/** An entry's inline live/dark annotation, e.g. ` — dark` or ` — awaiting release`. */
const releaseAnnotation = (entry: ShipEntry): string =>
	` — ${RELEASE_STATE_LABEL[resolveReleaseState(entry.releaseState)]}`;

const renderEntry = (entry: ShipEntry): string =>
	`- ${entry.title} ${backlink(entry)}${releaseAnnotation(entry)}`;

const typeLabel = (type: string): string => TYPE_LABEL[type] ?? type;

/**
 * The "currently dark — awaiting your release" callout: the entries that merged but are not
 * yet live to users (`dark` behind a default-off flag, or `awaiting-release`), grouped by
 * state in `NOT_YET_LIVE` order, input order preserved within a state. Returns `""` (the
 * callout is omitted) when nothing is not-yet-live — an all-live window has no dark work to
 * surface. `unknown` is deliberately not collected here: it is surfaced inline per entry, not
 * asserted as awaiting-release.
 */
const renderDarkCallout = (entries: ReadonlyArray<ShipEntry>): string => {
	const blocks = NOT_YET_LIVE.flatMap((state) => {
		const inState = entries.filter((entry) => resolveReleaseState(entry.releaseState) === state);
		if (inState.length === 0) return [];
		const lines = inState.map((entry) => `- ${entry.title} ${backlink(entry)}`).join("\n");
		return [`### ${RELEASE_STATE_LABEL[state]}\n\n${lines}`];
	});
	if (blocks.length === 0) return "";
	return `## Currently dark — awaiting your release\n\n${blocks.join("\n\n")}`;
};

/**
 * Render a founder-facing ship digest for a window: a `# Ship digest — since … → until`
 * heading, then — when any work is not yet live — a `## Currently dark — awaiting your
 * release` callout, then a `## Product` / `## Infra` section per non-empty section, each with
 * `### <milestone>` groups and `#### <Type>` blocks whose entries carry an inline live/dark
 * annotation. An empty window emits the heading plus a "nothing shipped" note (an empty
 * window is a fact, not an error).
 */
export const deriveShipDigest = (
	entries: ReadonlyArray<ShipEntry>,
	window: DigestWindow,
): string => {
	const head = `# Ship digest — ${window.since} → ${window.until}`;
	const sections = groupEntries(entries);
	if (sections.length === 0) {
		return `${head}\n\n_Nothing shipped in this window._\n`;
	}
	const darkCallout = renderDarkCallout(entries);
	const sectionBlocks = sections.map((sectionGroup) => {
		const milestoneBlocks = sectionGroup.milestones.map((milestoneGroup) => {
			const typeBlocks = milestoneGroup.types.map((typeGroup) => {
				const lines = typeGroup.entries.map(renderEntry).join("\n");
				return `#### ${typeLabel(typeGroup.type)}\n\n${lines}`;
			});
			return `### ${milestoneGroup.milestone}\n\n${typeBlocks.join("\n\n")}`;
		});
		return `## ${sectionGroup.section}\n\n${milestoneBlocks.join("\n\n")}`;
	});
	const blocks = darkCallout === "" ? sectionBlocks : [darkCallout, ...sectionBlocks];
	return `${head}\n\n${blocks.join("\n\n")}\n`;
};
