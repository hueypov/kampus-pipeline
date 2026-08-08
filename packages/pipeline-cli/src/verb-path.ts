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
	readonly _tag?: string;
	readonly kind?: string;
	readonly param?: ArgumentLike;
	readonly max?: {readonly _tag?: string; readonly value?: unknown};
}

/**
 * A declared flag. Wrappers (`Optional`, `Map`) nest the real one under `.param`, so reading the top
 * level alone finds an undefined name and looks like missing metadata. It is not missing: unwrapped,
 * all 219 flags in the registry report a name and a primitive.
 */
export interface FlagLike {
	readonly name?: string;
	readonly aliases?: ReadonlyArray<string>;
	readonly primitiveType?: {readonly _tag?: string};
	readonly param?: FlagLike;
}

/** The shape this guard reads off a registered command. Structural, so no framework type is imported. */
export interface CommandLike {
	readonly name: string;
	readonly subcommands?: ReadonlyArray<{readonly commands?: ReadonlyArray<CommandLike>}>;
	readonly config?: {
		readonly arguments?: ReadonlyArray<ArgumentLike>;
		readonly flags?: ReadonlyArray<FlagLike>;
	};
}

/** Follow `.param` to the declaration a wrapper wraps. */
const unwrap = <T extends {readonly name?: string; readonly param?: T}>(node: T): T => {
	let current = node;
	for (let depth = 0; current.name === undefined && current.param !== undefined && depth < 8; depth += 1) {
		current = current.param;
	}
	return current;
};

/** Flag name (and aliases) → does it consume the next token? Only a boolean flag does not. */
const flagArity = (command: CommandLike): ReadonlyMap<string, boolean> => {
	const map = new Map<string, boolean>();
	for (const raw of command.config?.flags ?? []) {
		const flag = unwrap(raw);
		if (flag.name === undefined) continue;
		const takesValue = flag.primitiveType?._tag !== "Boolean";
		map.set(flag.name, takesValue);
		for (const alias of flag.aliases ?? []) map.set(alias, takesValue);
	}
	return map;
};

/** One node of the derived verb tree. `maxPositionals` is null when the count cannot be trusted. */
export interface VerbNode {
	readonly name: string;
	readonly children: ReadonlyArray<VerbNode>;
	readonly maxPositionals: number | null;
	/** Flag name/alias → consumes the next token. Empty for a group, which declares none. */
	readonly flags: ReadonlyMap<string, boolean>;
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
	// Only a bare `Single` is confidently one operand. A `Map`/`Transform` wrapper carries no `max`
	// of its own, so defaulting any max-less argument to 1 would read `Argument.map(atLeast(1))` as
	// single and recreate the `leak-guard scan` false refusal one wrapper deeper.
	if (argument.max === undefined) return argument._tag === "Single" ? 1 : null;
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
		flags: flagArity(command),
	});
	return {
		name: root,
		children: tools.map(node),
		maxPositionals: 0,
		flags: new Map(),
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
 * The walk reads the verb path from the leading tokens, then counts the leaf's positional operands —
 * **including operands that appear after flags**, because flag arity is readable once the `.param`
 * wrappers are unwrapped: a `Boolean` flag consumes nothing, anything else consumes the next token.
 *
 * An earlier revision stopped at the first flag and recorded that as an unavoidable bound, claiming
 * the metadata was unreadable. That claim came from reading one level and finding a wrapper. It was
 * wrong: across the registry, 219 flags unwrap to a name and a primitive and **none** is unreadable.
 *
 * Two things still end the walk, both because continuing would mean guessing:
 *
 *   - **A bare `--`** — everything after it is operands by definition.
 *   - **An unrecognised flag** — its arity is genuinely unknown here (a global flag like
 *     `--log-level` belongs to the root, not the leaf), so whether the next token is its value or a
 *     stray operand cannot be decided. Stopping accepts a little less coverage; guessing would
 *     refuse working commands, and that is the one failure this guard must never have.
 */
export const checkVerbPath = (tree: VerbNode, argv: ReadonlyArray<string>): PathRefusal | null => {
	let node = tree;
	const path: string[] = [];
	let operands = 0;
	let skipValue = false;

	for (const token of argv) {
		if (token === "--") return null;

		if (skipValue) {
			skipValue = false;
			continue;
		}

		if (token.startsWith("-")) {
			const name = token.replace(/^-+/, "").split("=")[0] ?? "";
			const takesValue = node.flags.get(name);
			if (takesValue === undefined) return null;
			skipValue = takesValue && !token.includes("=");
			continue;
		}

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
