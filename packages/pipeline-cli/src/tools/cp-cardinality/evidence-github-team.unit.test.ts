import {describe, expect, it} from "vitest";
import {parseProtectedChangeApprovalPolicy, resolveGithubTeamEvidence} from "./evidence-github-team.ts";

const policy = () => parseProtectedChangeApprovalPolicy({
	schemaVersion: 1,
	github: {shipping: {protectedChangeApproval: {
		authority: {provider: "github-team", organization: null, teamSlug: "delivery-approvers"},
		requiredNonAuthorApprovals: 1,
		soleAuthorException: {enabled: true, commentPattern: "sole-author-exception"},
	}}},
});

const reader = (over: Partial<Record<string, unknown>> = {}) => (path: string): unknown => {
	const fixtures: Record<string, unknown> = {
		"orgs/acme/teams/delivery-approvers/members?per_page=100": [[{login: "author"}, {login: "reviewer"}, {login: "reviewer"}]],
		"repos/acme/widget/pulls/7": {user: {login: "author"}, head: {sha: "head-sha"}},
		"repos/acme/widget/pulls/7/reviews?per_page=100": [[
			{id: 1, user: {login: "reviewer"}, state: "APPROVED", commit_id: "old-head"},
			{id: 2, user: {login: "reviewer"}, state: "APPROVED", commit_id: "head-sha"},
			{id: 3, user: {login: "outsider"}, state: "APPROVED", commit_id: "head-sha"},
		]],
		"repos/acme/widget/issues/7/comments?per_page=100": [[{user: {login: "author"}, body: "sole-author-exception @ head-sha"}]],
		...over,
	};
	return fixtures[path] as unknown;
};

describe("github-team evidence adapter", () => {
	it("resolves current-head eligible facts while excluding stale, duplicate, and outsider reviews", () => {
		const configured = policy();
		expect(configured).not.toBeNull();
		const result = resolveGithubTeamEvidence(configured!, "acme/widget", 7, reader());
		expect(result).toEqual({ok: true, facts: {
			members: ["author", "reviewer"], author: "author", requiredNonAuthorApprovals: 1,
			nonAuthorApprovalsAtHead: 1, soleAuthorExceptionAtHead: true,
		}});
	});

	it("fails closed for invalid policy, incomplete authority, invalid REST payloads, and unreadable reads", () => {
		expect(parseProtectedChangeApprovalPolicy({schemaVersion: 1, github: {shipping: {protectedChangeApproval: {}}}})).toBeNull();
		const configured = policy()!;
		expect(resolveGithubTeamEvidence({...configured, authority: {...configured.authority, teamSlug: null}}, "acme/widget", 7, reader())).toMatchObject({ok: false});
		expect(resolveGithubTeamEvidence(configured, "acme/widget", 7, reader({"repos/acme/widget/pulls/7/reviews?per_page=100": [{bad: true}]}))).toMatchObject({ok: false});
		expect(resolveGithubTeamEvidence(configured, "acme/widget", 7, () => { throw new Error("no permission"); })).toMatchObject({ok: false});
	});

	it("fails closed when a GitHub review id is not a safe integer", () => {
		const configured = policy()!;
		const reviewPath = "repos/acme/widget/pulls/7/reviews?per_page=100";
		for (const id of ["2", 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, null]) {
			expect(resolveGithubTeamEvidence(configured, "acme/widget", 7, reader({
			[reviewPath]: [{id, user: {login: "reviewer"}, state: "APPROVED", commit_id: "head-sha"}],
		}))).toMatchObject({ok: false});
		}
	});

	it("requires both the configured exception pattern and the current head binding", () => {
		const configured = policy()!;
		const result = resolveGithubTeamEvidence(configured, "acme/widget", 7, reader({"repos/acme/widget/issues/7/comments?per_page=100": [[{user: {login: "author"}, body: "sole-author-exception @ old-head"}]]}));
		expect(result).toEqual(expect.objectContaining({ok: true, facts: expect.objectContaining({soleAuthorExceptionAtHead: false})}));
	});
});
