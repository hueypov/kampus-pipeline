---
id: 0003
title: A crew pane's channel is an operator-gated boot precondition, not a launcher guarantee
status: accepted
date: 2026-08-08
tags: [crew, channels, launcher, mcp]
---

# 0003 — A crew pane's channel is an operator-gated boot precondition, not a launcher guarantee

**What this decides:** The crew launcher makes each pane's channel MCP server *visible* but not *approved*, so whether a booted seat has the channel tools is decided per session by host state the launcher neither seeds nor verifies. A seat therefore treats a still-absent channel toolset as permanent for its session and deconflicts over the board, rather than waiting for a connect that is never coming.

## Context

Two `crew-engineering-manager` seats, booted from the same agent definition, the same operator config and the same install, came up with opposite toolsets: one with both `mcp__pipeline-crew-mcp__channel_send` and `mcp__pipeline-crew-mcp__channel_claim` present and returning typed protocol results, the other with no channel server at all for the ~51 minutes it stayed up. Two candidate causes were falsified before this investigation started: the allowlist tokens are correct (they match the derivation rule in `claude-plugins/pipeline-crew/CHANNEL-TOOL.md` exactly), and the `channels` config cannot be the cause because one config cannot both serve and not serve the same server.

### What the launcher actually does

`buildSessionBind` (`packages/pipeline-crew-mcp/src/standup/bind.ts`) produces two coupled outputs per session: the crew server's persisted-scope config value, and the channel-registration flag naming that same server. It fails closed on three ways a bind would come up inert — an unresolvable `bin.ts`, a server absent from the channel flag, and a disallowed plugin channel. All three guards hold here.

The launcher then registers that server through one seam both launch paths share, `registerCrewProjectScope` in `packages/pipeline-crew-mcp/src/standup/register-project-scope.ts`. That function writes the pane's leaf `.mcp.json` and returns. It does nothing else.

That is the whole finding. The same module defines the two boot gates a project-scope `.mcp.json` server needs before the CLI will actually spawn it — folder trust in `~/.claude.json`, and the server name in `enabledMcpjsonServers` in merged settings — as `ensureFolderTrusted` and `enableCrewServerApproval`. **Neither is called from any launch path.** A repository-wide search finds each of them in exactly three places: its own definition, its own unit test, and the `standup/index.ts` barrel re-export. Both stand-up and `spawn-role` reach them only through `registerCrewProjectScope`, which calls neither.

This is deliberate, not an accident of editing: the function's own comment reads "Register only project-owned crew configuration; host trust is always operator-owned", and the round-trip test in `register-project-scope.test.ts` asserts that host config stays untouched. The launcher has been narrowed to write nothing outside the repository, which is the right stance for a portable plugin.

What was not narrowed with it was the prose. Until this change the module docblock described the two gates as pre-seeded so the panes "come up non-interactively"; the `ProjectScopeRegistrar` interface contract said `register` "seeds folder trust + server approval"; and the call sites in `standup/orchestrate.ts` and `standup/single-role.ts` described the register and reap steps as seeding and revoking those gates. Those comments are why triage looked at the token, the config, and the server, and not at the gate: the code's own documentation asserted the gate was already handled, at the contract level where a reader looks first. They are corrected here — see Decision.

### The mechanism

The engine's channel tools are absent because that session's CLI never spawned its crew MCP server — not because a served toolset was filtered.

The launcher's per-session bind makes the server visible and named, and stops one step short of making it usable. Approval is left to host state that is read once, at that pane's boot, and answered interactively. A crew pane's boot is already known to be attended for a different reason. `paneClaudeCommand` in `packages/pipeline-crew-mcp/src/standup/orchestrate.ts` does not exec `claude` directly: it wraps it in the operator's `$SHELL` as an interactive login shell (`-lic`), and its own comment says why — so a startup channel-approval dialog can render and WAIT for the operator's accept instead of the pane exiting 1. That shape is pinned by an existing test in `orchestrate.test.ts` named for the dev-channel dialog shell-wrap, written before this investigation and for a different symptom. So "a dialog at pane boot decides whether this pane gets its channel" is not a hypothesis this record introduces to fit the evidence — it is the launcher's already-documented, already-tested operating model, arrived at independently. This is the strongest corroboration available short of capturing the gate state itself. A pane whose gate is unsatisfied when it boots comes up with no crew server, for the entire life of that session. Once any pane's acceptance persists into merged settings, every pane launched afterwards reads an already-satisfied gate and comes up with the channel.

