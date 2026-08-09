# pipeline-crew Reference

A dry, look-it-up description of the **pipeline-crew plugin's contracts**: the agent-def
frontmatter every crew def carries, the role roster (bridges vs engine), the config keys of
`crew.config.jsonc`, and the crew's notification transports. Every field/key below traces to
its shipped source (the four defs under [`agents/`](agents/), the config template, and the
cited plugin docs) and matches it.

This page is **Reference only** — it states what is true, not why or how. For the *why* (the
roster law, the personalization mechanism, the §CP posture) read [`README.md`](README.md) and
[`PERSONALIZATION.md`](PERSONALIZATION.md); for the rationale, follow the pointers there. Scope is
the **plugin surface** — the runtime channel substrate `pipeline-crew-mcp` has its own
docs, out of scope here.

## Agent-def frontmatter contract

Each crew def is a top-level Claude Code agent (`claude --agent crew-<role>`). Every def
carries the **same five frontmatter keys**; all are present in all four defs.

| Key | Type | Contract |
|---|---|---|
| `name` | string | The agent id — always `crew-<role>` (the launch target of `claude --agent crew-<role>`). |
| `description` | string (quoted) | The routing prose: what the agent is for, its typical triggers, and an explicit "Do NOT use it to…" negative. Single-quoted YAML; inner apostrophes are doubled (`''`). |
| `model` | string | Always `inherit` — a spawned session runs on the tier of the session that launched it (the tier is set at launch via the config's `roles.<role>.tier`, not hardcoded in the def). |
| `color` | string | The session's display color — one per role (see the roster below). |
| `tools` | string[] | The hard allowlist of callable tools. A tool absent here is uncallable even if its MCP server is connected. Every def lists the channel tool by its full MCP token (below). |

### The channel tool token — mandatory in every `tools:` allowlist

Every def's `tools:` array carries the crew channel-send tool by its exact MCP token:

```
mcp__pipeline-crew-mcp__channel_send
```

The token is derived, not guessed: `mcp__` + the server name sanitized
(`[^a-zA-Z0-9_-]` → `_`) + `__` + `channel_send`. `pipeline-crew-mcp` contains only characters
that class permits, so sanitization is a no-op and the joins are plain double underscores.
A wrong string fails closed (present-but-uncallable). Single source: [`CHANNEL-TOOL.md`](CHANNEL-TOOL.md).

Every def carries a **second** token beside it — `mcp__pipeline-crew-mcp__channel_kinds` — the
discovery tool that returns each message kind's payload schema. A sender reads a kind's shape
from it before its first send of that kind; without it in the allowlist the tool is
present-but-uncallable and the sender can only guess the `body`, because `channel_send`'s own
parameters declare no kind enum and no payload shape.

The **engineering-manager** (the one engine) carries a **third** channel token on top of those
two — `mcp__pipeline-crew-mcp__channel_claim` — which claims a tracker resource before it opens
a lane (cross-engine deconfliction, a real lock rather than a relayed message). Only the engine
lists it; the three bridges carry `channel_send` + `channel_kinds` alone. Why each needs its own
tool: [`CHANNEL-TOOL.md`](CHANNEL-TOOL.md).

### Per-def frontmatter values

The exact shipped values, matching each def head:

| Def file | `name` | `color` | `tools` |
|---|---|---|---|
| [`agents/crew-cartographer.md`](agents/crew-cartographer.md) | `crew-cartographer` | `green` | `Read`, `Bash`, `Task`, `channel_send`, `channel_kinds` |
| [`agents/crew-intake-desk.md`](agents/crew-intake-desk.md) | `crew-intake-desk` | `yellow` | `Read`, `Bash`, `Task`, `channel_send`, `channel_kinds` |
| [`agents/crew-engineering-manager.md`](agents/crew-engineering-manager.md) | `crew-engineering-manager` | `cyan` | `Task`, `Bash`, `Read`, `Grep`, `Glob`, `channel_send`, `channel_claim`, `channel_kinds` |
| [`agents/crew-chief-of-staff.md`](agents/crew-chief-of-staff.md) | `crew-chief-of-staff` | `magenta` | `Read`, `Bash`, `Task`, `channel_send`, `channel_kinds` |

Each `channel_*` name above is abbreviated for width — the def carries the full
`mcp__pipeline-crew-mcp__<tool>` token. Every seat carries `channel_send` + `channel_kinds`;
only the engineering-manager (the one engine) adds `channel_claim` (see the channel-token
subsection above). `model` is `inherit` for all four.

**All four roles carry `Task`**, because all four spawn subagents — the chief-of-staff spawns only
the read-only `crew-investigator`, but that fanout is still a spawn. *Which* subagents a role may
spawn is not a tool grant: the platform has no per-subagent deny at this layer (a `Task(x)` entry in
`disallowedTools` is matched by its base tool name and subtracts the whole `Task` tool, booting the
seat unable to spawn anything — #121). Each bridge therefore states its scope as a `**Never spawn**`
charter paragraph in its def, and `pipeline-cli crew-fanout-guard check` reds the build if that
paragraph stops covering the roster.

Bridges deliberately do **not** list `Grep`/`Glob`: those names are never served to a top-level
session, so declaring them reads as a capability the seat does not have. Fan an expensive read out
to `crew-investigator`, which does hold them, instead.

## Role roster — bridges and the engine

The roster is governed by the crew roster law (the topology rule: each unique-seam bridge is a singleton, while seam-free engines may scale and bridges never execute engine lanes): a **bridge** owns a unique
factory↔outside seam and is singleton (cardinality 1); the one **engine** owns no seam and is
fungible throughput (cardinality N). Cardinality falls out of the role KIND — declared in the
runtime's `crew/roles.ts` — not a per-install count. Three bridges + one engine pool:

| Role | Kind | Cardinality | Seam it owns | Def |
|---|---|---|---|---|
| cartographer | bridge | 1 | inbound ideation — the founder's fog → charted work (runs `wayfinder`) | [`agents/crew-cartographer.md`](agents/crew-cartographer.md) |
| intake-desk | bridge | 1 | intake — world's observations → typed, prioritized backlog (runs report → triage; spawns planner/canon/adr) | [`agents/crew-intake-desk.md`](agents/crew-intake-desk.md) |
| chief-of-staff | bridge | 1 | outbound awareness — factory state → founder understanding; human comms to founder + §CP approver | [`agents/crew-chief-of-staff.md`](agents/crew-chief-of-staff.md) |
| engineering-manager | engine | N | none — pulls ready work off the board and drives coder → reviewer → shipper under WIP caps | [`agents/crew-engineering-manager.md`](agents/crew-engineering-manager.md) |

Only the engine takes a `count` and a `wipCap`; a bridge takes neither (its cardinality is
fixed at 1). See [`README.md`](README.md) for the topology diagram and the comms graph.

## Config keys — `crew.config.jsonc`

The personalization seam. The plugin ships [`crew.config.template.jsonc`](crew.config.template.jsonc)
with `<placeholder>` values only; `pipeline init` materializes it as the operator-owned,
git-ignored `.claude/crew.config.jsonc` (or an operator can use `$CREW_CONFIG`) and the operator
fills every placeholder. Resolution order:
`$CREW_CONFIG` if set, else `.claude/crew.config.jsonc`. Every key below matches the template.

| Key | Type | Required | Placeholder |
|---|---|---|---|
| `operator.name` | string | yes | `<operator-name>` |
| `operator.handle` | string | yes | `<operator-handle>` |
| `controlPlaneApprover.name` | string | yes | `<control-plane-approver-name>` |
| `controlPlaneApprover.login` | string | yes | `<control-plane-approver-login>` |
| `roles.chief-of-staff.tier` | tier | yes | `<chief-of-staff-model-tier>` |
| `roles.cartographer.tier` | tier | yes | `<cartographer-model-tier>` |
| `roles.intake-desk.tier` | tier | yes | `<intake-desk-model-tier>` |
| `roles.engineering-manager.tier` | tier | yes | `<engineering-manager-model-tier>` |
| `roles.engineering-manager.count` | integer > 0 | yes (engine only) | `<engine-count>` |
| `roles.engineering-manager.wipCap.productLanes` | integer | yes (engine only) | `<wip-cap-product-lanes>` |
| `roles.engineering-manager.wipCap.platformLanes` | integer | yes (engine only) | `<wip-cap-platform-lanes>` |
| `notification.operator.command` | string | yes | `<operator-notification-command>` |
| `notification.operator.handle` | string | yes | `<operator-notification-handle>` |
| `notification.controlPlaneApprover.command` | string | yes | `<control-plane-approver-notification-command>` |
| `notification.controlPlaneApprover.handle` | string | yes | `<control-plane-approver-notification-handle>` |
| `cliVersion` | string (`major.minor.patch[-suffix]`) | **optional** | omit, or `<pinned-claude-code-cli-version>` |
| `terminal` | `tmux` \| `herdr` | **optional** (default `tmux`) | omit, or `<terminal: tmux \| herdr>` |
| `channels.mode` | `allowlist` \| `development` | yes | `<channel-mode: allowlist \| development>` |
| `channels.servers` | string[] (channel refs) | yes | `<channel-server-ref>` |
| `channels.allowedChannelPlugins` | string[] | yes | `<allowed-channel-plugin>` |

**Enumerations.**

- `tier` — one of `opus` \| `sonnet` \| `haiku` \| `fable` (passed as the launched session's
  `claude --model <tier>`; omit a role's `tier` to boot on the CLI default).
- `channels.mode` — `allowlist` launches sessions with `--channels <refs>` (only listed
  servers load); `development` launches with `--dangerously-load-development-channels` (loads
  every dev channel; local only).
- `channels.servers` ref grammar — `server:<name>` (a top-level channel MCP server, dev mode
  only) or `plugin:<name>@<marketplace>` (a server contributed by an installed plugin).
- `terminal` — `tmux` places the crew as panes of one tiled `crew` window; `herdr` places it as
  panes of one `pipeline` tab (its binary must be on `PATH`). One pane per role either way; a
  multiplexer is only ever a window manager here, never the crew's transport.

**Optionality.** Two keys are optional, in different ways. `cliVersion` (the optional CLI-version
rule) is *exact-optional*: omit it for an unpinned launch; a present value is a hard exact-match gate
asserted before any session starts. `terminal` is *total*: omitting it is not a distinct variant, it
decodes to `tmux`. Every other key is required — the stand-up launcher fails closed on a missing or
malformed dimension, naming that dimension, never a silent default. A present-but-unknown `terminal`
fails closed too.

**Terminal selection.** `stand-up`, `spawn-role`, and `retire-role` each accept
`--terminal <tmux|herdr>`, which overrides the config for that invocation. A crew is stood up,
spawned into, and retired under ONE backend — a tmux pane id means nothing to herdr — so switching
backends means `stand-down` then `stand-up`.

The full dimension rationale and the consuming def references are in
[`PERSONALIZATION.md`](PERSONALIZATION.md).

## Notification transports

The crew has two transport surfaces: the **crew-internal channel** roles coordinate over, and
the **human-notification commands** the chief-of-staff invokes to reach a person.

### Crew-internal channel — `channel_send`

Every role coordinates over one MCP tool, served by `pipeline-crew-mcp` (wired per
session via `--channels server:pipeline-crew-mcp`).

- **Signature** — `channel_send {targetRole, kind, body}`. *Inbox* discovery is implicit: the
  substrate resolves the target role's inbox, so you never name a session. *Contract*
  discovery is not — call `channel_kinds` to read a kind's payload schema before your first
  send of that kind, or `body` is a guess against a decode check.
- **Results** — success returns an `InboxAck` (delivered-to-inbox + wake enqueued, **never**
  seen-by-model); an unreachable peer returns a `PeerUnreachableError {target, reason}`, and a
  `body` that fails its kind's schema returns an `InvalidMessageError {kind, reason}` — a
  rejected send, never a delivered one.
- **Inbound** — arrives to the recipient as a wake tag
  `<channel from="inbox://<role>" kind="…">…JSON…</channel>`.
- **Offline behavior** — log and continue. A `PeerUnreachableError` is logged and dropped; no
  retry, no escalation, no ack-required kinds (every edge is a latency optimization over the
  board, so a failed send costs latency, not correctness).
- **Boot window** — the tool is not advertised the instant a session becomes interactive (the
  server claims its tracker slot before serving). If `channel_send` isn't in your toolset yet,
  wait and re-check; do not investigate infra. See [`CHANNEL-TOOL.md`](CHANNEL-TOOL.md).

The live edges and their kinds (source: [`README.md`](README.md) comms graph):

| From | To | Kind | Payload |
|---|---|---|---|
| cartographer | intake-desk | `IntakePing` | — |
| engineering-manager | intake-desk | `IntakePing` | — |
| chief-of-staff | intake-desk | `IntakePing` | — |
| engineering-manager | chief-of-staff | `DrainProgress` | `inFlight` (live lane count) |

### Human notification — per-recipient transport commands

The plugin ships **who** gets pinged and **when**; the config supplies **how**. Two
per-recipient transports, each `{command, handle}`, invoked by the chief-of-staff:

| Recipient | Config keys | What it pings |
|---|---|---|
| operator | `notification.operator.{command, handle}` | Situational-awareness reads; ping-me-when-X-lands. |
| §CP approver | `notification.controlPlaneApprover.{command, handle}` | The bank-and-carry relay for a §CP PR at its live head (the control-plane rule: a non-author must approve the current head before the pipeline enqueues the change). |

`command` is an operator-supplied transport the chief-of-staff runs; `handle` is the addressee
it targets. The plugin knows nothing of the channel (iMessage / Slack / Discord), so switching
channels is a config swap, not a code change. Any local script path lives only in the
operator's config, never in the repo.

### Liveness probes — three outcomes

The conducting roles (the engineering-manager engine, the chief-of-staff verifier) probe
external surfaces (most often "is the GitHub API healthy?") before acting. A probe resolves to
exactly one of three outcomes; the source contract is [`PROBES.md`](PROBES.md):

| Outcome | Meaning | May gate? |
|---|---|---|
| reachable / healthy | probe ran, target answered healthy | proceed |
| reachable / unhealthy ("down") | probe **ran** and observed the target failing | **yes** — the only gating outcome |
| unrunnable ("unknown") | probe **could not execute** (missing binary, PATH strip, exec error) | no — fail open, proceed as if reachable |

Probes fail **open**: an unrunnable probe is "unknown", never "down". Never wrap a probe in a
binary that may not exist on PATH (e.g. bare `timeout`).

## See also

- [`README.md`](README.md) — the crew front door: topology, comms graph, §CP posture (the *why*).
- [`PERSONALIZATION.md`](PERSONALIZATION.md) — the config seam mechanism and dimension rationale.
- [`CHANNEL-TOOL.md`](CHANNEL-TOOL.md) — the channel tool token and boot-window discipline.
- [`PROBES.md`](PROBES.md) — probe discipline (fail-open liveness/health probes).
- [`SPAWN-SCOPE.md`](SPAWN-SCOPE.md) — which agents a seat may spawn, why the restriction is
  charter prose, and the rules that keep a declared `tools:` line from resolving to less.
