# Which skills belong in the payload

Decided 2026-08-08, closing [#41](https://github.com/hueypov/kampus-pipeline/issues/41).

All 23 skills under `skills/` shipped when this was decided; 22 do now. `pipeline init` installs
every one of them into an adopting repository, so each is a routing surface in somebody else's
project whether or not anyone here uses it. That is the reason this decision exists and the reason it is not "leave it, it's harmless".

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

**Reachability is a real discriminator, and it overturned two verdicts** — `wayfinder`'s before the
fact, and `architecture-audit`'s after it (see the retraction below). `wayfinder` was set for
deletion on a grep that found one inbound reference, which read as noise. It is not noise: the
`pipeline-crew` plugin ships a dedicated `crew-cartographer` agent whose stated behaviour *is* the
wayfinder skill, and the `wayfinder-map` CLI verb exists with its own parse/validate core and tests.
That is deliberate wiring across three layers, and the test says keep. It is recorded here because
the near-miss is the argument for having a test at all — reading the skill would not have surfaced
any of it.

## Deleted — one

**`what-shipped`** (237 lines). A stakeholder "what did we ship" readout. Same class as `release`
and `campaign`, which are already gone: it is a reporting product, not pipeline machinery. One
inbound reference, no agent, and the mechanical half it needs already exists as the `ship-digest`
verb — so what goes is the narration around a verb that stays.

That verb now has no skill invoking it, and `gh-issue-intake-formats.md` still carries a section
explaining that "`ship-digest` is the consumer" of category metadata for a readout nothing produces.
Reversible on request; recorded here so the loose end is visible rather than discovered later.

## Retracted — `architecture-audit` was deleted on a measurement error

It was deleted, and it should not have been. The verdict rested on a reachability claim that was
false, produced by measuring the deletions and the keeps with **two different greps**: a
`skills/<name>` path form for the deletions, and a `` `<name>` `` backtick form for the keeps.

The exact words that error produced, at commit `34d06d7`, were *"nothing routes to it — no agent, no
crew role, no stage"* for `architecture-audit`, and *"Zero inbound references"* for `what-shipped`.
Both were written with the broken measurement in hand.

*(An earlier revision of this retraction quoted a sentence — "every skill deleted has zero inbound
references" — that appears nowhere in the original. It was a paraphrase presented as a quotation.
Corrected here, and noted rather than silently fixed, because inventing a citation inside a document
about a measurement error is the same failure wearing different clothes.)*

Measured consistently at the commit before the deletion:

| Skill | Referencing files | Verdict given |
|---|---|---|
| `architecture-audit` | **3** — `agents/canon.md`, `canon/SKILL.md`, `glossary/SKILL.md` | deleted |
| `glossary` | 2 | kept |
| `doctor` | 1 | kept |
| `author-skill` | **0** | kept |

It had more inbound references than anything kept on "general and directly invoked" grounds, and
`author-skill` — kept on exactly those grounds — had none. Against the three tests it fails nothing:
the job is general, three files route to it, and it names artifacts any repository has.

`canon` and `glossary` maintain a repository's own decisions and patterns. Both define their scope
*against* an architecture audit, which is a different job — that distinction is the reason those
references exist, and collapsing all three into `report` erased a real boundary.

## Why the two queries disagreed — measured, not assumed

Neither form is broken. They see **different citation styles**, and those styles are not evenly
distributed. Referencing files at `34d06d7^`, same exclusion, both forms:

| Skill | `skills/<name>` | `` `<name>` `` |
|---|---|---|
| `write-code` | 3 | 17 |
| `report` | 2 | 16 |
| `ship-it` | 5 | 11 |
| `adr` | 1 | 4 |
| **`architecture-audit`** | **0** | **3** |
| `heal-ci` | 0 | 3 |
| `glossary` | 0 | 2 |
| `doctor` | 0 | 1 |

The path form catches cross-references written as **file paths**, which is how pipeline *stages* cite
each other. Ambient skills are cited in **prose, by name** — so the path form reads zero for nearly
every one of them, `architecture-audit` included. Measuring the deletion candidates with the blind
form and the keeps with the seeing one did not merely risk the wrong answer. It guaranteed it.

The skill and all four pointers are restored.

## The rule this produces

**Never compare counts produced by different queries.** The error was the *comparison*, not either
query. Each was locally sensible, and the path form is genuinely non-zero for `ship-it`, `report`,
and `write-code` — so it does not look broken when you spot-check it.

That last fact also kills the weaker rule an earlier revision of this section proposed: *"check the
query returns non-zero for something you intend to keep."* The path form **passes** that check —
`ship-it` returns 5 — and still reads zero for `architecture-audit`. A sanity check that the broken
measurement survives is not a check. What is needed is that the query can see the citation style the
candidates actually use, and the only way to know that is to measure a candidate whose answer you
already know.

**And never let a verdict's cleanup run before the verdict is re-checked.** The three references were
rewritten to point at `report` while repairing dangling pointers, so the evidence contradicting the
verdict was edited away by the same change that acted on it.

## Kept — sixteen (fifteen below, plus `architecture-audit` — see the retraction)

**Agent-reachable, so reachable by construction:** `adr`, `canon`, the four review gates the
`reviewer` agent lists (`review-design`, `review-doc`, `review-plan`, `review-skill`), and
`wayfinder` via the crew's `crew-cartographer`.

`wayfinder` is kept as a **stated exception, not a pass.** At 571 lines it is the largest of the
skills judged here, and it keys on a `wayfinder:map` label a fresh adopter does not have — so it
**fails Grounded**, and the rule above says one failure is enough to delete it.

It is kept anyway because Reachable holds unusually strongly: the `pipeline-crew` plugin ships a
`crew-cartographer` agent whose stated behaviour *is* this skill, and `wayfinder-map` is a CLI verb
with its own tested parse/validate core. Deleting a skill that two other layers were deliberately
built to call would break them.

Naming this as an exception rather than arguing it into a pass is deliberate. An earlier revision of
this section claimed `doctor` "treats that label as a Tier-3 optional and reports its absence", which
would have satisfied Grounded — and that was false. It is true of the **upstream phoenix plugin's**
doctor, which was read by mistake; this repository's `doctor/SKILL.md` contains no tier taxonomy and
never mentions `wayfinder:map`. Reading the installed upstream copy as if it were the payload is the
same confusion that produced #36.

What would resolve the exception: `doctor` gaining that check, so an adopting repository is told the
label is missing instead of `wayfinder` matching nothing and reporting it as normal. Until then this
entry is a debt, and revisiting it is warranted if the cartographer role is ever retired.

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
- **Twelve** skills are over the 140-line band at this commit — `review-doc` 958, `review-skill` 827,
  `review-design` 768, `wayfinder` 571, `review-plan` 480, `heal-ci` 391, `review-trivial` 326,
  `architecture-audit` 284, `canon` 277, `glossary` 198, `triage` 176, `write-code` 152. Being
  oversized is a rewrite cost, not a deletion reason, and it is most of what is left after this.

  Two of them — `triage` and `write-code` — are stages this project already rewrote, so the band is a
  target the rewrites themselves have not always hit. And an earlier revision of this line said
  eleven, having counted in a tree that did not yet contain `architecture-audit`: the skill this very
  change restores. Counting the payload from a checkout that is not the payload is the same mistake
  as reading the upstream plugin's `doctor` as if it were ours, two sections above.
- Fixed here: `doctor`'s routing description called this "the private, project-local kampus
  pipeline toolkit" — org branding in the first surface an adopter reads. Also fixed the pointers
  in `canon`, `glossary`, and the formats contract that named the two deleted skills as live routes.

## The rule, restated for the next skill

Before adding one, name what routes to it and what it operates on in the adopter's repository. If
either answer is "nothing yet", it is not a skill — it is a plan for one.
