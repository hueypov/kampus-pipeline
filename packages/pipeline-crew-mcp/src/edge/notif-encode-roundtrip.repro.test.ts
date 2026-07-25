// @patch-pin: effect@4.0.0-beta.92
/**
 * End-to-end run-loop pin for the (b1) hunk of `patches/effect@4.0.0-beta.92.patch` (the single-encoding rule: encode each notification exactly once before emission, the local dependency-patch rule: rely on released dependencies or committed local pnpm patches, never forks, git URLs, or unmerged upstream work).
 * The sibling `notif-encode.repro.test.ts` pins the encode STRATEGY (by-tag vs blind union) by reading
 * the schemas directly; this one drives the REAL patched `McpServer` run-loop end-to-end over the
 * bidirectional notification transport and asserts the params a `claude/channel` wake carries survive
 * to the wire. That closes the coverage gap the payload-shape rule: preserve the message and metadata shape through encode and decode names: the strategy pin stays GREEN even if the
 * run-loop hunk alone were reverted (the schema still exists on `main`), so the load-bearing run-loop
 * change had no automated regression guard — a patch regeneration could silently revert it.
 *
 * The teeth: the pre-fix loop encoded every outgoing notification against a blind
 * `Schema.Union(...payloadSchema)` in which the all-optional `*_list_changed` members accept any object
 * and strip unknown keys, and they sit before `claude/channel` — so a `{content, meta}` channel payload
 * matched a `list_changed` member first and encoded to `{}`, shipping the wake with empty params (0
 * tokens). This test fires a wake carrying BOTH `content` and `meta` and asserts the emitted wire line's
 * `params` is `{content, meta}` INTACT — RED against the blind-union loop (params `{}`), GREEN on the
 * by-tag fix. Reverting the b1 hunk alone keeps the drain (the drain rule: emit each queued notification once) and id-omit (the optional-id rule: omit an absent identifier instead of serializing null) hunks in place, so
 * the line still emits — it just arrives stripped, failing the params assertion.
 *
 * Faithful LIVE-path harness, mirroring `notif-drain-emit.repro.test.ts`: boots the real
 * `McpServer.layerStdio` (the transport `bin.ts session` serves) over a fake `Stdio`, feeds the
 * `initialize` + `notifications/initialized` handshake into stdin so the drain gate is armed, then fires
 * the wake through the running server and reads the captured stdout. `it.live` (not `it.effect`): the
 * forked run-loop drives `Effect.sleep` on REAL async scheduling, which `TestClock` would freeze. Retire
 * when effect ships a native custom-notification passthrough and the patch is removed.
 */
import {assert, describe, it} from "@effect/vitest";
import {Deferred, Effect, Layer, Ref, Sink, Stdio, Stream} from "effect";
import {McpServer} from "effect/unstable/ai";
import {
	CHANNEL_NOTIFICATION_METHOD,
	type ChannelNotificationPayload,
	channelExperimentalCapability,
} from "./mcp-channel.ts";

const decoder = new TextDecoder();
const ndjson = (message: unknown): Uint8Array =>
	new TextEncoder().encode(`${JSON.stringify(message)}\n`);

// The client handshake pair, in stdin order: the server processes `initialize` before
// `notifications/initialized`, which the drain fix (the drain rule: emit each queued notification once) uses to arm the client gate.
const INITIALIZE = ndjson({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "9999-01-01",
		capabilities: {},
		clientInfo: {name: "TestClient", version: "0.0.0"},
	},
});
const INITIALIZED = ndjson({jsonrpc: "2.0", method: "notifications/initialized"});

// The wake the run-loop must deliver intact: content + a meta record (the originating peer). The blind
// union strips BOTH to {}, so asserting the whole params object pins the by-tag encode, not just content.
const wakePayload: ChannelNotificationPayload = {
	content: "wake",
	meta: {from: "inbox://engineering-manager/1"},
};

describe("effect McpServer run-loop (b1) — a channel wake reaches the client with {content, meta} intact (the payload-shape rule: preserve the message and metadata shape through encode and decode)", () => {
	it.live(
		"the emitted notifications/claude/channel line carries {content, meta} — not stripped to {} by a blind union",
		() =>
			Effect.gen(function* () {
				const out = yield* Ref.make("");
				const stdin = Stream.fromIterable([INITIALIZE, INITIALIZED]).pipe(
					Stream.concat(Stream.never),
				);
				// biome-ignore lint/suspicious/useIterableCallbackReturn: Sink.forEach's callback returns an Effect (the per-chunk write), not an Array.forEach callback.
				const capturingStdout = Sink.forEach((chunk: string | Uint8Array) =>
					Ref.update(
						out,
						(acc) => acc + (typeof chunk === "string" ? chunk : decoder.decode(chunk)),
					),
				);

				// Launch the live stdio server on a forked scoped fiber and hand a `wake` closure out through a
				// Deferred resolved inside the layer (where `McpServer` is in scope), so the body fires the wake
				// against the same running instance the transport serves.
				const ready =
					yield* Deferred.make<(payload: ChannelNotificationPayload) => Effect.Effect<void>>();
				const serverLayer = Layer.effectDiscard(
					Effect.flatMap(McpServer.McpServer, (server) =>
						Deferred.succeed(ready, (payload: ChannelNotificationPayload) =>
							server.notifications[CHANNEL_NOTIFICATION_METHOD](payload).pipe(Effect.asVoid),
						),
					),
				).pipe(
					Layer.provideMerge(
						McpServer.layerStdio({
							name: "EncodeRoundtripReproServer",
							version: "0.0.0",
							experimental: channelExperimentalCapability,
						}),
					),
					Layer.provide(Stdio.layerTest({stdin, stdout: () => capturingStdout})),
				);
				yield* Effect.forkScoped(Layer.launch(serverLayer));
				const wake = yield* Deferred.await(ready);

				// Let the forked run-loop consume the handshake so the drain gate is armed BEFORE the wake
				// enqueues (a wake drained before the client registers is lost — the drain rule: emit each queued notification once concern, not this
				// test's). A fixed window, since polling the private Set would deadlock a RED drain run.
				yield* Effect.sleep("1 second");

				yield* wake(wakePayload);
				yield* Effect.sleep("500 millis");

				// `out` accumulates every stdout chunk, so splitting on \n reassembles each framed NDJSON
				// message in full — the channel line, terminated by \n before the assert, is a complete JSON
				// object to parse directly (no defensive try/catch, banned in effect-importing files, the effect-isolation rule: model failures in the effect flow rather than letting a rejected promise escape as a defect).
				const captured = yield* Ref.get(out);
				const channelLine = captured
					.split("\n")
					.map((line) => line.trim())
					.find((line) => line.includes(CHANNEL_NOTIFICATION_METHOD));

				assert.isDefined(
					channelLine,
					"a notifications/claude/channel line must reach the client — the drain must emit the wake",
				);
				const channelMessage = JSON.parse(channelLine ?? "{}") as {readonly params?: unknown};
				assert.deepEqual(
					channelMessage.params,
					wakePayload,
					"the emitted params must carry {content, meta} INTACT — a blind-union encode strips them to {} (the 0-delivery defect the by-tag run-loop hunk fixes)",
				);
			}).pipe(Effect.scoped),
		{timeout: 20000},
	);
});
