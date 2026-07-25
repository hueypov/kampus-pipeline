/**
 * edge/claim-tool — the deconfliction tool that the duplicate-work failure: two engines can otherwise open competing lanes for the same resource was missing. The channel edge server lists a
 * `channel_claim` tool, and a `tools/call` routes a resource claim through the `ChannelClaim` port
 * (the session's tracker claim), returning the typed granted/collision reply. The load-bearing
 * property: two engine SESSIONS that each claim the same resource through this tool get exactly ONE
 * grant — the second sees a `collision`, so it backs off before opening a duplicate lane. Driven
 * against the REAL registry (`RpcTest` client of `TrackerRegistry` + `RegistryLive`) so the
 * exclusion is genuine, not a stub, and against a real in-memory `McpServer.layerHttp` per session
 * (the `mcp-server-effect` harness `send-tool.test.ts` uses).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Schema} from "effect";
import {McpSchema, McpServer} from "effect/unstable/ai";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {RpcSerialization, RpcTest} from "effect/unstable/rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import {CrewTracker} from "../crew/tracker.ts";
import {TrackerRegistry} from "../tracker/group.ts";
import {TrackerHandlers} from "../tracker/handlers.ts";
import {RegistryLive} from "../tracker/registry.ts";
import {ChannelClaim, ClaimToolkit, claimToolHandlers} from "./claim-tool.ts";
import {channelExperimentalCapability} from "./mcp-channel.ts";

class DisposeError extends Schema.TaggedErrorClass<DisposeError>()(
	"@kampus/pipeline-crew-mcp/DisposeError",
	{cause: Schema.Unknown},
) {}

const registryHandlers = TrackerHandlers.pipe(Layer.provide(RegistryLive));

// A live crew session's ChannelClaim: its tracker claim under a fixed per-session peer address,
// backed by the shared registry (`CrewTracker.fromClient`). The session announces its presence
// separately (a claim's liveness rides presence, the claim-lifecycle rule: presence leases and resource claims use separate keyspaces; claims live only while their holder is present and release on completion or holder expiry), so a peer that still holds a resource
// collides a later claimant — the cross-session exclusion this tool surfaces.
const sessionClaim = (
	client: Parameters<typeof CrewTracker.fromClient>[0],
	address: string,
): Layer.Layer<ChannelClaim> =>
	Layer.effect(
		ChannelClaim,
		Effect.gen(function* () {
			const tracker = yield* CrewTracker;
			return {
				claim: (resource: string) =>
					tracker.claim({resource, claimant: address, role: "engineering-manager"}),
			};
		}),
	).pipe(Layer.provide(CrewTracker.fromClient(client)));

// An initialized MCP client for one session, its channel_claim backed by `claimLayer`.
const makeSession = (claimLayer: Layer.Layer<ChannelClaim>) =>
	Effect.gen(function* () {
		const serverLayer = McpServer.toolkit(ClaimToolkit).pipe(
			Layer.provide(claimToolHandlers),
			Layer.provide(claimLayer),
			Layer.provide(
				McpServer.layerHttp({
					name: "ChannelEdgeClaimTestServer",
					version: "0.0.0",
					path: "/mcp",
					experimental: channelExperimentalCapability,
				}),
			),
		);
		const {dispose, handler} = HttpRouter.toWebHandler(serverLayer, {disableLogger: true});
		yield* Effect.addFinalizer(() =>
			Effect.tryPromise({try: () => dispose(), catch: (cause) => new DisposeError({cause})}).pipe(
				Effect.ignore,
			),
		);

		let sessionId: string | null = null;
		const customFetch: typeof fetch = async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			if (sessionId) request.headers.set("Mcp-Session-Id", sessionId);
			const response = await handler(request);
			sessionId = response.headers.get("Mcp-Session-Id");
			return response;
		};

		const clientLayer = RpcClient.layerProtocolHttp({url: "http://localhost/mcp"}).pipe(
			Layer.provideMerge([FetchHttpClient.layer, RpcSerialization.layerJsonRpc()]),
			Layer.provide(Layer.succeed(FetchHttpClient.Fetch, customFetch)),
		);
		const client = yield* RpcClient.make(McpSchema.ClientRpcs).pipe(Effect.provide(clientLayer));
		yield* client.initialize({
			protocolVersion: "9999-01-01",
			capabilities: {},
			clientInfo: {name: "TestClient", version: "0.0.0"},
		});
		return client;
	});

// Read a `tools/call` result's structured ClaimReply.
const replyOf = (result: {structuredContent?: unknown}) =>
	result.structuredContent as {
		resource: string;
		granted: boolean;
		collision: boolean;
		owner: string;
	};

describe("edge/claim-tool — the channel_claim deconfliction tool (the duplicate-work failure: two engines can otherwise open competing lanes for the same resource)", () => {
	it.effect("advertises the channel_claim tool", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(TrackerRegistry);
			const session = yield* makeSession(sessionClaim(client, "inbox://engineering-manager/a"));
			const tools = yield* session["tools/list"]({});
			assert.include(
				tools.tools.map((t) => t.name),
				"channel_claim",
			);
		}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);

	it.effect(
		"two engine sessions claiming the same resource through the tool → exactly one grant",
		() =>
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(TrackerRegistry);
				const addrA = "inbox://engineering-manager/a";
				const addrB = "inbox://engineering-manager/b";
				const at = new Date().toISOString();
				// both sessions are live (presence backs claim liveness, the presence-derived liveness rule: a resource claim is live only while its holder has a live presence lease)
				yield* client.AnnouncePresence({peer: addrA, role: "engineering-manager", at});
				yield* client.AnnouncePresence({peer: addrB, role: "engineering-manager", at});

				const a = yield* makeSession(sessionClaim(client, addrA));
				const b = yield* makeSession(sessionClaim(client, addrB));

				// engine A claims the collision rule: an existing holder prevents a second claim for the same resource through the tool — granted, it owns the lane
				const aResult = yield* a["tools/call"]({
					name: "channel_claim",
					arguments: {resource: "3498"},
				});
				assert.isFalse(aResult.isError);
				const aReply = replyOf(aResult);
				assert.isTrue(aReply.granted);
				assert.isFalse(aReply.collision);
				assert.strictEqual(aReply.owner, addrA);

				// engine B claims the same collision rule: an existing holder prevents a second claim for the same resource through the tool — collision, the incumbent keeps it
				const bResult = yield* b["tools/call"]({
					name: "channel_claim",
					arguments: {resource: "3498"},
				});
				assert.isFalse(bResult.isError);
				const bReply = replyOf(bResult);
				assert.isFalse(bReply.granted, "the second claimant does NOT get a grant");
				assert.isTrue(bReply.collision);
				assert.strictEqual(bReply.owner, addrA, "the resource stays with the first engine");
			}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);

	it.effect(
		"the claim is keyed on the RESOURCE — a claim on one issue does not block another",
		() =>
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(TrackerRegistry);
				const addrA = "inbox://engineering-manager/a";
				const addrB = "inbox://engineering-manager/b";
				const at = new Date().toISOString();
				yield* client.AnnouncePresence({peer: addrA, role: "engineering-manager", at});
				yield* client.AnnouncePresence({peer: addrB, role: "engineering-manager", at});

				const a = yield* makeSession(sessionClaim(client, addrA));
				const b = yield* makeSession(sessionClaim(client, addrB));

				// A holds the collision rule: an existing holder prevents a second claim for the same resource
				const aReply = replyOf(
					yield* a["tools/call"]({name: "channel_claim", arguments: {resource: "3498"}}),
				);
				assert.isTrue(aReply.granted);

				// B claims a DIFFERENT the resource-keyed claim rule: different resources may be claimed independently — granted, because the claim is keyed on the resource,
				// not the session (A's claim on a claim on one resource does not reserve a different resource)
				const bReply = replyOf(
					yield* b["tools/call"]({name: "channel_claim", arguments: {resource: "3475"}}),
				);
				assert.isTrue(bReply.granted, "a different resource is independently claimable");
				assert.isFalse(bReply.collision);
				assert.strictEqual(bReply.owner, addrB);
			}).pipe(Effect.scoped, Effect.provide(registryHandlers)),
	);
});
