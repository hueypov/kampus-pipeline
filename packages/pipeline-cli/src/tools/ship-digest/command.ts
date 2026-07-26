/**
 * `pipeline-cli ship-digest derive` renders pre-gathered merged-work facts.
 *
 * It deliberately has no Git, tracker, provider, or credential behavior. A repository
 * adapter gathers and resolves those facts; this command validates the handoff, loads
 * optional display policy, and sends the pure renderer's Markdown to stdout or `--out`.
 */
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {Console, Effect} from "effect";
import * as Schema from "effect/Schema";
import {Command, Flag} from "effect/unstable/cli";
import {
	GENERIC_SHIP_DIGEST_DISPLAY_POLICY,
	type DigestWindow,
	deriveShipDigest,
	type ShipDigestAxisDisplayPolicy,
	type ShipDigestDisplayPolicy,
	type ShipEntry,
} from "./digest.ts";

class EntriesReadError extends Schema.TaggedErrorClass<EntriesReadError>()("EntriesReadError", {
	file: Schema.String,
	cause: Schema.Unknown,
}) {}

/** The external JSON shape, including temporary aliases accepted only at this boundary. */
const EntrySchema = Schema.Struct({
	issue: Schema.optional(Schema.Number),
	pr: Schema.Int,
	title: Schema.String,
	type: Schema.optional(Schema.String),
	milestone: Schema.optional(Schema.String),
	category: Schema.optional(Schema.String),
	joinedCategory: Schema.optional(Schema.String),
	/** Deprecated aliases retained for existing gatherers during migration. */
	area: Schema.optional(Schema.String),
	joinedArea: Schema.optional(Schema.String),
	releaseState: Schema.optional(Schema.String),
});

const EntriesSchema = Schema.Array(EntrySchema);
const decodeEntries = Schema.decodeUnknownEffect(EntriesSchema);

type DecodedEntry = {
	readonly issue?: number | undefined;
	readonly pr: number;
	readonly title: string;
	readonly type?: string | undefined;
	readonly milestone?: string | undefined;
	readonly category?: string | undefined;
	readonly joinedCategory?: string | undefined;
	readonly area?: string | undefined;
	readonly joinedArea?: string | undefined;
	readonly releaseState?: string | undefined;
};

const nonblank = (value: string | undefined): string | undefined => {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

const normalizedEntries = (entries: ReadonlyArray<DecodedEntry>, file: string) => {
	const invalid = entries.find((entry) => entry.pr <= 0 || nonblank(entry.title) === undefined);
	if (invalid !== undefined) {
		return Effect.fail(new EntriesReadError({
			file,
			cause: new Error("each entry requires a positive integer pr and nonblank title"),
		}));
	}
	const usesLegacyAliases = entries.some((entry) => entry.area !== undefined || entry.joinedArea !== undefined);
	const normalized: ReadonlyArray<ShipEntry> = entries.map((entry) => ({
		issue: entry.issue,
		pr: entry.pr,
		title: entry.title,
		type: entry.type,
		milestone: entry.milestone,
		// Canonical nonblank values always win. A blank canonical value is absent and may use its alias.
		category: nonblank(entry.category) ?? nonblank(entry.area),
		joinedCategory: nonblank(entry.joinedCategory) ?? nonblank(entry.joinedArea),
		releaseState: entry.releaseState,
	}));
	return Effect.succeed({entries: normalized, usesLegacyAliases});
};

/** Read, parse, decode, and normalize the untrusted gathered entries file. */
const loadEntries = (file: string) =>
	Effect.try({
		try: () => JSON.parse(readFileSync(file, "utf8")) as unknown,
		catch: (cause) => new EntriesReadError({file, cause}),
	}).pipe(
		Effect.flatMap((raw) =>
			decodeEntries(raw).pipe(
				Effect.mapError((cause) => new EntriesReadError({file, cause})),
				Effect.flatMap((entries) => normalizedEntries(entries, file)),
			),
		),
	);

type PolicyLoad = {
	readonly policy: ShipDigestDisplayPolicy;
	readonly trusted: boolean;
	readonly source: string;
	readonly reason: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseAxis = (value: unknown): ShipDigestAxisDisplayPolicy | null => {
	if (!isRecord(value) || !Array.isArray(value.order) || !isRecord(value.labels)) return null;
	if (typeof value.fallbackLabel !== "string" || value.fallbackLabel.trim() === "") return null;
	if (!value.order.every((entry) => typeof entry === "string" && entry.trim() !== "")) return null;
	if (!Object.values(value.labels).every((label) => typeof label === "string" && label.trim() !== "")) return null;
	const order = value.order as ReadonlyArray<string>;
	if (new Set(order.map((entry) => entry.trim().toLocaleLowerCase())).size !== order.length) return null;
	return {order, labels: value.labels as Readonly<Record<string, string>>, fallbackLabel: value.fallbackLabel};
};

/** Parse the additive display-only policy atomically; partial policy is never trusted. */
export const parseShipDigestDisplayPolicy = (raw: unknown): ShipDigestDisplayPolicy | null => {
	if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.github) || !isRecord(raw.github.shipping)) return null;
	const shipDigest = raw.github.shipping.shipDigest;
	if (!isRecord(shipDigest)) return null;
	const categories = parseAxis(shipDigest.categories);
	const types = parseAxis(shipDigest.types);
	return categories === null || types === null
		? null
		: {
				categories,
				types,
				// An empty template taxonomy intentionally means "show repository facts as
				// supplied". Once an adopter configures either ordered axis, unrecognised
				// values surface in its explicit fallback instead of silently becoming a
				// new, undocumented category.
				preserveUnconfiguredValues: categories.order.length === 0 && types.order.length === 0,
			};
};

