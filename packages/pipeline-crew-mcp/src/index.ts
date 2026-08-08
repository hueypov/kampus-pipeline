/**
 * pipeline-crew-mcp — the crew's channels-backed messaging substrate (the MCP-channel rule: crew roles communicate through MCP channels instead of a terminal relay).
 *
 * The cutover (the session-start rule: start one role-bound MCP server and peer for each session) binds the substrate into a runnable crew: `Crew.runCrewSession` /
 * `Crew.crewSessionLayer` stand up one live session's stdio `McpServer` + `ChannelSend`-from-peer,
 * so every inter-session seam (claim/collision-check, planned-epic handoff, drain tally, intake
 * pings, role discovery/presence, the role-uniqueness lease) runs over the channels protocol
 * instead of the retired tmux relay convention. `Crew.CREW_ROSTER` is the single kind-typed roster
 * (three bridges + the engine pool; the topology rule: unique-seam bridges are singletons, while seam-free engines may scale and bridges never execute engine lanes) every binding consumes via `Crew.CREW_ROLES` /
 * `Crew.kindOf` — never a re-declared or short list.
 *
 * The one structural invariant the module boundary holds: the generic core is crew-agnostic.
 * `Protocol`, `Tracker`, `Peer`, and `Edge` are the reusable channels substrate and MUST NOT
 * import `Crew`; `Crew` is the sole crew-coupled module (Role catalog + wiring + the session
 * entry) and depends inward on the generic core, never the reverse. That one-way boundary is what
 * keeps the substrate reusable — enforcing it is the point of splitting these into directories.
 */
export * as Crew from "./crew/index.ts";
export * as Edge from "./edge/index.ts";
export * as Peer from "./peer/index.ts";
export * as Protocol from "./protocol/index.ts";
export * as Tracker from "./tracker/index.ts";
export {VERSION} from "./version.ts";
