/**
 * The GitHub boundary: decode untrusted `gh api` JSON into a domain
 * `WayfinderMapLedger` (`decodeMapLedger`), plus the live `Github` capabilities
 * that read one and replace a map body by shelling `gh api` REST.
 *
 * Decode it here, where genuinely untyped REST responses enter — and not past it:
 * everything downstream (`validateMap`, `isGraduationReady`, `mapSignature`) is
 * total over the decoded ledger. The raw GitHub shapes are decoded leniently (only
 * the fields the floor needs) and the map body's four sections are parsed at decode
 * time, so the domain model never carries raw markdown and the validator never
 * parses. The map's real sub-issues — number and open/closed state — come from the
 * `sub_issues` endpoint, resolved here at the boundary, never by parsing the body:
 * a body cannot tell you whether the ticket it lists has since been closed.
 *
 * REST only, never GraphQL (broken on the kamp-us org). Every infrastructure failure is a
 * typed error in the `E` channel, never a thrown exception.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import type {SubIssueState, WayfinderMapLedger} from "./Map.ts";
import {parseMapBody} from "./markdown.ts";

/** A null/absent issue body normalizes to the empty string before parsing. */
const GithubBody = Schema.optionalKey(Schema.NullOr(Schema.String));

/** The raw GitHub issue fields the ledger needs, lenient on everything else. */
const GithubIssue = Schema.Struct({
	number: Schema.Number,
	body: GithubBody,
});

/**
 * A sub-issue ref as the `sub_issues` endpoint returns it: its number and its
 * `state`. `state` is decoded as a lenient optional string rather than the domain's
 * closed `"open" | "closed"` union so that a missing, null, or unrecognized wire
 * value degrades to "state unresolved" instead of failing the whole decode — the
 * map is still worth validating structurally when GitHub says something we do not
 * model.
 */
const SubIssueRef = Schema.Struct({
	number: Schema.Number,
	state: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/** The untrusted input: the map issue plus its native sub-issues' numbers. */
export const GithubMapInput = Schema.Struct({
	map: GithubIssue,
	subIssues: Schema.Array(SubIssueRef),
});
export type GithubMapInput = (typeof GithubMapInput)["Type"];

const decodeInput = Schema.decodeUnknownEffect(GithubMapInput);

const bodyOf = (body: string | null | undefined): string => body ?? "";

/** Narrow the wire's free-form `state` onto the domain union; anything else is unresolved. */
const stateOf = (state: string | null | undefined): SubIssueState | undefined =>
	state === "open" || state === "closed" ? state : undefined;

const toLedger = (input: GithubMapInput): WayfinderMapLedger => ({
	number: input.map.number,
	map: parseMapBody(bodyOf(input.map.body)),
	subIssues: input.subIssues.map((s) => ({number: s.number, state: stateOf(s.state)})),
});

/**
 * Decode untrusted GitHub JSON into a `WayfinderMapLedger`, parsing the map body's
 * four sections and reading its sub-issue numbers at the boundary. Fails with
 * Schema's `SchemaError` if the JSON is structurally malformed (missing `number`);
 * succeeds with a ledger ready for `validateMap` otherwise.
 */
export const decodeMapLedger = (
	input: unknown,
): Effect.Effect<WayfinderMapLedger, Schema.SchemaError> =>
	Effect.map(decodeInput(input), toLedger);

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"wayfinder-map/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"wayfinder-map/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"wayfinder-map/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

/**
 * Run `gh <args>` and return stdout, failing `GhCommandError` on a non-zero exit.
 * A spawn/IO `PlatformError` (e.g. `gh` not on PATH) folds into the same typed
 * error (exit code `-1`); the `E` channel carries only this package's typed
 * errors, never a raw platform fault.
 */
const runGh = Effect.fn("Github.runGh")(
	function* (args: ReadonlyArray<string>) {
		const handle = yield* ChildProcess.make("gh", args);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
			{concurrency: "unbounded"},
		);
		if (exitCode !== 0) {
			return yield* new GhCommandError({args, exitCode, stderr});
		}
		return stdout;
	},
	Effect.scoped,
	(effect, args) =>
		Effect.catchTag(
			effect,
			"PlatformError",
			(cause) => new GhCommandError({args, exitCode: -1, stderr: cause.message}),
		),
);

const parseJson = (
	args: ReadonlyArray<string>,
	raw: string,
): Effect.Effect<unknown, GhParseError> =>
	Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: (cause) =>
			new GhParseError({args, message: cause instanceof Error ? cause.message : String(cause)}),
	});

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Resolve the target repo (`owner/name`) once, per the repository-resolution contract §1, in order:
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never
 * silently defaults to a repo: with no env and no resolvable current repo it fails
 * `RepoResolutionError`, so a foreign install can't accidentally operate on example-repo.
 */
const resolveRepo = Effect.fn("Github.resolveRepo")(function* () {
	const fromEnv = process.env.CLAUDE_PIPELINE_REPO ?? process.env.GITHUB_REPOSITORY;
	if (fromEnv && REPO_RE.test(fromEnv.trim())) {
		return fromEnv.trim();
	}
	const viewed = yield* runGh([
		"repo",
		"view",
		"--json",
		"nameWithOwner",
		"-q",
		".nameWithOwner",
	]).pipe(
		Effect.map((out) => out.trim()),
		Effect.catchTag("wayfinder-map/GhCommandError", () => Effect.succeed("")),
	);
	if (REPO_RE.test(viewed)) {
		return viewed;
	}
	return yield* new RepoResolutionError({
		message:
			"could not resolve a target repo: set CLAUDE_PIPELINE_REPO (or GITHUB_REPOSITORY), " +
			"or run inside a git repo whose origin `gh repo view` can read",
	});
});

