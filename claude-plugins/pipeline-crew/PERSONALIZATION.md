# pipeline-crew personalization seam

The **personalization seam** is the single per-install configuration surface through
which every operator-specific detail enters a crew install. The shipped plugin content
(the four agent defs, this doc, the config template) carries **zero real operator
data** — only `<placeholders>`. An operator supplies their own people and machine once,
at stand-up, and the crew addresses *them* instead of the original author.

This doc is the **contract the crew agent defs write against**: a def never hardcodes an
operator name, an approver login, a notification handle, or a model tier — it names the
corresponding seam key and resolves the value at spawn from the operator's config. The
config expresses the **settled crew shape** (the roster law of
the topology rule: each unique-seam bridge is a singleton, while seam-free engines may scale and bridges never execute engine lanes): one role map keyed by
role kind, and per-recipient notification commands. A role's address is a runtime lease it
acquires from the tracker, so no session-placement keys enter the seam.

## Why a read-at-runtime config file (grounded in the plugin spec)

The mechanism is grounded in how Claude Code plugins actually configure, per the
official **[Plugins reference](https://docs.claude.com/en/docs/claude-code/plugins-reference)**,
not intuition. Document every deliberate deviation from that host plugin specification:

- **Plugin content is static, shared, version-controlled component files** — `agents/`,
  `commands/`, `skills/`, `hooks/` (Plugins reference, *Plugin components*). Those files
  are the *same bytes* for every operator who installs the plugin, so by construction
  they cannot carry one operator's personal data. Per-operator values must live
  **outside** plugin content.
- **The toolkit path is fixed by `.pipeline/pipeline.json` and the managed
  `claude-plugins/` links.** It identifies shared toolkit code, never operator data. Operator
  config therefore lives outside the toolkit at `.claude/crew.config.jsonc` (or the
  `$CREW_CONFIG` override).
- **The spec has no install-time settings prompt** that would inject per-operator values
  into agent-def prose. So operator config is supplied the same way companion pipeline skill suite
  already supplies its one piece of host config — a **read-at-runtime, operator-owned
  source with an env override**, following the repository-resolution rule: honor the repository override when set, otherwise derive the current working repository (`CLAUDE_PIPELINE_REPO` →
  `gh repo view`). pipeline-crew mirrors that precedent exactly.

**Mechanism.** The plugin ships one **template**,
[`crew.config.template.jsonc`](crew.config.template.jsonc), containing every seam key with
`<placeholder>` values only. At stand-up the operator copies it to an **operator-owned**
config file (never committed into the plugin) and fills every placeholder. Each crew def,
at spawn, reads that file and binds its placeholders before acting.

**Resolution order:** `$CREW_CONFIG` overrides the repository-local default:

1. **`$CREW_CONFIG`** if set — an absolute or working-dir-relative path to the operator's
   filled config, for operators who keep it outside the working repo.
2. Otherwise the working repo's **`.claude/crew.config.jsonc`** — the zero-config default;
   operator-owned and operator-`.gitignore`d, so no operator data ever enters *this* repo.

A def that cannot resolve a filled config **stops and asks the operator to run stand-up**
— it never falls back to a baked-in default human, because there is none.

## The personalization dimensions — enumerated here, in one place

Every operator-specific and machine-specific dimension the crew depends on is enumerated
**once, here**; the config template's keys are exactly this set, and the def children
reference these keys, never a literal.

| Dimension | Config key | What it supplies | Placeholder |
|---|---|---|---|
| Operator / founder | `operator.name`, `operator.handle` | The human the crew serves and addresses — the founder/operator identity every role reports to. | `<operator-name>`, `<operator-handle>` |
| Control-plane approver identity | `controlPlaneApprover.name`, `controlPlaneApprover.login` | Who reviews/approves/merges control-plane (§CP) PRs — the human the engine banks §CP work for on the board (assigning the banked PR to this `login`) and the chief-of-staff carries out to (the control-plane rule: a non-author must approve the current head before the pipeline enqueues the change). This is the *identity*; the *transport* that pings them is the notification row below. | `<control-plane-approver-name>`, `<control-plane-approver-login>` |
| Role map | `roles.<role>.{tier, count?, wipCap?}` | **One map, keyed by the role kinds** in `.pipeline/toolkit/packages/pipeline-crew-mcp/src/crew/roles.ts` — a roster change is one map edit, not N key-family edits. Each entry carries the role's `tier` (its session's model tier — a role never silently downgrades a spawned subagent); an *engine* also carries `count` (its pool size) and `wipCap` (its concurrent-lane cap). A *bridge* is singleton, so it takes neither — cardinality falls out of the kind. | see the per-field rows below |
| — role model tier | `roles.<role>.tier` | The model tier each role's session runs on — the planning-tier bridges (`chief-of-staff`, `cartographer`, `intake-desk`) vs the execution/build-tier engine (`engineering-manager`). | `<chief-of-staff-model-tier>`, `<cartographer-model-tier>`, `<intake-desk-model-tier>`, `<engineering-manager-model-tier>` |
| — engine count | `roles.engineering-manager.count` | How many `engineering-manager` engines the stand-up boots — the engine is kind `engine` (cardinality N); a positive integer. Bridges omit `count` (they are cardinality 1). | `<engine-count>` |
| — engine WIP cap | `roles.engineering-manager.wipCap.{productLanes, platformLanes}` | A conductor engine's bounded concurrent-lane count, lane-partitioned — how many product vs platform/pipeline coders one engine drives at once before queueing the rest. The overall cap is the split's sum; the borrow/rebalance behavior is doctrine shipped in the engineering-manager def (the seam carries only the per-install values). | `<wip-cap-product-lanes>`, `<wip-cap-platform-lanes>` |
| Notification — per recipient | `notification.operator.{command, handle}`, `notification.controlPlaneApprover.{command, handle}` | Per-recipient human notification. The plugin ships **who** gets pinged and **when**; the config supplies **how** — an operator-supplied transport `command` the chief-of-staff invokes, targeting `handle`. The plugin knows nothing of the channel (iMessage/Slack/Discord), so a Discord-bot future is a config swap, not a code change. Any local script path lives only in the operator's config, never in the repo. | `<operator-notification-command>`, `<operator-notification-handle>`, `<control-plane-approver-notification-command>`, `<control-plane-approver-notification-handle>` |
| Pinned CLI version | `cliVersion` | **Optional** (the optional CLI-version rule). OMIT ⇒ the launcher accepts whatever `claude --version` reports (an "unpinned" launch — so the boot no longer fail-closes on every frequent Claude Code auto-update). Set it ONLY to deliberately lock a version: a present pin (`major.minor.patch`, optional `-suffix`) is a hard exact-match gate asserted before any session starts, so a drifted CLI refuses to launch. | omit, or `<pinned-claude-code-cli-version>` |
| Channel registration | `channels.mode`, `channels.servers`, `channels.allowedChannelPlugins` | How each launched session registers its channel MCP servers: `mode` is `allowlist` (`--channels <refs>`) or `development` (`--dangerously-load-development-channels`, local only); `servers` are the refs each session registers (grammar `server:<name>` / `plugin:<name>@<marketplace>`); `allowedChannelPlugins` is the plugin allowlist the `allowlist` mode enforces. | `<channel-mode: allowlist \| development>`, `<channel-server-ref>`, `<allowed-channel-plugin>` |

