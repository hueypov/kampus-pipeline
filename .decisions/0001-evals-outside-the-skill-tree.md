---
id: 0001
title: Eval sets live outside the skill tree, never inside it
status: accepted
date: 2026-08-08
tags: [evals, payload, skills]
---

# 0001 — Eval sets live outside the skill tree, never inside it

**What this decides:** A skill's eval cases move out of `skills/<name>/evals/` into a separate `evals/<name>/` tree, so that installing or staging a skill can never also hand over the assertions its behaviour is about to be graded against.

## Context

Each skill's eval set sits at `skills/<name>/evals/evals.json` — a subdirectory *of the skill*. Five sets, 30 cases, 142 assertions, each case carrying its assertions and an `expected_output` paragraph.

Two measurements made this a decision rather than a tidying preference.

**A spawned run read its own answer key, unprompted.** Running slice 0 of the eval-runner design — four headless `claude -p` spawns of `report`'s eval case 1 — one arm oriented itself with `ls` and `find`, walked the staged tree, and read `SKILL.md`, `contract.md`, the shared intake formats, and then `skills/report/evals/evals.json`. Nothing suggested it; that is simply what reading the directory you were handed looks like.

**Every adopting repository already receives all five sets.** `pipeline init` links each core skill as `.claude/skills/<name> -> …/toolkit/claude-plugins/kampus-pipeline/skills/<name>`. The link is to the skill *directory*, so `evals/` resolves through it. Measured on a freshly initialised tree:

```
$ ls .claude/skills/report/
SKILL.md  contract.md  evals  footer.sh
$ head -c 60 .claude/skills/report/evals/evals.json
{ "skill_name": "report", "notes": "Grades the JUDGMENT layer …
```

That second fact is the one that decides between the candidate fixes. The exposure is not a property of a sandbox a future runner might build — it is already live in every repository that has run `init`, including this one since #68. And because the with-arm of a two-arm eval *installs the skill*, the arm where answer-key access matters most is exactly the arm that gets it.

There is no corrupted result to repair: nothing mechanical runs these cases today. `evals lint` reads them statically, and a static reader is not a subject. This is a constraint being fixed before the first runner exists, which is the cheap moment to fix it.

## Decision

**A skill's eval set is not part of the skill. It lives at `claude-plugins/kampus-pipeline/evals/<skill>/evals.json`, and nothing under `skills/**` may contain an `evals.json`.**

The alternatives were rejected on the same ground. *Keep the sets in place and have the runner stage a filtered copy of the skill* fixes only the sandbox and leaves every adopter's installed copy readable; it also makes the property depend on each future consumer remembering to filter. *Keep them in place and exclude `evals/` from the payload* fixes the adopter and leaves a runner staging from the source tree exposed, and needs two mechanisms to state one rule.

Relocation is the only option under which the property holds **by construction at the surface it addresses**: a directory that is not inside the skill cannot be installed by linking the skill, cannot be staged by copying the skill, and cannot be reached by a run that was handed the skill. This repository's standing preference is to push an invariant into structure rather than into prose that every consumer must re-obey, and that is the whole of the reasoning here.

The scoping matters, and the claim is deliberately narrower than "an adopter no longer has the sets on disk". `assertToolkit` requires `.pipeline/toolkit` to be a full toolkit checkout including `claude-plugins/kampus-pipeline`, so after relocation an adopter's tree still contains every set at `.pipeline/toolkit/claude-plugins/kampus-pipeline/evals/<skill>/`, and a run orienting itself with `find` from the repository root would still reach one. That residue is shared by every candidate — no rejected option removes it either — so it does not change which option wins, but it does bound what winning means. What relocation removes is the **skill-link surface**: the copy a with-arm inherits automatically, without anyone choosing to include it, purely because installing a skill is linking its directory.

The two surfaces differ in who controls them. The skill-link surface is inherited by construction, which is why it has to be closed structurally. The toolkit-pin surface exists only where a full toolkit checkout is present — which a runner's sandbox need not have, and did not have in the probe that surfaced this — so it is a constraint the runner can satisfy by building its sandbox rather than a hazard it inherits. Grading happens in a sandbox the runner builds, never in the repository the runner was launched from, so a copy sitting under the pin is payload hygiene rather than eval integrity. That holds under self-hosting too, where this repository is simultaneously the toolkit and an adopter of it: the pinned copy here is no more reachable from a sandbox than any other adopter's.

The colocation being given up is real but small. An author editing a skill no longer sees its cases in the same directory; `evals lint <skill>` already resolves the path on the author's behalf, and the `grounding` fields cite contract IDs (`contract.md R8`), not paths, so they survive the move untouched.

**Binding constraints.**
- `evals lint` and every later eval consumer resolve sets under `evals/<skill>/`, never under `skills/**`.
- A guard refuses any `evals.json` found under `skills/**`, so the property cannot silently regress.
- A skill's payload entry links the skill directory; nothing that a graded run must not read may be placed inside one.

**Banned.**
- Staging, linking, or copying a skill directory that contains its own eval set.
- Treating "the runner will filter it out" as sufficient for a file that ships to adopters.

## Consequences

Easier: an eval runner can stage a skill by linking its directory with no filtering step and no denylist to maintain; the adopter payload stops carrying test fixtures adopters have no use for.

Harder: authoring loses directory-level colocation, and five files plus one path constant in `packages/pipeline-cli/src/tools/evals/command.ts` have to move together with the guard that pins the result. Existing `evals lint` invocations are unaffected — they take a skill name, not a path.

**Not addressed here.** Three things this decision deliberately leaves open:

- **The toolkit-pin residue.** A sanctioned install carries a full toolkit checkout, so the sets remain on disk in an adopter's tree at `.pipeline/toolkit/…/evals/<skill>/`. Closing that means changing what a pin contains, which is a separate question about payload composition.
- **A runner's sandbox must not contain a toolkit checkout.** This follows from the point above and is a constraint on the runner, not on the layout.
- **The without-arm reads the skill's prose.** Staging a skill's `SKILL.md` into a baseline arm lets the run read and follow it, which collapses arm separation independently of where the eval set lives. Both without-arms in the probe did exactly that and produced correctly-structured output, so an assertion like "composes the six sections" separates nothing. That is a runner-design constraint and belongs with the runner.

## Records

Closes #82. Implementation — the five file moves, the path constant, and the guard that refuses an `evals.json` under `skills/**` — is tracked in #87; this ADR records the decision only and stays purely additive.

**No vocabulary impact.** This re-decides file placement over concepts already named in the repository — eval set, skill, payload, arm. It coins nothing and redefines nothing, so no `.glossary/TERMS.md` row is added. (`TERMS.md` currently carries no eval vocabulary at all; naming those terms is a separate piece of work, not a side effect of this decision.)
