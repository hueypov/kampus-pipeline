import type {GhCompatibilityPolicy} from "./policy.ts";

export type GhRoute =
	| {readonly kind: "passthrough"; readonly argv: ReadonlyArray<string>}
	| {readonly kind: "rewrite"; readonly argv: ReadonlyArray<string>; readonly reason: string; readonly stripped: ReadonlyArray<string>}
	| {readonly kind: "block"; readonly reason: string; readonly hint: string};

const flagValue = (argv: ReadonlyArray<string>, flag: string): string | null => {
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index];
		if (value === flag) return argv[index + 1] ?? null;
		if (value?.startsWith(`${flag}=`)) return value.slice(flag.length + 1);
	}
	return null;
};

const jsonFields = (raw: string): ReadonlyArray<string> => raw.split(",").map((field) => field.trim()).filter(Boolean);

export const isMilestoneTitle = (value: string): boolean => !/^\d+$/.test(value.trim());

const blocked = (reason: string, hint: string): GhRoute => ({kind: "block", reason, hint});

const routeEdit = (verb: string, rest: ReadonlyArray<string>, repo: string | null, policy: GhCompatibilityPolicy, bodyFileExists: (path: string) => boolean): GhRoute => {
	if (!policy.graphql.rewriteIssueAndPrEdit) {
		return blocked(`gh ${verb} edit is restricted by this repository's GitHub compatibility policy, but no REST rewrite is enabled.`, "Enable rewriteIssueAndPrEdit or use the repository-approved REST command.");
	}
	if (repo === null) return blocked("A REST rewrite needs a target repository, but none could be resolved.", "Set github.cliCompatibility.targetRepository or run inside a repository gh can resolve.");
	const target = rest.find((arg) => /^\d+$/.test(arg));
	if (target === undefined) return blocked(`gh ${verb} edit has no numeric target and cannot be rewritten safely.`, "Pass an issue or pull-request number, or use an explicit repository REST request.");
	const argv: string[] = ["api", "-X", "PATCH", `repos/${repo}/issues/${target}`];
	const stripped: string[] = [];
	const bodyFile = flagValue(rest, "--body-file");
	if (bodyFile !== null) {
		if (!bodyFileExists(bodyFile)) return blocked(`--body-file path does not exist: ${bodyFile}`, "Write the body file first; never issue a REST mutation from a missing path.");
		argv.push("-F", `body=@${bodyFile}`);
	}
	const body = flagValue(rest, "--body");
	if (body !== null) argv.push("-f", `body=${body}`);
	const title = flagValue(rest, "--title");
	if (title !== null) argv.push("-f", `title=${title}`);
	const milestone = flagValue(rest, "--milestone");
	if (milestone !== null) {
		if (isMilestoneTitle(milestone)) stripped.push(`milestone-title:${milestone}`);
		else argv.push("-F", `milestone=${milestone.trim()}`);
	}
	for (const flag of ["--add-project", "--remove-project"]) {
		const value = flagValue(rest, flag);
		if (value !== null) stripped.push(`${flag} ${value}`);
	}
	if (argv.length === 4 && stripped.length === 0) return blocked(`gh ${verb} edit has no safely rewritable field.`, "Use an explicit repository REST request with a supported field.");
	return {kind: "rewrite", argv, reason: `gh ${verb} edit was rewritten to the repository's configured REST PATCH path.`, stripped};
};

const routeView = (argv: ReadonlyArray<string>, rest: ReadonlyArray<string>, policy: GhCompatibilityPolicy): GhRoute => {
	const raw = flagValue(rest, "--json");
	if (raw === null) return {kind: "passthrough", argv};
	const unsupported = new Set(policy.graphql.unsupportedJsonFields);
	const requested = jsonFields(raw);
	const stripped = requested.filter((field) => unsupported.has(field));
	if (stripped.length === 0) return {kind: "passthrough", argv};
	const safe = requested.filter((field) => !unsupported.has(field));
	if (safe.length === 0) return blocked(`The requested JSON projection contains only unsupported fields: ${stripped.join(", ")}.`, "Remove those fields or use the repository-approved provider adapter.");
	const rebuilt: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index];
		if (value === "--json") { rebuilt.push("--json", safe.join(",")); index++; }
		else if (value?.startsWith("--json=")) rebuilt.push(`--json=${safe.join(",")}`);
		else if (value !== undefined) rebuilt.push(value);
	}
	return {kind: "rewrite", argv: rebuilt, reason: "Unsupported configured JSON fields were removed from the gh view projection.", stripped};
};

/** Pure argv router. With a disabled or passthrough policy it leaves ordinary gh behavior untouched. */
export const routeGh = (argv: ReadonlyArray<string>, options: {readonly policy: GhCompatibilityPolicy; readonly repo: string | null; readonly bodyFileExists?: (path: string) => boolean}): GhRoute => {
	const {policy} = options;
	if (!policy.enabled || policy.graphql.mode !== "rest-only") return {kind: "passthrough", argv};
	const [verb, sub, ...rest] = argv;
	// This is the explicit GraphQL transport rather than an ordinary REST `gh api` call.
	// A repository that opts into REST-only compatibility must not silently forward it.
	if (verb === "api" && sub === "graphql") {
		return blocked("gh api graphql is restricted by this repository's REST-only compatibility policy.", "Use a repository REST endpoint or the repository-approved provider adapter.");
	}
	if (verb !== undefined && policy.graphql.blockVerbs.includes(verb)) {
		return blocked(`gh ${verb} is restricted by this repository's GitHub compatibility policy.`, "Use the repository-approved REST/provider adapter instead.");
	}
	if ((verb === "pr" || verb === "issue") && sub === "edit") return routeEdit(verb, rest, options.repo, policy, options.bodyFileExists ?? (() => true));
	if ((verb === "pr" || verb === "issue") && sub === "view") return routeView(argv, rest, policy);
	return {kind: "passthrough", argv};
};
