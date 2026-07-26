import {assert, describe, it} from "@effect/vitest";
import {
	deriveShipDigest,
	GENERIC_SHIP_DIGEST_DISPLAY_POLICY,
	groupEntries,
	type ReleaseState,
	resolveCategory,
	resolveReleaseState,
	type ShipDigestDisplayPolicy,
	type ShipEntry,
} from "./digest.ts";

const entry = (over: Partial<ShipEntry> & {pr: number}): ShipEntry => ({title: `entry ${over.pr}`, ...over});
const WINDOW = {since: "2026-06-01", until: "2026-07-01"} as const;

const POLICY: ShipDigestDisplayPolicy = {
	categories: {
		order: ["customer", "platform"],
		labels: {customer: "Customer-facing", platform: "Platform and operations"},
		fallbackLabel: "Uncategorized",
	},
	types: {
		order: ["feature", "bug", "maintenance"],
		labels: {feature: "Features", bug: "Fixes", maintenance: "Maintenance"},
		fallbackLabel: "Uncategorized",
	},
	preserveUnconfiguredValues: false,
};

describe("resolveCategory — direct signal before joined fallback", () => {
	it("uses a direct canonical category without a join", () => {
		assert.strictEqual(resolveCategory(entry({pr: 1, category: "platform"})), "platform");
	});

	it("prefers direct category over the joined fallback", () => {
		assert.strictEqual(
			resolveCategory(entry({pr: 1, category: "customer", joinedCategory: "platform"})),
			"customer",
		);
	});

	it("uses the joined category when the direct signal is absent or blank", () => {
		assert.strictEqual(resolveCategory(entry({pr: 1, joinedCategory: "platform"})), "platform");
		assert.strictEqual(resolveCategory(entry({pr: 2, category: "   ", joinedCategory: "platform"})), "platform");
	});

	it("does not invent a category when neither signal exists", () => {
		assert.strictEqual(resolveCategory(entry({pr: 1})), undefined);
	});
});

describe("groupEntries — generic category → milestone → type", () => {
	it("uses configured category/type ordering and fallback-last behavior", () => {
		const groups = groupEntries([
			entry({pr: 1, category: "platform", milestone: "M", type: "maintenance"}),
			entry({pr: 2, category: "customer", milestone: "M", type: "feature"}),
			entry({pr: 3, category: "unknown-category", milestone: "M", type: "unrecognized"}),
		], POLICY);
		assert.deepStrictEqual(groups.map((group) => group.category), ["customer", "platform", "Uncategorized"]);
		assert.deepStrictEqual(groups[0]?.milestones[0]?.types.map((type) => type.type), ["feature"]);
		assert.deepStrictEqual(groups[2]?.milestones[0]?.types.map((type) => type.type), ["Uncategorized"]);
	});

	it("sorts named milestones before the visible fallback and preserves leaf input order", () => {
		const groups = groupEntries([
			entry({pr: 10, category: "customer", type: "feature"}),
			entry({pr: 11, category: "customer", milestone: "Beta", type: "feature"}),
			entry({pr: 12, category: "customer", milestone: "Alpha", type: "feature"}),
			entry({pr: 13, category: "customer", milestone: "Alpha", type: "feature"}),
		], POLICY);
		assert.deepStrictEqual(groups[0]?.milestones.map((milestone) => milestone.milestone), ["Alpha", "Beta", "Uncategorized"]);
		assert.deepStrictEqual(groups[0]?.milestones[0]?.types[0]?.entries.map((item) => item.pr), [12, 13]);
	});

	it("conserves every entry, including missing or invalid metadata", () => {
		const input = [
			entry({pr: 1, category: "customer", type: "feature"}),
			entry({pr: 2, category: "platform", type: "bug"}),
			entry({pr: 3}),
			entry({pr: 4, category: "other", type: "other"}),
		];
		const leaves = groupEntries(input, POLICY).flatMap((category) =>
			category.milestones.flatMap((milestone) => milestone.types.flatMap((type) => type.entries)),
		);
		assert.strictEqual(leaves.length, input.length);
	});

	it("uses dynamic, deterministic metadata headings when no repository policy is available", () => {
		const groups = groupEntries([
			entry({pr: 1, category: "Zebra", type: "maintenance"}),
			entry({pr: 2, category: "Alpha", type: "feature"}),
		], GENERIC_SHIP_DIGEST_DISPLAY_POLICY);
		assert.deepStrictEqual(groups.map((group) => group.category), ["Alpha", "Zebra"]);
		assert.deepStrictEqual(groups[0]?.milestones[0]?.types.map((type) => type.type), ["feature"]);
	});
});

describe("release state safety", () => {
	it("normalizes known states and defaults all missing or unrecognized values to unknown", () => {
		for (const state of ["live", "awaiting-release", "dark"] as const) {
			assert.strictEqual(resolveReleaseState(state), state);
		}
		assert.strictEqual(resolveReleaseState("  DARK "), "dark");
		const unknown: ReleaseState = resolveReleaseState(undefined);
		assert.strictEqual(unknown, "unknown");
		assert.strictEqual(resolveReleaseState("mystery"), "unknown");
	});
});

describe("deriveShipDigest — stakeholder-facing rendering", () => {
	it("renders configured labels, hierarchy, backlinks, and one trailing newline", () => {
		const markdown = deriveShipDigest([
			entry({pr: 42, category: "customer", milestone: "Beta", type: "feature", title: "Add dashboard", releaseState: "live"}),
		], WINDOW, POLICY);
		assert.match(markdown, /^# Ship digest — 2026-06-01 → 2026-07-01/);
		assert.include(markdown, "## Customer-facing");
		assert.include(markdown, "### Beta");
		assert.include(markdown, "#### Features");
		assert.include(markdown, "- Add dashboard (#42) — live");
		assert.isTrue(markdown.endsWith("\n"));
	});

	it("renders empty windows as a successful fact", () => {
		assert.include(deriveShipDigest([], WINDOW, POLICY), "_Nothing shipped in this window._");
	});

	it("places dark and awaiting-release work in a release-action callout before groups", () => {
		const markdown = deriveShipDigest([
			entry({pr: 1, category: "customer", type: "feature", title: "Dark work", releaseState: "dark"}),
			entry({pr: 2, category: "customer", type: "feature", title: "Queued work", releaseState: "awaiting-release"}),
			entry({pr: 3, category: "customer", type: "feature", title: "Unknown work"}),
		], WINDOW, POLICY);
		assert.include(markdown, "## Needs release attention");
		assert.include(markdown, "### dark");
		assert.include(markdown, "### awaiting release");
		assert.isBelow(markdown.indexOf("## Needs release attention"), markdown.indexOf("## Customer-facing"));
		assert.include(markdown, "- Unknown work (#3) — release state unknown");
		assert.notInclude(markdown.slice(0, markdown.indexOf("## Customer-facing")), "Unknown work");
	});

	it("does not emit release-action callout for live or unknown-only work", () => {
		const markdown = deriveShipDigest([
			entry({pr: 1, category: "customer", type: "feature", releaseState: "live"}),
			entry({pr: 2, category: "customer", type: "feature"}),
		], WINDOW, POLICY);
		assert.notInclude(markdown, "## Needs release attention");
	});
});
