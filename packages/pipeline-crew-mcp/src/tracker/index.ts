/**
 * tracker/ — the control-plane registry: a standing `RpcServer` at the canonical per-repo rendezvous
 * (`./rendezvous.ts`, the canonical-rendezvous rule: derive the tracker location from the repository shared Git directory so every worktree joins one tracker; fail rather than fall back when Git cannot identify it: derive the tracker location from the repository shared Git directory so every worktree joins one tracker; fail rather than fall back when Git cannot identify it) where peers announce their role + inbox, look each other up, and hold
 * named role leases, all as soft state that ages out on missed heartbeats. Registry only — it NEVER
 * relays a message (that is the peer/data-plane's job). Generic (crew-agnostic); see the boundary note
 * in `../index.ts`.
 */
export {TrackerRegistry} from "./group.ts";
export {TrackerHandlers} from "./handlers.ts";
export {type AnnounceInput, Registry, RegistryLive} from "./registry.ts";
export {
	DEFAULT_TTL_SECONDS,
	type Lease,
	type PresenceRecord,
	type RegistryState,
} from "./registry-core.ts";
export {
	canonicalizeGitCommonDir,
	type Rendezvous,
	RendezvousResolutionError,
	rendezvousSocketPath,
	rendezvousSocketPathFor,
	resolveRendezvous,
} from "./rendezvous.ts";
export {
	isTrackerAddressInUse,
	launchTracker,
	reclaimStaleSocket,
	trackerServerLayer,
} from "./server.ts";
