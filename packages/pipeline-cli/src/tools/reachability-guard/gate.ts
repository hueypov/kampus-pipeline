import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {Console, Effect} from "effect";
import * as Schema from "effect/Schema";
import {consumedSymbolsIn, judge, parseFeatureDefinitions, parseJourneyKeys, renderReport} from "./reachability-guard.ts";
import type {FeatureReachabilityPolicy} from "./policy.ts";

export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {path: Schema.String, cause: Schema.Unknown}) {}
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {reason: Schema.String}) {}

const walk = (directory: string, matches: (name: string) => boolean, files: string[]): void => {
	if (!existsSync(directory)) return;
	for (const entry of readdirSync(directory, {withFileTypes: true})) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== ".git") walk(path, matches, files);
		} else if (matches(entry.name)) files.push(path);
	}
};

const readDefinitions = (root: string, policy: Extract<FeatureReachabilityPolicy, {enabled: true}>) =>
	Effect.try({try: () => parseFeatureDefinitions(readFileSync(join(root, policy.definitionsPath), "utf8"), policy.definitionPattern, policy.exemptionPattern), catch: (cause) => new IoError({path: join(root, policy.definitionsPath), cause})});

const gatherConsumers = (root: string, policy: Extract<FeatureReachabilityPolicy, {enabled: true}>, symbols: ReadonlyArray<string>) =>
	Effect.try({try: () => {
		const consumed = new Set<string>();
		for (const relative of policy.consumerRoots) {
			const files: string[] = [];
			walk(join(root, relative), (name) => policy.consumerFilePattern.test(name), files);
			policy.consumerFilePattern.lastIndex = 0;
			for (const file of files) for (const symbol of consumedSymbolsIn(readFileSync(file, "utf8"), symbols)) consumed.add(symbol);
		}
		return consumed;
	}, catch: (cause) => new IoError({path: root, cause})});

const gatherJourneyKeys = (root: string, policy: Extract<FeatureReachabilityPolicy, {enabled: true}>) =>
	Effect.try({try: () => {
		const keys = new Set<string>();
		for (const relative of policy.journeyRoots) {
			const files: string[] = [];
			walk(join(root, relative), (name) => policy.journeyFilePattern.test(name), files);
			policy.journeyFilePattern.lastIndex = 0;
			for (const file of files) for (const key of parseJourneyKeys(readFileSync(file, "utf8"), policy.journeyPattern)) keys.add(key);
		}
		return keys;
	}, catch: (cause) => new IoError({path: root, cause})});

/** Run the configured adapter. Missing consumer/journey directories become empty evidence, never a pass. */
export const checkReachability = (root: string, featureKey: string, policy: Extract<FeatureReachabilityPolicy, {enabled: true}>) =>
	Effect.gen(function* () {
		const definitions = yield* readDefinitions(root, policy);
		const consumingSymbols = yield* gatherConsumers(root, policy, definitions.map((definition) => definition.symbol));
		const journeyKeys = yield* gatherJourneyKeys(root, policy);
		const verdict = judge({featureKey, definitions, consumingSymbols, journeyKeys});
		if (!verdict.pass) return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
		yield* Console.log(renderReport(verdict));
	});
