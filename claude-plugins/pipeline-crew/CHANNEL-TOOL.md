# The crew channel tools — their allowlist tokens, and the boot-window wait

Every crew role coordinates over the tools the crew channel MCP server serves
(`pipeline-crew-mcp`, wired per session via `--channels server:pipeline-crew-mcp`): the send
tool `channel_send`, the discovery tool `channel_kinds`, and — for the engine alone — the
claim tool `channel_claim`. **This doc is the single source for two things a role needs to
actually call them**: the exact allowlist tokens its `tools:` frontmatter must carry, and how
to behave in the brief window right after boot before the channel has connected. The four
crew defs cite this; they never re-derive it inline.

When adopting this plugin against a differently-named channel server, derive the allowlist
token from that exact server name using the rule below and update the agent frontmatter to
match; never copy a token from an install whose server name differs from yours.

## The allowlist token — `mcp__pipeline-crew-mcp__channel_send`

A crew session boots as a top-level `claude --agent crew-<role>` session, so the role's
agent-def `tools:` allowlist is the hard gate on what the model can call. A connected MCP
server whose tool is **absent from that allowlist is present-but-uncallable** — `/mcp` shows
the server up with `channel_send`, yet the model's toolset does not include it, so the role
cannot coordinate. That omission — not boot timing — was the live cutover failure: a role
tasked to dispatch found the tool missing and burned budget reverse-engineering its own
channel (the required channel-tool declaration, the root cause of the channel-discovery stall symptom).

So each crew def's `tools:` allowlist **must list the channel tool by its full MCP token**:

```
mcp__pipeline-crew-mcp__channel_send
```

That token is not a guess — it is how claude-code derives an MCP tool's callable name:
`mcp__` + the server name sanitized by `replace(/[^a-zA-Z0-9_-]/g, "_")` + `__` + the tool
name. The server name `pipeline-crew-mcp` contains only characters that class permits, so
sanitization leaves it unchanged and the joins are plain double underscores. (The historical
scoped name `@kampus/pipeline-crew-mcp` sanitized its `@` and `/` to `_`, whose leading `_`
made the first join a *triple* underscore — the trap to know about if an old def string ever
resurfaces.) Grounded against the claude-code 2.1.214 tool-name builder and confirmed against
the live `/mcp` tool name — a wrong string silently fails closed and re-blocks cutover, so it
is copied exactly, never approximated.

## The discovery tool — `channel_kinds` (resolve a payload shape before sending)

Every role that sends **also** carries the discovery tool, `channel_kinds` — the token derived
the same way:

```
mcp__pipeline-crew-mcp__channel_kinds
```

It takes no required argument and returns the whole channel contract: every message kind's
payload as a JSON Schema, plus each role's sanctioned send/receive seams. A sender reads a
kind's shape from it **before its first `channel_send` of that kind**, so it builds a valid
`body` up front instead of learning the shape from a send-time reject.

That matters because `channel_send` cannot teach the shape by itself. Its parameters are
`kind: NonEmptyString` and `body: Unknown` — no enum of the valid kinds, no payload shape — so
a role that cannot call `channel_kinds` has nothing to read and guesses. The reject path is
real and lossy: `channel_send` decode-checks `body` against the kind's schema and returns
`InvalidMessageError` instead of an ack, so a seat with no inbound example to copy burns
retries one missing key at a time. Because `channel_kinds` is served on the same `McpServer`
as `channel_send` (`crew/session.ts`), its token is required for the same reason: absent from
a def's `tools:`, the tool is present-but-uncallable and the discovery step is impossible.
Every sending seat lists it — the three bridges and the engine alike.

## The engine's second tool — `channel_claim` (resource deconfliction)

The **engineering-manager** (the one engine role) additionally carries a second channel tool,
`channel_claim` — the token derived the same way:

```
mcp__pipeline-crew-mcp__channel_claim
```

A session serves **both channel tools or neither** — they register on one MCP server through one
merged layer — so an engine that can see `channel_send` can take the lock, and an engine that
cannot see one cannot see either. There is no partial-toolset case to check for.

`channel_send` and `channel_claim` are **different mechanisms, not variants**: `channel_send`
relays a typed message to a peer's inbox (coordination), while `channel_claim` invokes the
tracker's resource-keyed `Claim` and returns a `{granted, collision, owner}` reply — a real
cross-engine lock. An engine calls `channel_claim {resource: "<issue>"}` **before it opens a
lane**: `granted` ⇒ it holds the lane, `collision` ⇒ another engine holds it (back off). Sending
a `Claim`-shaped message via `channel_send` does **not** lock anything — it just delivers a
message to an inbox — which is why the claim needs its own tool (the duplicate-claim failure). Only the engine carries
it; the bridges (chief-of-staff, cartographer, intake-desk) claim nothing, so they carry
`channel_send` + `channel_kinds` but not `channel_claim`.

## The boot window — wait and re-check, never diagnose infra

Even with the token in place, the crew server does not advertise `channel_send` the instant a
session becomes interactive: the server only serves the tool once it has claimed its peer slot
on the tracker (the claim-before-serve ordering, the claim-before-serve rule), and on cutover — when many panes boot
at once — that claim can lag a moment behind the session becoming taskable. A role tasked
inside that window will briefly not see `channel_send` in its toolset.

**If you need `channel_send` for a task and it isn't in your toolset yet, WAIT briefly and
re-check — do not investigate infra or read crew-mcp source.** The channel connects on its own
with no intervention (steady state: an idle role's channel is long up before work arrives).
The flailing — reading `channel-server.ts`, running the session binary by hand — is exactly the
~44k-token burn this guard exists to prevent (the channel-discovery stall). Give the connect a moment, look again,
then proceed.

**The wait is bounded, and a still-empty toolset is a REPORT, not a longer wait.** A permanent
failure looks identical to the boot window from a seat, so waiting patiently on one burns a whole
session silently — that is exactly what the schema-validation failure did (one spec-invalid tool `inputSchema` made the
CLI discard the server's entire `tools/list`, so no seat ever saw any channel tool). If the tools
are still absent after a re-check or two, stop waiting and **file it** (the `report` skill) —
still without diagnosing infra yourself.

## Still absent after the re-check — one probe, then act

A permanent absence and the boot window are indistinguishable from a seat, so the re-check above
can only ever end in "wait more or report". **One** bounded command separates them, and it is the
only infra call this doc sanctions:

```
pgrep -f "session --role <your role>"
```

Your session's channel server runs as `<node> <…>/bin.ts session --role <your role> …`. A match
means a server exists and the toolset is genuinely mid-connect — re-check as above. **No match
means no server was ever started for your session, and none will be**: the channel is gated on host
state read once at your pane's boot, so nothing arrives later and further waiting is pure cost. Run
this probe once, act on the answer, and stop — reading crew-mcp source is still the ~44k-token burn
this document exists to prevent.

On no match, report it and then **carry on over the board**. Everything a channel-less seat needs
is already board-visible: an engine posts its lane as the issue assignee plus a claim comment naming
its session before opening the lane, and reads both before claiming one, because a seat that cannot
take the cross-engine claim also cannot read it. That is weaker than the lock and is the whole
mitigation available at engine count > 1. The mechanism, the evidence, and what is deliberately left
unfixed are recorded in `.decisions/0002-crew-channel-is-an-operator-gated-boot-precondition.md`.
Recovery, if an operator is at the keyboard, is `retire-role` then `spawn-role` — it costs the seat
its context, so it is a recovery and not a fix.
