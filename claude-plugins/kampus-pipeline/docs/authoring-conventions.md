# Authoring conventions

The discipline every skill in this plugin meets, and the format of the contract it ships with.

## The two references, and what each is for

**kamp.us fabrika (`claude-plugins/fabrika/` in kamp-us/phoenix) is the method.** Its
`docs/skill-conventions.md` and `docs/cli-interface-convention.md` define the two-layer split, the
sizing band, the invocation-axis economics, and the contract-spec format this document adapts. When
a question here is unanswered, that is where to look.

**kamp.us v1 (`claude-plugins/kampus-pipeline/` in kamp-us/phoenix) is a frozen baseline to compare
against — never a source to port from.** It is useful for one thing: seeing which incidents a rule
was hardened against. A spec clause that says "same as the v1 script" has derived nothing, and a
skill that reproduces v1's prose inherits its problems.

This repo's own extracted v1 prose is a third category: **not a reference at all.** The extraction
collapsed ~400 distinct citations into two generic phrases and broke 71 markdown links, so its
skill text cannot be cited as authority for any rule.

## 1. The two-layer split

Every skill splits in two. Deterministic work is pushed **maximally** into CLI verbs; the skill is a
thin wrapper handing the model those verbs and carrying **only the judgment the deterministic layer
cannot**.

The test while authoring: for each instruction in the draft, ask whether a verb could decide it. If
yes, it does not belong in the skill — derive the verb.

v1 is the counter-example this exists to escape: its deterministic layer was shell scripts, and this
repo's extraction of it deleted 243 of them.

## 2. Sizing — the thin wrapper

**7–140 lines, median ~75.** A `SKILL.md` past the band is not thorough, it is un-split: the
overflow is deterministic content that should have become a verb, or reference that should have
moved behind a pointer.

The classification stage is the known exception — `triage` runs ~155 here and ~160 in fabrika,
because the type table and its boundary tests are the most-used decision surface in the skill and
putting them behind a pointer means opening another file mid-classification.

## 3. Invocation-axis economics

**Model-invoked** keeps the `description`, so the model can fire the skill unprompted and other
skills can reach it — and pays a context cost on every turn, forever.

**User-invoked** strips the description: zero context cost, but only a human typing its name can
reach it. The cost moves to the human as something they must remember.

Choose model-invoked **only when the model must reach the skill unprompted.** When user-invoked
skills multiply past what a person can hold, the cure is a router skill naming the others — not
descriptions bolted back on.

## 4. Author skill-first, not CLI-first

Name the verb the skill *should* have, and specify it in `contract.md`. **Do not cap a skill at what
`pipeline-cli` implements today.** A skill written against the existing CLI inherits whatever the
CLI happens to contain; a skill written against the interface it needs produces a build queue.

A skill may therefore name verbs that do not exist yet. That is expected, not a defect.

## 5. The contract spec

`contract.md` sits beside the `SKILL.md` it serves and is **the derived CLI contract**: the verbs
that skill needs, fully specified.

**The bar:** a fresh implementing agent builds every verb in the spec without reading the authoring
session, without asking a question, and without opening a v1 script.

### Required sections

**Header** — the skill it serves, and the date. Nothing else.

**Verb inventory** — one row per verb: name, one-line purpose, and **the split test that put it
there** (what makes this deterministic rather than judgment the wrapper keeps). A row that cannot
state that test describes something that belongs in the skill.

**Per verb, in this order:**

| Section | Content |
|---|---|
| Invocation | the literal command string, with subcommands |
| Inputs | one row per flag: name, type, required, default, and the description that becomes its help text verbatim |
| Output | the channel, the exact shape, and what an empty answer means |
| Exit status | every code the verb returns and its trigger |
| Errors | one row per named failure: message, stream, exit code, and whether it is a refusal or a usage error |
| Scope | for a judging verb: what it scans, and what zero scope does |
| Examples | at least one literal invocation with its expected stdout |
| Grounding | the incident or reasoning the behavior encodes — one line each |

### Completeness test

Checkable by reading the spec alone, which is the point — an implementer can tell an unfinished spec
from a finished one before starting.

1. Every flag has a type and, if optional, a default.
2. Every stdout shape is **shown by an example**, not only described.
3. Every non-zero exit code is enumerated with the condition that produces it.
4. Every error names its message, its stream, and its code.
5. Every judging verb states its scope and its zero-scope behavior.
6. **No clause defers** to a v1 script, another skill's prose, or the authoring session. The spec
   *is* the contract; one that points elsewhere has not derived one.

## 6. Exit codes come from one table

Every verb allocates from `packages/pipeline-cli/src/exit-codes.ts`. A code means the same thing
whichever verb produced it, so a caller driving several stages in one sweep can branch on the number
without first knowing which verb it came from.

Before that table existed, `3` meant "backed off", "nothing pickable" and "the check did not
discriminate" depending on the caller, and `5` meant three more things — the same proven-versus-
unknown collapse the verbs were written to remove, reintroduced at the level of the exit code.

`0`, `1` and `2` are reserved by the interface. Everything from `3` up is a fact the verb **proved**.
The distinctions that look redundant are the ones carrying the design — proven-absent versus
could-not-read, a check that matched nothing versus one that could not discriminate, a write whose
outcome is unknown versus a plain failure, a reviewer's FAIL versus a red build.

A contract's exit table is a **view** of that module, never a second source. When they disagree, the
module is right and the contract is stale.

## 7. Evals

`claude-plugins/kampus-pipeline/evals/<skill>/evals.json` grades the **judgment layer** — what the
SKILL.md carries — not the verbs.

**Never put a set inside the skill directory** (ADR 0001). Installing a skill is linking its
directory, so a set inside one is installed with it, and a graded run handed the skill can read the
assertions it is about to be graded against — measured: a spawned run read one unprompted. The
separation is enforced, not asked for: `evals-placement.test.ts` fails on any `evals.json` reachable
from the skill tree, including a symlinked one.

Three rules, the first structural and the other two learned the hard way:

**An eval must separate the arms.** A repo whose ambient guidance already states the behavior would
satisfy a naive assertion in both arms, grading the repo instead of the skill. Read each assertion
against that ambient paragraph alone: if a run that read only the paragraph could satisfy it,
re-aim it at a surface only the SKILL.md carries. Rewording is not re-aiming.

**A prompt must describe something the run cannot falsify against the repo.** A prompt asserting a
defect that is demonstrably absent sends a diligent run to verify, find nothing, and correctly
decline — measuring verification diligence instead of the behavior under test.

An invariant only fails under pressure, so a prompt should supply a sympathetic reason to break the
rule, not a neutral one.

## 8. Frontmatter, enforced

`validate-skills.sh` fails the build unless every `skills/*/SKILL.md` opens with a `---` fence on
line 1, carries a non-empty `name` matching its directory, and carries a non-empty `description`.

The description is not a summary — it is the routing surface. Write it as concrete trigger
conditions and a "done when".