/**
 * Missing or malformed policy is conservative for reporting: retain all gathered work
 * with generic dynamic headings, and make the uncertainty observable on stderr.
 */
export const readShipDigestDisplayPolicy = (root: string): PolicyLoad => {
	const source = join(root, ".pipeline/agent-policy.json");
	if (!existsSync(source)) {
		return {
			policy: GENERIC_SHIP_DIGEST_DISPLAY_POLICY,
			trusted: false,
			source,
			reason: "ship-digest display policy is unavailable",
		};
	}
	try {
		const policy = parseShipDigestDisplayPolicy(JSON.parse(readFileSync(source, "utf8")) as unknown);
		return policy === null
			? {
					policy: GENERIC_SHIP_DIGEST_DISPLAY_POLICY,
					trusted: false,
					source,
					reason: "ship-digest display policy has an unsupported shape",
				}
			: {policy, trusted: true, source, reason: null};
	} catch {
		return {
			policy: GENERIC_SHIP_DIGEST_DISPLAY_POLICY,
			trusted: false,
			source,
			reason: "ship-digest display policy is not valid JSON",
		};
	}
};

const today = (): string => new Date().toISOString().slice(0, 10);

const entriesFlag = Flag.file("entries").pipe(
	Flag.withDescription("path to the gathered merged-work entries JSON"),
);
const sinceFlag = Flag.string("since").pipe(
	Flag.withDescription("window lower bound (YYYY-MM-DD)"),
);
const untilFlag = Flag.string("until").pipe(
	Flag.optional,
	Flag.withDescription("window upper bound (YYYY-MM-DD); defaults to today (UTC)"),
);
const outFlag = Flag.string("out").pipe(
	Flag.optional,
	Flag.withDescription("write the digest to this file; defaults to stdout"),
);
const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription("repository root containing .pipeline/agent-policy.json (default: current directory)"),
);

const derive = Command.make(
	"derive",
	{entries: entriesFlag, since: sinceFlag, until: untilFlag, out: outFlag, root: rootFlag},
	Effect.fn(function* ({entries, since, until, out, root}) {
		const loaded = yield* loadEntries(entries);
		const policy = readShipDigestDisplayPolicy(root._tag === "Some" ? root.value : process.cwd());
		if (loaded.usesLegacyAliases) {
			yield* Console.error("ship-digest: deprecated area/joinedArea aliases were normalized; emit category/joinedCategory instead");
		}
		if (!policy.trusted && policy.reason !== null) {
			yield* Console.error(`ship-digest: ${policy.reason}; using generic dynamic display (${policy.source})`);
		}
		const window: DigestWindow = {since, until: until._tag === "Some" ? until.value : today()};
		const markdown = deriveShipDigest(loaded.entries, window, policy.policy);
		if (out._tag === "Some") {
			const file = out.value;
			yield* Effect.try({
				try: () => writeFileSync(file, markdown),
				catch: (cause) => new EntriesReadError({file, cause}),
			});
			yield* Console.error(`ship-digest: wrote ${loaded.entries.length} entr(y/ies) to ${file}`);
			return;
		}
		yield* Console.log(markdown);
	}),
).pipe(
	Command.withDescription(
		"Render a stakeholder-facing ship digest from gathered merged-work metadata",
	),
);

export const shipDigestCommand = Command.make("ship-digest").pipe(
	Command.withSubcommands([derive]),
	Command.withDescription(
		"Render a lossless merged-work digest using repository-configured display taxonomy",
	),
);
