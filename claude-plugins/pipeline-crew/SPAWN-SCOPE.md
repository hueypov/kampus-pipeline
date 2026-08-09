# Spawn scope — which agents a seat may spawn, and why it is a charter rule

The crew roster law (the topology rule: each unique-seam bridge is a singleton, while seam-free
engines may scale and bridges never execute engine lanes) keeps the build drain on the **engine**
and off the **bridges**. A bridge conducts its own seam and fans expensive reads out to the
write-tool-free `crew-investigator` (the investigation rule: investigators have no mutation tools
and return only distilled read results); it never runs `coder → reviewer → shipper`.

Each bridge def states its **own** scope in full — a `**May spawn:**` list, a `**Never spawn:**`
list, and the paragraph of why — because a booted seat reads only its own file, so a cross-file
pointer would dangle exactly where the rule has to hold. **This doc is the single source for what
is true of the line rather than of one seat**: the roster-wide shape, the evidence behind the
mechanism claim, the rules for editing a def, and how far enforcement actually reaches.

Read it before you change a seat's scope or its `tools:`. Do not read it for a seat's own list —
that lives in the seat's def, and the enforced copy lives in the guard.

## Who is scoped, and who is not

| Seat | Kind | Spawn scope |
|---|---|---|
| [`crew-cartographer`](agents/crew-cartographer.md) | bridge | the investigator, its Prototype-spike `coder`, and the ideation-legwork agents |
| [`crew-intake-desk`](agents/crew-intake-desk.md) | bridge | the investigator, its planning/canon/intake agents, and — the one scoped exception — a `reviewer` wrapping `review-plan` over a ledger it planned |
| [`crew-chief-of-staff`](agents/crew-chief-of-staff.md) | bridge | the investigator, and nothing else — it is pure verify-and-carry |
| [`crew-engineering-manager`](agents/crew-engineering-manager.md) | engine | **unscoped by design** — spawning `coder → reviewer → shipper` *is* its charter |
| [`crew-investigator`](agents/crew-investigator.md) | fanout | holds no `Task`, so it spawns nothing at all |

Each row is a summary. The seat's binding list is in its def; the **enforced** list is
`BRIDGE_ALLOWLIST` in
`packages/pipeline-cli/src/tools/crew-fanout-guard/crew-fanout-guard.ts`, which is what the guard
below checks the defs against. Three copies exist on purpose and they are not interchangeable:
prose a seat obeys, a table a human reads, a constant CI enforces.

Two properties of the shape are worth stating once, because no single def can:

- **The closure is transitive, not local.** Excluding the review/merge gates from a bridge would be
  worthless if the bridge could spawn something that holds them. So each bridge also excludes the
  engine — whose charter *is* the build drain — the peer bridges, and its own seat. The
  investigator holds no `Task`, which closes the last edge. The exclusion is therefore complete
  over every agent-type that exists, rather than a bet on how nested spawns behave.
- **Exactly one bridge holds a scoped exception**, and it is scoped by *gate*, not by trust — the
  intake-desk's `review-plan`, described in the next section. Every other gate a bridge might seem
  entitled to fire stays the engine's. The general rule still holds everywhere else: planned
  children become pickable on the board, which is how work crosses from a bridge to the engine, and
  a bridge does not follow them across.

## The one scoped exception — the intake-desk's `review-plan` gate

The intake-desk spawns `reviewer` **only when wrapping `review-plan`** over an epic ledger it had
itself planned — the closing step of planning, not an entry into the build drain. The four PR-stage
gates (`review-code`, `review-doc`, `review-skill`, `review-design`) plus `coder` and `shipper`
remain the engine's seam, and no other bridge gains `reviewer`.

The line the roster law draws is intact, because **a plan-layer gate routes nothing**. What the
roster law forbids a bridge is an *execution-routing* edge, and a gate fired over a planned ledger
hands no work to an engine: a flipped child becomes pickable off the board exactly as a
`triage`-produced one does. Three properties of this repo make that concrete rather than asserted —
check them before widening the exception:

- `review-plan` reads a **ledger, never a diff** — its subject is the epic and its children.
- It posts into **no verdict namespace**: `verdict-match.ts` carries only `code`, `doc` and `skill`,
  so a `review-plan` run produces no marker any downstream gate consumes.
- The engine is **structurally disqualified** from firing it. It consumes triaged children; it
  cannot produce them. The seat that planned the ledger is the only one positioned to close it.

The reviewer's independence comes from **isolation, not from which seat fired it**: it is a
separately spawned agent that reads the epic and its children cold. That is why dispatch stays a
fixed template — the intake-desk hands over an epic number and nothing else, so it cannot colour the
review of a ledger it wrote.

**The guard cannot express this scoping.** `BRIDGE_ALLOWLIST` classifies per agent-type, not per
skill, so it can only record that the intake-desk may spawn `reviewer` at all. The `review-plan`-only
restriction therefore lives in the intake-desk's charter prose — including the fixed dispatch
template it must use — and the guard carries the agent-type alone. If you are reading the guard to
learn the scope, you are reading the wrong file:
[`agents/crew-intake-desk.md`](agents/crew-intake-desk.md) is the binding one.

## The line is a charter rule, not a permission mechanism

