import {describe, expect, it} from "vitest";
import {type CpCardinalityInput, decideCpCardinality} from "./cp-cardinality.ts";

const input = (over: Partial<CpCardinalityInput> = {}): CpCardinalityInput => ({
	members: [],
	author: "author",
	requiredNonAuthorApprovals: 1,
	nonAuthorApprovalsAtHead: 0,
	soleAuthorExceptionAtHead: false,
	...over,
});

describe("decideCpCardinality", () => {
	it("fails closed for empty, blank-only, and unresolvable authority facts", () => {
		expect(decideCpCardinality(input()).reasonCode).toBe("empty-approval-authority");
		expect(decideCpCardinality(input({members: ["", "  "]})).n).toBe(0);
		expect(decideCpCardinality(input({members: ["reviewer"], author: "  ", nonAuthorApprovalsAtHead: 1})).reasonCode).toBe("blank-author");
	});

	it("normalizes exact member identities without case-folding", () => {
		const result = decideCpCardinality(input({members: ["  author", "author ", "reviewer", ""], nonAuthorApprovalsAtHead: 1}));
		expect(result).toMatchObject({decision: "discharge", n: 2, branch: "multi-member"});
	});

	it("allows the narrow sole-author exception only in the one-member author branch", () => {
		expect(decideCpCardinality(input({members: ["author"], soleAuthorExceptionAtHead: true})).decision).toBe("discharge");
		expect(decideCpCardinality(input({members: ["author"], soleAuthorExceptionAtHead: false})).reasonCode).toBe("sole-author-exception-missing");
		expect(decideCpCardinality(input({members: ["reviewer"], soleAuthorExceptionAtHead: true})).decision).toBe("stop");
		expect(decideCpCardinality(input({members: ["author", "reviewer"], soleAuthorExceptionAtHead: true})).decision).toBe("stop");
	});

	it("uses a validated count for one-member-other and multi-member authority", () => {
		expect(decideCpCardinality(input({members: ["reviewer"], nonAuthorApprovalsAtHead: 1})).decision).toBe("discharge");
		expect(decideCpCardinality(input({members: ["author", "reviewer", "another"], requiredNonAuthorApprovals: 2, nonAuthorApprovalsAtHead: 1})).reasonCode).toBe("insufficient-non-author-approvals");
		expect(decideCpCardinality(input({members: ["author", "reviewer", "another"], requiredNonAuthorApprovals: 2, nonAuthorApprovalsAtHead: 2})).decision).toBe("discharge");
	});

	it("fails closed for impossible thresholds and malformed runtime counts", () => {
		expect(decideCpCardinality(input({members: ["reviewer"], requiredNonAuthorApprovals: 2, nonAuthorApprovalsAtHead: 2})).reasonCode).toBe("required-approvals-exceed-authority-capacity");
		expect(decideCpCardinality(input({members: ["reviewer"], requiredNonAuthorApprovals: 0})).reasonCode).toBe("invalid-required-non-author-approvals");
		expect(decideCpCardinality(input({members: ["reviewer"], nonAuthorApprovalsAtHead: -1})).reasonCode).toBe("invalid-non-author-approvals-at-head");
	});
});
