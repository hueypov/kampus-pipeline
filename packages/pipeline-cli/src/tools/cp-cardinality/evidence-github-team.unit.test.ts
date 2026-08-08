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

const collaboratorPolicy = () => parseProtectedChangeApprovalPolicy({
	schemaVersion: 1,
	github: {shipping: {protectedChangeApproval: {
		authority: {provider: "github-collaborators", organization: null, teamSlug: null},
		requiredNonAuthorApprovals: 1,
		soleAuthorException: {enabled: true, commentPattern: "sole-author-exception"},
	}}},
});

/** The shape `GET /repos/{owner}/{repo}/collaborators` returns, trimmed to what the roster reads. */
const collaborator = (login: string, push: boolean) => ({
	login,
	permissions: {admin: push, maintain: push, pull: true, push, triage: true},
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

	it("rosters push-capable repository collaborators when the authority names that provider", () => {
		const configured = collaboratorPolicy();
		expect(configured).not.toBeNull();
		const result = resolveGithubTeamEvidence(configured!, "acme/widget", 7, reader({
			"repos/acme/widget/collaborators?per_page=100": [[
				collaborator("author", true),
				collaborator("reviewer", true),
				collaborator("read-only", false),
			]],
		}));
		// The read-only collaborator is listed by the API but is not approval authority, so it is
		// neither a member nor counted toward the non-author capacity.
		expect(result).toEqual({ok: true, facts: {
			members: ["author", "reviewer"], author: "author", requiredNonAuthorApprovals: 1,
			nonAuthorApprovalsAtHead: 1, soleAuthorExceptionAtHead: true,
		}});
	});

	it("fails closed when a collaborator's permissions cannot be read", () => {
		const configured = collaboratorPolicy()!;
		for (const permissions of [undefined, null, {}, {push: "yes"}]) {
			expect(resolveGithubTeamEvidence(configured, "acme/widget", 7, reader({
				"repos/acme/widget/collaborators?per_page=100": [[{login: "reviewer", permissions}]],
			}))).toMatchObject({ok: false});
		}
	});

	it("rejects an authority whose provider and coordinates disagree", () => {
		const section = (authority: unknown) => ({
			schemaVersion: 1,
			github: {shipping: {protectedChangeApproval: {
				authority, requiredNonAuthorApprovals: 1,
				soleAuthorException: {enabled: false, commentPattern: null},
			}}},
		});
		// The shipped default (team provider, no slug) stays parseable — "not configured yet" is not
		// malformed — and refuses at resolve instead of widening to the repository roster.
		const unconfigured = parseProtectedChangeApprovalPolicy(section({provider: "github-team", organization: null, teamSlug: null}));
		expect(unconfigured).not.toBeNull();
		expect(resolveGithubTeamEvidence(unconfigured!, "acme/widget", 7, reader())).toMatchObject({ok: false});
		// A collaborator authority carrying team coordinates is a half-done migration.
		expect(parseProtectedChangeApprovalPolicy(section({provider: "github-collaborators", organization: null, teamSlug: "delivery-approvers"}))).toBeNull();
		expect(parseProtectedChangeApprovalPolicy(section({provider: "github-collaborators", organization: "acme", teamSlug: null}))).toBeNull();
		expect(parseProtectedChangeApprovalPolicy(section({provider: "github-org", organization: null, teamSlug: null}))).toBeNull();
	});

	it("requires both the configured exception pattern and the current head binding", () => {
		const configured = policy()!;
		const result = resolveGithubTeamEvidence(configured, "acme/widget", 7, reader({"repos/acme/widget/issues/7/comments?per_page=100": [[{user: {login: "author"}, body: "sole-author-exception @ old-head"}]]}));
		expect(result).toEqual(expect.objectContaining({ok: true, facts: expect.objectContaining({soleAuthorExceptionAtHead: false})}));
	});
});
