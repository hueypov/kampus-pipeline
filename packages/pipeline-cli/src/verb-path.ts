/**
 * The verb-path guard: refuse an invocation that names a verb this CLI does not have.
 *
 * IO-free. It exists because `--help` is the interface every skill is written to probe, and until
 * this guard ran, `--help` could not fail:
 *
 *     $ pipeline cli triage not-a-real-verb --help
 *     …prints triage's help…            exit 0
 *
 * The CLI framework processes the help action before it inspects accumulated parse errors, so a
 * confident exit 0 came back for a path that does not exist. That makes `--help` useless as evidence
 * a verb is real — and a skill citing a verb nobody built reads exactly like one citing a verb that
 * works. It is how `pipeline cli scratchpad open` shipped in a merged skill for a verb that never
 * existed.
 *
 * The tree is **derived from the registry**, never listed here. A hand-maintained copy of the verb
 * surface would rot, and a guard that rots is worse than none: it starts refusing verbs that exist.
 */

/**
 * A declared positional, as the framework exposes it.
 *
 * A plain single operand carries no `max`. A repeated one carries `max` as an `Option`: `None` is
 * unbounded (`leak-guard scan <file>…`), `Some(n)` caps it. Both report `kind: "argument"`, so the
 * kind alone cannot tell them apart — assuming it could is what made this guard refuse
 * `leak-guard scan a.md b.md` on its first run.
 */
export interface ArgumentLike {
	readonly kind?: string;
	readonly max?: {readonly _tag?: string; readonly value?: unknown};
}

/** The shape this guard reads off a registered command. Structural, so no framework type is imported. */
export interface CommandLike {
	readonly name: string;
	readonly subcommands?: ReadonlyArray<{readonly commands?: ReadonlyArray<CommandLike>}>;
	readonly config?: {readonly arguments?: ReadonlyArray<ArgumentLike>};
}

/** One node of the derived verb tree. `maxPositionals` is null when the count cannot be trusted. */
export interface VerbNode {
	readonly name: string;
	readonly children: ReadonlyArray<VerbNode>;
	readonly maxPositionals: number | null;
}

/**
 * How many operands one declared positional accepts — `null` meaning unbounded or unreadable.
 *
 * Anything this cannot read confidently returns `null` and disables the count for the whole verb.
 * The asymmetry is deliberate: missing an extra operand costs a confusing answer, while refusing a
 * legal invocation breaks working commands, and that is the failure this guard must never have.
 */
const operandBound = (argument: ArgumentLike): number | null => {
	if (argument.kind !== "argument") return null;
	if (argument.max === undefined) return 1;
	if (argument.max._tag === "None") return null;
	if (argument.max._tag === "Some" && typeof argument.max.value === "number") return argument.max.value;
	return null;
};

/** How many positional operands a leaf accepts in total, or null for "do not guard this". */
const positionalBound = (command: CommandLike): number | null => {
	const bounds = (command.config?.arguments ?? []).map(operandBound);
	return bounds.some((b) => b === null) ? null : bounds.reduce((a: number, b) => a + (b ?? 0), 0);
};

const childrenOf = (command: CommandLike): ReadonlyArray<CommandLike> =>
	(command.subcommands ?? []).flatMap((entry) => entry.commands ?? []);

/** Derive the verb tree from the registered commands. The registry is the only source. */
export const verbTree = (root: string, tools: ReadonlyArray<CommandLike>): VerbNode => {
	const node = (command: CommandLike): VerbNode => ({
		name: command.name,
		children: childrenOf(command).map(node),
		maxPositionals: positionalBound(command),
	});
	return {
		name: root,
		children: tools.map(node),
		maxPositionals: 0,
	};
};

export type PathRefusal =
	| {
			readonly _tag: "UnknownVerb";
			readonly token: string;
			readonly path: ReadonlyArray<string>;
			readonly expected: ReadonlyArray<string>;
	  }
	| {
			readonly _tag: "ExtraOperand";
			readonly token: string;
			readonly path: ReadonlyArray<string>;
			readonly allowed: number;
	  };

/**
 * Resolve `argv` against the tree, or name the first thing that does not resolve.
 *
 * **What is guarded, and what deliberately is not.** The walk reads leading non-flag tokens: they
 * are the verb path, then the leaf's positional operands. It stops at the first flag.
 *
 * It does not guard operands appearing *after* a flag. Telling `--pr 47` (flag plus value) from
 * `--json 47` (boolean flag, then a stray operand) requires knowing which flags take values, and the
 * framework does not expose that reliably — two of `verdict read`'s four flags report an undefined
 * name and primitive. Guessing there would refuse working invocations, which is a worse failure than
 * the one being fixed. So `<verb> --flag v extratoken` is still accepted, and closing it needs flag
 * metadata this CLI cannot currently read — recorded rather than papered over.
 *
 * A bare `--` ends the walk: everything after it is operands by definition.
 */
export const checkVerbPath = (tree: VerbNode, argv: ReadonlyArray<string>): PathRefusal | null => {
	let node = tree;
	const path: string[] = [];
	let operands = 0;

	for (const token of argv) {
		if (token === "--") return null;
		if (token.startsWith("-")) return null;

		const child = node.children.find((c) => c.name === token);
		if (child) {
			node = child;
			path.push(token);
			continue;
		}
		if (node.children.length > 0) {
			return {
				_tag: "UnknownVerb",
				token,
				path,
				expected: node.children.map((c) => c.name),
			};
		}
		operands += 1;
		if (node.maxPositionals !== null && operands > node.maxPositionals) {
			return {_tag: "ExtraOperand", token, path, allowed: node.maxPositionals};
		}
	}
	return null;
};

/** The refusal a caller prints. Names what was typed, what exists, and why it is being refused. */
export const refusalMessage = (root: string, refusal: PathRefusal): string => {
	const where = [root, ...refusal.path].join(" ");
	if (refusal._tag === "UnknownVerb") {
		const near = refusal.expected.filter((n) => n.startsWith(refusal.token.slice(0, 3)));
		const suggestion = near.length > 0 ? `\n  did you mean: ${near.join(", ")}` : "";
		return `${root}: '${refusal.token}' is not a ${where} subcommand — this verb does not exist${suggestion}\n  available: ${refusal.expected.join(", ")}`;
	}
	const takes =
		refusal.allowed === 0 ? "takes no positional operands" : `takes ${refusal.allowed} positional operand(s)`;
	return `${root}: '${where}' ${takes}, and '${refusal.token}' is one too many — refusing rather than answering a different invocation than the one typed`;
};