Adding a new operator-specific dimension is **one row here + one key in the template + one
reference in the def that needs it** — never a new literal buried in a def. Adding a role to
the crew is **one entry in `roles`** (and one kind in `crew/roles.ts`), never a new key
family.

### The launch dimensions have a typed reader (fail-closed)

The launch dimensions — the engine `count`, `cliVersion`, and `channels` — are inputs the
stand-up launcher reads, not prose an agent def binds. They resolve through the **same**
order as every other seam key (`$CREW_CONFIG` → `.claude/crew.config.jsonc`) but are
consumed by a typed launcher configuration reader,
`.pipeline/toolkit/packages/pipeline-crew-mcp/src/standup/config.ts`,
which validates them and **fails closed** — a missing or malformed dimension (an unknown
channel mode, a channel ref off-grammar, a non-positive engine count, or a present-but-non-version
CLI pin) stops the launch with an error naming that dimension, never a silent default. The lone
exception is `cliVersion`, which is optional (the optional CLI-version rule): an OMITTED pin decodes cleanly to an
unpinned launch — only a present pin is validated and asserted. The launcher
children (version-assert, bind-builder, roster, orchestration) consume the reader's typed
result; they never re-parse the config. Because the template leads the launcher in this
crew-architecture wave (wayfinder:map the crew-architecture map), reconciling the typed reader to consume the
engine count off `roles.engineering-manager.count` is a launcher follow-up in
`packages/pipeline-crew-mcp`, outside this seam's plugin surface.

