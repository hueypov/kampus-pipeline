# Which skills belong in the payload

Decided 2026-08-08, closing [#41](https://github.com/hueypov/kampus-pipeline/issues/41).

All 23 skills under `skills/` ship. `pipeline init` installs every one of them into an adopting
repository, so each is a routing surface in somebody else's project whether or not anyone here
uses it. That is the reason this decision exists and the reason it is not "leave it, it's harmless".

Three skills — `campaign`, `release`, `rite-audit` — were deleted rather than rewritten, on a
judgment made case by case with no stated rule. This records the rule, applies it to the rest, and
leaves a test a future skill can be judged by.

## The test

A skill belongs in the payload only if it passes **all three**. Failing one is enough to delete it.

1. **General.** The job it does exists in any repository that adopts the pipeline. Not "could be
   adapted to" — *exists*, unmodified.
2. **Reachable.** Something routes to it: an installed agent lists it in `CORE_AGENT_SKILL_NAMES`, a
   pipeline stage cites it, or a person invokes it by name for a recurring job.
3. **Grounded.** It can name what it operates on in terms the adopter already has. A skill keyed on
   a label, file, or concept the adopter has never heard of does not fail loudly — it fails by
   matching nothing, which is the silent-no-op class the whole toolkit is built to refuse.

**Prose damage is not one of the tests, and deliberately so.** The extraction damage is a repair
cost; it says nothing about whether a thing should exist. Deciding by damage would delete the worst
copy of something load-bearing and keep an intact copy of something nobody needs.

## What the evidence said

Two things came out of measuring rather than reading, and both changed the answer.

**The damage is not spread across seventeen skills. It is concentrated in the review family and the
one contract they all cite.**

| | placeholders |
|---|---|
| `gh-issue-intake-formats.md` — the shared formats contract | **197** |
| the five `review-*` gates (excl. `review-code`) | 63, 63, 48, 27, 16 |
| the installed agent definitions, `reviewer` worst at 15 | 28 total |
| every other skill combined | 14 |

Issue #39 was filed on the premise that roughly seventeen skills carry the extraction's prose. They
do not. The ambient skills are largely intact and mostly just **oversized**.

The first row is the finding, and it was nearly missed: measuring only `SKILL.md` files put the
review gates on top and made the answer look like "rewrite five skills". The largest single
concentration is not a skill at all — it is the support file every stage cites, and it holds more
damage than all five gates but one. Rewriting the gates without it would leave five fresh skills
pointing into 197 unanchored references.

So `gh-issue-intake-formats.md` is part of the review-family unit of work, not a separate item after
it. Thirty-two link targets with spaces in them survive across eight files, and they travel with the
same repair.

**Reachability is a real discriminator, and it overturned a verdict.** `wayfinder` was set for
deletion on a grep that found one inbound reference, which read as noise. It is not noise: the
`pipeline-crew` plugin ships a dedicated `crew-cartographer` agent whose stated behaviour *is* the
wayfinder skill, and the `wayfinder-map` CLI verb exists with its own parse/validate core and tests.
That is deliberate wiring across three layers, and the test says keep. It is recorded here because
the near-miss is the argument for having a test at all — reading the skill would not have surfaced
any of it.

## Deleted — two

**`what-shipped`** (237 lines). A stakeholder "what did we ship" readout. Same class as `release`
and `campaign`, which are already gone: it is a reporting product, not pipeline machinery. Zero
inbound references, no agent, and the mechanical half it needs already exists as the `ship-digest`
verb — so what goes is the narration around a verb that stays.

**`architecture-audit`** (284 lines). Walks a codebase and files an issue per "deepening
opportunity". General on its face, and deleted on the other two tests: nothing routes to it — no
agent, no crew role, no stage — and `report` already files issues. An unbounded finding generator
also sits against the intake rule that every issue must move something forward. A skill whose output
triage exists to reject is not one to ship.

## Kept — fifteen

**Agent-reachable, so reachable by construction:** `adr`, `canon`, the four review gates the
`reviewer` agent lists (`review-design`, `review-doc`, `review-plan`, `review-skill`), and
`wayfinder` via the crew's `crew-cartographer`.

`wayfinder` is the one kept against its own reading. At 571 lines it is the largest skill here, it
keys on a `wayfinder:map` label a fresh adopter does not have, and it is the sole dependant of
[#6](https://github.com/hueypov/kampus-pipeline/issues/6), an unbuilt CLI it has waited on since
July. Grounded is satisfied only because `doctor` already treats that label as a Tier-3 optional and
reports its absence rather than matching nothing — which is the toolkit handling the case correctly,
not the skill. It stays because two other layers were built to call it; revisit if the cartographer
role is ever retired.

**General and directly invoked:** `author-skill` (the method these rewrites follow — 133 lines, no
damage), `doctor` (adopter preflight, 30 lines), `glossary` (a vocabulary register any repo can
have), and the three writing-craft skills `deslop-comments` / `diataxis` /
`writing-clearly-and-concisely`, all in band with one or two placeholders each.

**`heal-ci`** (391 lines) is kept on a change of facts rather than on its own merits. It classifies a
red CI run into flake-vs-defect, and until today this repository had no CI at all, so it was
unreachable in practice. [#26](https://github.com/hueypov/kampus-pipeline/issues/26) landed a build
signal; it is reachable now for the first time. Reconsider if it is still unused once there is a red
run to point it at.

**`review-trivial`** (326 lines) is kept for the same kind of reason: the `reviewer` agent does not
list it, which would fail reachability — but the `trivial-diff classify` verb it needs already exists
and is tested. That is a wiring gap, not a dead skill. Rewriting it belongs with the other gates.

## What follows

- The review repair is **seven files, not five**: the five gates, plus
  `gh-issue-intake-formats.md` (the largest concentration of damage anywhere), plus
  `agents/reviewer.md` ([#40](https://github.com/hueypov/kampus-pipeline/issues/40)). `reviewer`
  should also list `review-trivial`.
- Six kept skills are over the 140-line band — `canon`, `glossary`, `heal-ci`, and the gates. Being
  oversized is a rewrite cost, not a deletion reason, and it is the only thing left after this.
- Fixed here: `doctor`'s routing description called this "the private, project-local kampus
  pipeline toolkit" — org branding in the first surface an adopter reads. Also fixed the pointers
  in `canon`, `glossary`, and the formats contract that named the two deleted skills as live routes.

## The rule, restated for the next skill

Before adding one, name what routes to it and what it operates on in the adopter's repository. If
either answer is "nothing yet", it is not a skill — it is a plan for one.