Every recorded observation is a prediction of this mechanism:

- No `bin.ts session --role …` process for the failing seats — there is nothing to run, because nothing was spawned.
- No per-session CLI cache directory for them, while both working seats have one — a cache directory is created by spawning, so its absence separates *never started* from *started and died*. This is the observation that rules out a startup crash.
- Correct `.mcp.json`, correct server name, correct per-pane cwd — the visible half of the bind is exactly right, which is why every check aimed at it came back clean.
- No `RoleUniquenessError`, and a hand-run `session --role intake-desk` starting cleanly — nothing ever claimed the role, so the role was free.
- Not the `inputSchema` whole-`tools/list`-discard failure mode — a discard requires a served server to discard from.
- A re-check after two minutes of real work failing identically — an unapproved project-scope server is resolved once at session start and never retried.
- `retire-role` then `spawn-role` fixing it, on two different roles — the respawned pane boots after the gate is satisfied.
- One of three first-cohort seats working, five of five later seats working — the gate is satisfied by the first acceptance, which is a one-way transition partway through the first cohort.

That last row is where this mechanism and the recorded tracker-readiness correlation come apart. Tracker readiness predicts all three simultaneous seats fail together; one of them worked.

### The alternative that source falsifies

The correlation table in the issue is real, but the causal story attached to it — a session MCP server starting before the tracker socket accepts, failing its startup announce and exiting — cannot happen, on two independent grounds.

First, no pane can start before the tracker accepts. `ensureTrackerRunning` spawns the detached standing tracker and then blocks on `awaitSocketServing`, which polls with a real client connect and either confirms the socket is serving or fails the launch with `TrackerNotServingError`. Both launch paths call it before anything is placed on screen: in `standup/orchestrate.ts` it precedes the reap, the plan build, the register and the launch loop, and in `standup/single-role.ts` it precedes the plan build and the pane split. A tracker that is not accepting aborts the launch with zero panes up, which is the no-partial-crew line.

Second, a session that found no tracker would not die. `peerSocketSubstrate` in `packages/pipeline-crew-mcp/src/crew/session.ts` builds its `CrewTracker` from `crewTrackerHostOrDialLayer`, which binds the rendezvous socket itself when it is free and only dials on `EADDRINUSE`. A session that starts before any tracker exists becomes the tracker.

"Started after the tracker" and "started after the gate was satisfied" select the same seats on the run that was observed, because both transitions happen during one stand-up. They are distinguishable, and the recorded evidence already distinguishes them.

### What is inferred rather than captured

The gate's state at the two failing panes' boot was not captured — the same gap the chief-of-staff flagged, and it is still open. What is source-verified is that the launcher does not seed the gate and does not verify it; beyond that, no other mechanism was found in the launch path that would leave a correctly-bound pane with no server process at all.

One cheap experiment settles it in both directions, and should be run before anyone builds a fix on top of this: with `pipeline-crew-mcp` absent from `enabledMcpjsonServers`, stand the crew up and expect channel-less panes until a human accepts; then seed that entry by hand before a second stand-up and expect every pane to come up with the channel.

## Decision

**The channel is an operator-gated precondition of a crew pane's boot, and the crew treats it as one.**

Three rules follow, and they are what this record binds.

**A still-absent channel toolset is permanent for that session.** `CHANNEL-TOOL.md`'s boot-window guard already bounds the wait and ends in a report rather than a longer wait, which was the correct disposition and both affected seats followed it. What it could not tell a seat is *which* failure it is in. It can now: an approval-gated server that was never spawned has no process, so one bounded `pgrep` for the seat's *own* session process distinguishes a boot window from a permanent absence without reading any crew-mcp source. The probe must key on identity unique to the seat. `--role` is not: at `roles.engineering-manager.count` = 3 the three engine seats share it, so a role-keyed probe run by a channel-less engine matches a healthy sibling and returns the one answer that is worse than no probe at all — "keep waiting". Only `--instance` is unique, and a seat can recover its own: an engine's pane label *is* its instance id, so the basename of its launch cwd (`<repo>/.claude/crew-run/<run id>/<pane label>`) is the string to match. A bridge is a singleton that carries no `--instance`, so for a bridge the role is already unique and is the right key. `CHANNEL-TOOL.md` states both forms. The prohibition on diagnosing infra from a seat stands — one probe, then report.