const issueArgs = (repo: string, number: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/${number}`,
];

const subIssuesArgs = (repo: string, number: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/${number}/sub_issues?per_page=100`,
];

/**
 * The body PATCH. The body travels as one `-f body=<value>` argv element, by value
 * — never `-f body=@<path>`, which `gh` takes verbatim and would publish a
 * machine-local path as the map's body (formats §Posting a comment body).
 */
const patchBodyArgs = (repo: string, number: number, body: string): ReadonlyArray<string> => [
	"api",
	"--method",
	"PATCH",
	`repos/${repo}/issues/${number}`,
	"-f",
	`body=${body}`,
];

const decodeSubIssueRefs = Schema.decodeUnknownEffect(Schema.Array(SubIssueRef));

/** The one field a body PATCH reads back — the body that actually landed. */
const PatchedIssue = Schema.Struct({body: GithubBody});
const decodePatchedIssue = Schema.decodeUnknownEffect(PatchedIssue);

/** A map issue as a read-modify-write sees it: the raw body plus its parsed ledger. */
export interface MapSource {
	readonly ledger: WayfinderMapLedger;
	/** The exact body the ledger was parsed from — what the write path edits and the precondition compares. */
	readonly body: string;
}

type GithubError = RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError;

/**
 * `Github` — the IO shell over `gh api` REST, and the map's sanctioned write path.
 * `wayfinder` WORK mode mutates the map only through this tool, so the mutation
 * lives here rather than in hand-rolled markdown slicing by a skill
 * (`wayfinder/SKILL.md` §Map state is read and written through the `wayfinder-map`
 * CLI). Built by `GithubLive`, whose `R` is `ChildProcessSpawner`.
 *
 * `mapSource` returns the raw body alongside the ledger because the write is a
 * read-modify-write: the body the edit is computed against is the same body the
 * pre-write precondition compares. `mapBody` is that precondition's cheap re-read,
 * and `replaceMapBody` returns what landed so the caller can prove it.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly mapLedger: (mapNumber: number) => Effect.Effect<WayfinderMapLedger, GithubError>;
		readonly mapSource: (mapNumber: number) => Effect.Effect<MapSource, GithubError>;
		readonly mapBody: (mapNumber: number) => Effect.Effect<string, GithubError>;
		readonly replaceMapBody: (
			mapNumber: number,
			body: string,
		) => Effect.Effect<string, GithubError>;
	}
>()("wayfinder-map/Github") {}

const json = Effect.fn("Github.json")(function* (args: ReadonlyArray<string>) {
	return yield* parseJson(args, yield* runGh(args));
});

const decodeIssue = Schema.decodeUnknownEffect(GithubIssue);

const loadMapSource = Effect.fn("Github.mapSource")(function* (repo: string, mapNumber: number) {
	const issue = yield* decodeIssue(yield* json(issueArgs(repo, mapNumber)));
	const subIssues = yield* decodeSubIssueRefs(yield* json(subIssuesArgs(repo, mapNumber)));
	return {ledger: toLedger({map: issue, subIssues}), body: bodyOf(issue.body)};
});

const loadMapBody = Effect.fn("Github.mapBody")(function* (repo: string, mapNumber: number) {
	return bodyOf((yield* decodeIssue(yield* json(issueArgs(repo, mapNumber)))).body);
});

const patchMapBody = Effect.fn("Github.replaceMapBody")(function* (
	repo: string,
	mapNumber: number,
	body: string,
) {
	const landed = yield* decodePatchedIssue(yield* json(patchBodyArgs(repo, mapNumber, body)));
	return bodyOf(landed.body);
});

/**
 * The live `Github` layer. The `ChildProcessSpawner` dependency is captured once
 * at construction and provided into each method body, so the service's public
 * methods carry `R = never`. Repo resolution is deferred to first use
 * (`Effect.cached`), so the layer build is side-effect-free and `--help` never
 * triggers it; a real subcommand resolves it once per process.
 */
export const GithubLive: Layer.Layer<Github, never, ChildProcessSpawner.ChildProcessSpawner> =
	Layer.effect(Github)(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const withSpawner = <A, E>(
				effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
			const repo = yield* Effect.cached(withSpawner(resolveRepo()));
			const onRepo = <A, E>(
				use: (r: string) => Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) => repo.pipe(Effect.flatMap((r) => withSpawner(use(r))));
			return {
				mapLedger: (mapNumber: number) =>
					onRepo((r) => loadMapSource(r, mapNumber)).pipe(Effect.map((s) => s.ledger)),
				mapSource: (mapNumber: number) => onRepo((r) => loadMapSource(r, mapNumber)),
				mapBody: (mapNumber: number) => onRepo((r) => loadMapBody(r, mapNumber)),
				replaceMapBody: (mapNumber: number, body: string) =>
					onRepo((r) => patchMapBody(r, mapNumber, body)),
			};
		}),
	);