## Tied-off and deferred seam gaps

The wayfinder map (the crew-architecture map) flagged three seam questions to resolve here rather than drop:

- **Operator gh identity — tied off as a live-resolution contract, not a key.** The
  intake-desk's triage routing rule keys on the session's **live-authenticated `gh`
  login** (`gh api user`), resolved fresh per run. That is deliberately *not* a config key:
  a static copy would drift from the identity the session actually authenticates as. The
  contract is the seam — a role reads its own live login, never a stored one.
- **Operator interaction preferences — deferred.** Language constraints, do-and-report
  posture, and similar interaction preferences have **no def-side consumer today**. Adding
  an `operator.interaction.*` block (or a free-text operator-briefing overlay) now would
  ship dead config, violating the seam-only-genuinely-consumed-values rule. Deferred to a
  future issue that lands the consuming def surface alongside the key.
- **Repo-specific tool surface — out of scope of this seam.** The target repo's tool
  surface (a flags CLI, a main-sync tool) is **target-REPO config, not operator config**,
  and belongs to a separate repo-config seam (the repository-resolution rule: honor the repository override when set, otherwise derive the current working repository repo-as-config surface), not
  `crew.config`. It is intentionally absent here.

## Stand-up

```bash
# 1. Copy the placeholder-only template to your operator-owned config (default path).
cp .claude/crew.config.template.jsonc .claude/crew.config.jsonc
#    (or keep it anywhere and point $CREW_CONFIG at it).

# 2. Fill EVERY <placeholder> with your own people and machine. Leave no <...> behind.

# 3. Ensure the config is git-ignored in your working repo — it holds your operator
#    data and must never be committed into a shared tree.
echo ".claude/crew.config.jsonc" >> .gitignore
```

### The one stand-up command

Once the config is filled, boot the whole crew from it in **one command** — `/stand-up`
(the plugin's thin [`commands/stand-up.md`](commands/stand-up.md)), which invokes the
`@kampus/pipeline-crew-mcp` substrate's `stand-up` subcommand (the launcher rule: commands stay thin and delegate launcher mechanics to the tested crew service):

```bash
.pipeline/toolkit/bin/pipeline crew stand-up            # defaults --project-root to the working directory
```

It resolves the config through the **same** `$CREW_CONFIG` → `.claude/crew.config.jsonc`
order as every seam key, asserts the pinned CLI version, ensures the tracker, derives the
roster session set (one per bridge + N engines from the `roles` map), and launches every
session bound to its role lease — **fail-loud with no partial crew**: a missing or malformed
launch dimension aborts the launch naming that dimension, before any session starts.

This doc owns the **seam** — the config mechanism and the dimension contract. The full
stand-up walkthrough and the crew topology (intake → execution → human) are the
pipeline-crew **README**'s scope.
