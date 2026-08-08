/**
 * peer/errors — the typed-error rules a session-edge peer raises. Generic (crew-agnostic);
 * see the boundary note in `../index.ts`.
 */
import {Schema} from "effect";

/**
 * A dial to a target that is absent, expired, or unreachable. This is the honest
 * offline-receiver behavior locked in the role-addressing rule: send to a role inbox, and treat delivery as queued rather than read (the MCP-channel rule: crew roles communicate through MCP channels instead of a terminal relay): no store-and-forward, no queue
 * — a failed dial surfaces loudly as this typed error, never a silent drop.
 */
export class PeerUnreachableError extends Schema.TaggedErrorClass<PeerUnreachableError>()(
	"pipeline-crew-mcp/PeerUnreachableError",
	{
		target: Schema.String,
		reason: Schema.String,
	},
) {}