**A crew session has both channel tools or neither.** `assembleCrewSession` registers the `channel_send`, `channel_claim` and `channel_kinds` toolkits on one `McpServer` instance through one merged layer, so they cannot diverge. `channel_claim` is confirmed available whenever the session's server runs, and was observed returning `{"granted": true}` from a live engine seat. There is no separate claim-availability failure to chase: if an engine has `channel_send`, it has the lock.

**An engine that has no channel deconflicts over the board, and says so where the other engines can read it.** The operator config now sets `roles.engineering-manager.count` to 3, so the count > 1 unsafety this records is live rather than hypothetical: a channel-less engine cannot take the cross-engine resource claim, and a claim it cannot take is also a claim it cannot *read*. Board-visible markers — the issue assignee plus a claim comment naming the holding session — are the only deconfliction channel all three engines share, so an engine posts both before opening a lane and reads both before claiming one, whether or not its own channel is up. This is weaker than the lock: two engines can still race between read and post. It is the strongest thing available to a seat that cannot reach the tracker, and it is what the engine holding this issue's lane actually used.

**Not decided here: what to do about the gate itself.** Seeding it from the launcher would reverse the deliberate narrowing described above, and failing the launch closed on an unsatisfied gate means teaching the launcher the CLI's settings-merge order. Both are real options and neither is an investigation's side effect to smuggle in. What *is* corrected in the same change as this record is the launcher's prose, because a comment that asserts a seed which does not happen is what sent triage past the cause the first time. Every statement of that class is swept: the `ProjectScopeRegistrar` interface contract and its production implementation, the stand-up reap and register call sites, the `StandDownInput` contract and `runStandDown`'s docblock, `spawnRole`'s docblock, and the two `RegisterCrewProjectScopeInput` options (`configPath`, `settingsPath`) that are now marked dead rather than described as seeds. The comments change; no behaviour does.

## Consequences

Easier: a seat that reaches for the channel and does not find it can tell in one command whether waiting is pointless, and stops paying for a two-minute re-check plus a report on a failure that is already known. An engine pool at count > 1 has a stated, board-visible deconfliction protocol that does not assume the lock. Anyone fixing this starts from a mechanism with a one-command confirmation rather than from a correlation.

Harder: the deconfliction protocol is now something an engine must actively maintain — assignee plus claim comment, on every lane — rather than a lock it either holds or does not. The residual race between reading the board and posting to it is real and unfixed, and stays unfixed until either the gate closes or every engine reliably has the channel.

**Not addressed here.**

- **The gate itself**, as above.
- **The bridge `Task` absence**, which shares this issue's surface symptom and nothing else. It is a `disallowedTools` entry matched by base tool name, subtracting the whole tool; it is owned by #121 and its three affected agent definitions are being edited there.
- **A pre-boot toolset assertion.** The upstream `toolset-assert.ts` / `served-toolset.ts` that would have caught this class before a seat ever booted are missing from this repository and are owned by #78. The seat-side probe recorded here is a floor, not a substitute.
- **`reapCrewProjectScopeFor`'s dead parameters.** It still takes `serverName` and a `settingsPath` option it no longer uses, left over from the same narrowing. Harmless, and not this issue's to change.

## Records

Closes #104, scoped per that issue's re-scope to the MCP-channel case alone; #121 owns the `Task` half and #78 owns the missing pre-boot assertion. This record and the comment corrections it names are the whole of the change — no launcher behaviour is altered.

**No vocabulary impact.** Every term used here — crew pane, channel, seat, bridge, engine, the board — is already the repository's, so no `.glossary/TERMS.md` row is added.
