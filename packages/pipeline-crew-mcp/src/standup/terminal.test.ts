/**
 * The terminal-backend seam: selecting which window manager the crew's panes land in. These tests pin
 * the two properties that keep the seam honest rather than re-testing either backend's mechanics
 * (herdr.test.ts and orchestrate.test.ts own those).
 *
 * First, the default is tmux and stays tmux — the dimension is purely additive, so an operator config
 * that predates it must select exactly the path it already ran. Second, every backend implements the
 * WHOLE interface: a half-implemented backend would fail at retire time, long after stand-up reported
 * success, so completeness is asserted structurally here instead of being discovered in production.
 */
import {assert, describe, it} from "@effect/vitest";
import {DEFAULT_TERMINAL, TERMINAL_KINDS, type TerminalKind} from "./config.ts";
import {herdrBackend, TERMINAL_BACKENDS, type TerminalBackend, terminalBackend, tmuxBackend} from "./terminal.ts";

/** Every operation a backend must provide — the launcher's entire coupling to a window manager. */
const REQUIRED_OPS = [
	"resolveTargetSession",
	"launch",
	"resolveCrewWindow",
	"findCrewPane",
	"closePane",
] as const satisfies readonly (keyof TerminalBackend)[];

describe("standup/terminal — selecting a backend", () => {
	it("defaults to tmux, so a config predating the dimension launches exactly as before", () => {
		assert.strictEqual(DEFAULT_TERMINAL, "tmux");
		assert.strictEqual(terminalBackend().kind, "tmux");
	});

	it("resolves each selectable kind to the backend that names it", () => {
		assert.strictEqual(terminalBackend("tmux"), tmuxBackend);
		assert.strictEqual(terminalBackend("herdr"), herdrBackend);
	});

	it("offers a backend for every kind the config schema accepts", () => {
		for (const kind of TERMINAL_KINDS) {
			const backend = terminalBackend(kind);
			assert.isDefined(backend, `"${kind}" is selectable but has no backend`);
			assert.strictEqual(backend.kind, kind, "a backend must report the kind it was selected by");
		}
		assert.sameMembers(
			Object.keys(TERMINAL_BACKENDS),
			[...TERMINAL_KINDS],
			"the backend registry and the selectable kinds must not drift apart",
		);
	});
});

describe("standup/terminal — backend completeness", () => {
	for (const kind of TERMINAL_KINDS satisfies readonly TerminalKind[]) {
		it(`the ${kind} backend implements every launcher operation`, () => {
			const backend = terminalBackend(kind);
			for (const op of REQUIRED_OPS) {
				assert.isFunction(
					backend[op],
					`the ${kind} backend is missing "${op}" — it would fail mid-lifecycle`,
				);
			}
		});
	}
});
