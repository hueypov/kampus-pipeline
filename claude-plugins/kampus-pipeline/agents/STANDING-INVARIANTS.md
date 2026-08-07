# Standing invariants — the shared block

A few entries in an agent definition's `## Standing invariants` section are **byte-identical**
across two or more definitions. Those live here once instead of being re-carried per file.

Each definition keeps the rule **named at the position its full text occupied**, and cites the entry
here for the detail. That placement is load-bearing: these are rules an agent must *apply* at a
specific moment, not background it must merely know, so the cite has to fire where the paragraph
used to.

**Scope: the `kampus-pipeline` agent definitions only.** Nothing here is a cross-plugin dependency.

<a id="sp"></a>

## §SP — the per-run scratch namespace

**Every intermediate file you write lives under a per-run scratch namespace.** Never stash state at
a fixed or work-item-keyed path (`prref.txt`, `/tmp/verdict-$PR.md`), and never in the harness's own
scratch directory — that one is session-scoped and **shared across a session's concurrent runs**, so
a generic leaf name gets clobbered mid-run and **reads back another run's content with no error**.
Silent, and precisely the failure that routes one reviewer's `git diff` at another PR's files and
writes one reviewer's verdict body over another's.

Prefer passing the value in-process and writing no file at all. When a file is genuinely needed,
allocate the namespace and name every leaf under it:

```bash
RUN_SCRATCH="$(pipeline cli scratchpad open --slug <skill>-<work-item>)" || exit 1
```

In every **later** Bash call, re-derive it — your shell state does not survive between calls, so
nothing you set carries over:

```bash
RUN_SCRATCH="$(pipeline cli scratchpad path --slug <same-slug>)" || exit 1
```

`open` resets the namespace; `path` never does, which is why the second half of any two-call
sequence uses `path`. The verb is fail-closed: a missing session id, a namespace another run owns,
and one this run never opened are each a distinct non-zero exit, never a fallback to a shared path.

Never park the path in another file to carry it across — that just moves the collision onto that
file. Never print the path into a shared artifact; an issue body or a PR comment carrying a scratch
path leaks the machine's layout.

<a id="tracker"></a>

## §TRACKER — the work-tracker access path

**Every read and write against the work tracker goes through the `tracker` and `verdict` verbs**,
never a hand-rolled API call. The verbs carry the guards — the claim protocol, the SHA binding, the
one-verdict-per-gate upsert, the post-write read-back — and a call that goes around them is a call
with none of them.

This is also what keeps the pipeline portable: the verbs speak in domain terms (a target, a stage, a
gate) so no backend's addressing leaks into an agent's instructions. An agent that reaches for the
provider's API directly has hardcoded that provider for everyone.

<a id="root"></a>

## §ROOT — the working directory

**Work from the repo root**, not a nested app or package directory. Paths in every shared artifact
are repo-relative, and they are only reproducible if the run that wrote them started where they are
rooted.
