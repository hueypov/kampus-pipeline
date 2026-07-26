import {describe, expect, it} from "vitest";
import {DEFAULT_GH_COMPATIBILITY_POLICY, type GhCompatibilityPolicy} from "./policy.ts";
import {routeGh} from "./router.ts";

const restricted = (overrides: Partial<GhCompatibilityPolicy["graphql"]> = {}): GhCompatibilityPolicy => ({
	...DEFAULT_GH_COMPATIBILITY_POLICY,
	enabled: true,
	graphql: {
		mode: "rest-only",
		blockVerbs: ["project"],
		unsupportedJsonFields: ["projects", "projectItems"],
		rewriteIssueAndPrEdit: true,
		...overrides,
	},
});

describe("routeGh", () => {
	it("blocks the explicit GraphQL transport in REST-only mode", () => {
		const route = routeGh(["api", "graphql", "-f", "query={viewer{login}}"], {policy: restricted(), repo: "owner/repo"});
		expect(route.kind).toBe("block");
		if (route.kind === "block") expect(route.reason).toContain("gh api graphql");
	});

	it("preserves ordinary gh behavior while compatibility is disabled", () => {
		expect(routeGh(["pr", "edit", "42", "--body", "hello"], {policy: DEFAULT_GH_COMPATIBILITY_POLICY, repo: "owner/repo"})).toMatchObject({kind: "passthrough"});
	});

	it("rewrites a configured edit to a validated REST patch", () => {
		expect(routeGh(["pr", "edit", "42", "--body", "hello"], {policy: restricted(), repo: "owner/repo"})).toMatchObject({
			kind: "rewrite",
			argv: ["api", "-X", "PATCH", "repos/owner/repo/issues/42", "-f", "body=hello"],
		});
	});

	it("blocks a configured unsupported verb and a rewrite without a repository", () => {
		expect(routeGh(["project", "list"], {policy: restricted(), repo: "owner/repo"})).toMatchObject({kind: "block"});
		expect(routeGh(["issue", "edit", "42", "--title", "x"], {policy: restricted(), repo: null})).toMatchObject({kind: "block"});
	});

	it("strips only the configured unsupported JSON fields", () => {
		expect(routeGh(["pr", "view", "42", "--json", "title,projects"], {policy: restricted(), repo: "owner/repo"})).toMatchObject({
			kind: "rewrite",
			argv: ["pr", "view", "42", "--json", "title"],
			stripped: ["projects"],
		});
	});
});
