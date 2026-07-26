import {describe, expect, it} from "vitest";
import {
	classifyProtectedDeletions,
	decidePrimaryIndexCommit,
	decidePrimaryIndexRecord,
	normalizeProtectedPathPrefix,
	parseNameStatus,
	type PrimaryIndexInput,
	type StagedEntry,
} from "./primary-index-guard.ts";

const del = (path: string): StagedEntry => ({status: "D", path});
const policy = {
	enabled: true,
	protectedPathPrefixes: ["config", "governance/docs"],
	blockThreshold: 3,
	attribution: {enabled: true, threshold: 2, logPath: null},
} as const;
const input = (over: Partial<PrimaryIndexInput> = {}): PrimaryIndexInput => ({
	onPrimaryCheckout: true,
	staged: [],
	policy,
	cwd: "/repo",
	operator: "agent",
	sessionId: "session",
	at: "2026-07-26T00:00:00.000Z",
	...over,
});

describe("primary-index guard classifier", () => {
	it("matches only configured boundaries, not source-project defaults or prefix lookalikes", () => {
		expect(classifyProtectedDeletions([del("config/a"), del("configuration/a"), del("unconfigured/a")], ["config"])).toMatchObject({stagedDeletionCount: 3, protectedDeletionCount: 1, sampleProtectedDeletions: ["config/a"]});
	});

	it("accepts normalized prefixes and rejects absolute, traversal, and malformed policy values", () => {
		expect(normalizeProtectedPathPrefix("config/")).toBe("config");
		expect(normalizeProtectedPathPrefix("/config")).toBeNull();
		expect(normalizeProtectedPathPrefix("../config")).toBeNull();
		expect(normalizeProtectedPathPrefix("config/../secret")).toBeNull();
	});

	it("parses only valid tab-separated name-status rows", () => {
		expect(parseNameStatus("D\tconfig/a\ninvalid\nM\tconfig/b\n")).toEqual([{status: "D", path: "config/a"}, {status: "M", path: "config/b"}]);
	});
});

describe("primary-index guard deliberate refusal", () => {
	it("refuses exactly at the configured protected-deletion threshold", () => {
		const decision = decidePrimaryIndexCommit(input({staged: [del("config/a"), del("config/b"), del("governance/docs/c")] }));
		expect(decision.kind).toBe("refuse");
		if (decision.kind === "refuse") expect(decision.record.sampleProtectedDeletions).toHaveLength(3);
	});

	it("allows threshold minus one and a mass ordinary-source deletion", () => {
		expect(decidePrimaryIndexCommit(input({staged: [del("config/a"), del("config/b")] })).kind).toBe("allow");
		expect(decidePrimaryIndexCommit(input({staged: Array.from({length: 300}, (_, index) => del(`src/obsolete/${index}.ts`))})).kind).toBe("allow");
	});

	it("allows a qualifying deletion unless the checkout is proven primary", () => {
		expect(decidePrimaryIndexCommit(input({onPrimaryCheckout: false, staged: [del("config/a"), del("config/b"), del("config/c")]})).kind).toBe("allow");
	});

	it("records in a linked worktree without turning observation into refusal", () => {
		const record = decidePrimaryIndexRecord(input({onPrimaryCheckout: false, staged: [del("config/a"), del("config/b")]}));
		expect(record).toMatchObject({kind: "record", record: {onPrimaryCheckout: false, protectedDeletionCount: 2}});
	});
});