The defs used to carry `disallowedTools: ["Task(coder)", "Task(reviewer)", …]` and describe it as
the permission engine hard-blocking those spawns. **That mechanism does not exist at this layer**,
and declaring it was worse than declaring nothing (#121).

A `disallowedTools` entry is matched by its **base tool name**. The `(specifier)` is ignored and
the **whole tool** is subtracted from that def's `tools:` allowlist — so `disallowedTools:
["Task(coder)"]` never denied the `coder` subagent, it deleted `Task`. What was observed live on
the bridge seats:

- `crew-intake-desk` declared `["Read","Bash","Grep","Glob","Task","mcp__pipeline-crew-mcp__channel_send"]`
  and was served `Read`, `Bash`, `mcp__pipeline-crew-mcp__channel_send` — `Task`, `Grep`, and
  `Glob` all absent. `crew-cartographer`, where the defect was first seen, came up with exactly the
  same three. The intake-desk carried seven `Task(...)` entries and a third seat carried twelve,
  and both lost `Task` outright, so the count never mattered.
- The failure message discriminates the two candidate mechanisms. A spawn attempt returned **`Task
  exists but is not enabled in this context`** — a not-granted message. A genuinely denied
  specifier reports the rule that denied it (`Agent type 'coder' has been denied by permission rule
  'Task(coder)'`). The tool was never granted, rather than granted and then filtered.

The consequence was the inverse of the intent: all three bridges booted able to spawn **nothing**.
The intake-desk could not spawn the `planner` over the epic it had just triaged, and no seat could
reach the read-only fanout — so every expensive read landed in a singleton context that never
clears. A restriction meant to narrow a bridge's spawns had removed every spawn it was meant to
keep, silently, with the def still reading as if it were enforced.

Treat the whole per-subagent-deny family as unavailable. `permissions: { deny: [...] }` in an agent
def is the obvious next reach and has never been shown to block a spawn here under any token
spelling (`Task(x)`, `Task(<plugin>:x)`, `Agent(x)`); do not adopt it on the assumption that it
works. The platform grants `Task` at whole-tool granularity, which is the only granularity it
offers.

So the scope is stated where a seat actually reads it — **its own charter prose**. A seat that
spawns outside its stated scope is violating its charter, the same way it would be by implementing
a ticket or merging a PR; nothing below the model stops it.

## Editing a def — three rules that keep the declaration honest

The CLI drops a tool name it cannot grant **with no warning**, which is why the lost `Task` ran a
whole session unnoticed. A def is therefore written so its declared toolset resolves intact:

- **Never add `disallowedTools:` to an agent def.** Not with a specifier, not without one — the
  key's only observed effect here is deleting a tool the seat needs. The guard reds the build if a
  bridge def carries it at all.
- **Never name a tool a top-level seat is not served.** `Grep` and `Glob` are never served to a
  top-level session, so declaring them reads as a capability the seat does not have. Fan the
  expensive read out to `crew-investigator`, which is a spawned subagent and does hold them.
- **Never let a tool name appear twice under two keys.** A name in both `tools:` and a deny-shaped
  key resolves to absent, not to granted.

If you narrow or widen a seat's scope, the edit is not finished until the seat's def, the summary
table above, and `BRIDGE_ALLOWLIST` all agree. The guard fails closed when the def and the
allowlist disagree; keeping the table here in step is on you.

## What is enforced, and what is not

**Coverage is enforced.** `pipeline-cli crew-fanout-guard check` owns the per-bridge
classification: every mutating agent-type in the roster must be on a bridge's sanctioned allowlist
**or** named in that bridge's `**Never spawn**` paragraph, and it separately asserts each bridge
def is *shaped* so its toolset resolves — `Task` granted, no `disallowedTools`, no ungrantable
name. A newly-added agent-type on neither list reds the build, and so does a bridge def that would
boot degraded. The guard is fail-closed by construction: a zero-length roster, a missing bridge
def, or a stale allowlist entry is a red verdict, never a vacuous pass. It runs over the **shipped**
defs — not a fixture — from the test suite this repository's CI runs
(`packages/pipeline-cli/src/tools/crew-fanout-guard/gate.live.test.ts`); no dedicated workflow
invokes the `check` verb yet.

**Obedience is not enforced.** The guard is a completeness check on the *policy* — it guarantees
the line is always stated, never that a seat honors it. Nothing available at this layer would
change that: enforcing obedience needs the per-subagent deny the previous section rules out.

**What a seat is served is not verified at all.** Everything above reads what a def *declares*. No
check in this repository reads what a booted session was actually *granted*, which is the layer the
defect lived at and the reason it survived a whole session — that gap is open as #133. Until it
closes, a stand-up is the only thing that can confirm a seat came up with the tools its def claims,
and confirming it is worth doing after any edit to a def's `tools:`.

## See also

- [`agents/crew-cartographer.md`](agents/crew-cartographer.md),
  [`agents/crew-intake-desk.md`](agents/crew-intake-desk.md),
  [`agents/crew-chief-of-staff.md`](agents/crew-chief-of-staff.md) — the three **Spawn scope**
  sections this doc backs, each binding on its own seat.
- [`REFERENCE.md`](REFERENCE.md) — the frontmatter contract: what each def declares, tool by tool.
- [`EXPLANATION.md`](EXPLANATION.md) — the roster law itself, and the rest of the *why* behind the
  four defs.
- [`PROBES.md`](PROBES.md) — the sibling rule for the other thing a seat must not get wrong on its
  own: a probe that cannot run is "unknown", never "down".
- `packages/pipeline-cli/src/tools/crew-fanout-guard/` — the guard: the enforced allowlist, the
  def-shape check, and the live gate over the shipped defs.
