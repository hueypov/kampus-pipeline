# The gate-verdict contract

One spec, four gate namespaces. Every review skill emits a verdict against it, and `ship-it` reads
one to decide whether a PR may merge. It is the only channel between the agent that judges work and
the agent that lands it, so an ambiguity here is a merge decision made on a misread.

This document is the **semantics**. The grammar — marker composition, the SHA binding, the matcher,
the upsert, the read-back — belongs to `pipeline cli verdict` and is not restated here. Nothing
hand-composes a marker.

## The four namespaces

| Gate | Namespace | Judges |
|---|---|---|
| code | `review-code` | source changes, against the linked issue's acceptance criteria |
| doc | `review-doc` | prose and knowledge surfaces |
| skill | `review-skill` | behavioral artifacts under `skills/**` and `agents/**` |
| design | `review-design` | rendered UI surfaces |

Which namespaces a PR *requires* is decided by the changed-path classifier, not by the reviewer and
not by the shipper. A PR touching two classes needs a current-head PASS in both.

## What a verdict is

**A verdict binds to a commit, not to a pull request.** It states that *this reviewer read
*this* diff at *this* head and reached this conclusion. A PASS says nothing about any other commit,
including the one that follows it.

That single property produces every rule below.

**V1 — Latest-wins per namespace.** The verdict that counts is the most recent one in that
namespace, never the presence of a historical PASS nor the absence of a FAIL. A newer FAIL vetoes an
older PASS.

**V2 — A verdict bound to a stale head is not a verdict.** When the head moves, every prior verdict
describes code that is no longer under review. The gate must be re-run; treating a stale PASS as
current is how unreviewed code merges while everyone reads green.

**V3 — One verdict per gate per head.** A gate's record is upserted, not appended. Two live markers
in one namespace mean the shipper has to choose, and choosing is what this contract exists to
prevent.

**V4 — Absence is not a pass.** No marker means unreviewed. A red or pending check is a "not yet",
never a "fail you may override". A gate that cannot read its scope fails closed.

**V5 — The author never writes the verdict on their own work.** Not the marker, not an approval.
This is the split-role firewall, and it holds through repair: the author may fix a FAIL, but an
independent re-review re-grades it. A shipper that accepts a self-issued PASS has no gate at all.

V5 is enforced on **both** sides, and the read side is the one that makes it hold. `post` refuses an
author posting on their own PR (exit 10), and `read` — which `ship-it` resolves every gate through —
drops the author's own markers and resolves `self-verdict`, which no polarity satisfies. That
redundancy is not belt-and-braces: an emit-only guard is enforced by whoever remembers to route
through the guarded verb, and for a while nobody did. The shipped reviewer agent card instructed a
bare `gh api` comment, so the firewall was correct, fail-closed, and never reached — live PRs
accumulated self-issued PASS verdicts that read as gate-satisfying (#135). A marker the *reader*
refuses to count has no bypass left to document.

**V6 — FAIL carries its reasons.** A FAIL names the specific findings that produced it, each
verifiable against the diff. A verdict whose reasons cannot be checked cannot be repaired against,
and the repair loop degrades into guessing.

**V7 — A verdict is proven landed, not assumed.** After posting, the marker is re-read from the PR's
own state. A post that reported success but landed nothing — or landed malformed — is a false green
nobody notices until a merge happens on it.

## What V5 closes, and what it does not

V5's read-side enforcement is one link in a four-link loop, and the other three are live. Stating
them here keeps whoever sequences the remaining fixes from reading a closed link as a closed loop:

1. **Self-issued verdicts** — closed by V5 above. A self-PASS resolves `self-verdict` and refuses.
2. **`ship-it check` reporting `mergeable ok` on a BLOCKED PR** (#99) — still open. The verdict
   gate refusing does not stop a shipper that trusts a mergeability report over it.
3. **An empty control-plane path set** (#134) — still open. A change to the gate's own definitions
   classifies as `ordinary` and draws no elevated approval, so this contract can be edited under
   the same authority it grants.
4. **Branch protection that does not enforce for admins** — still open, and outside this contract.
   An admin merge is available regardless of any refusal above.

Together those still compose a path from "an agent judges its own work" to "it lands", so V5 is a
necessary link and not a sufficient one. A verdict gate is not a merge policy.

## The verbs

```bash
pipeline cli verdict post  --pr 412 --gate code            # body on stdin
pipeline cli verdict read  --pr 412 --gate code --expect PASS
pipeline cli verdict validate --gate code                  # body on stdin
```

- **`post`** composes the marker from the judgment you supply, binds it to the current head, upserts
  it (V3), and reads it back (V7). You supply the prose and the polarity; it supplies the grammar.
- **`read`** resolves the latest verdict in a namespace against the PR's *current* head and exits 0
  only when it is present and matches `--expect`. That exit code is V1, V2 and V4 in one call: a
  stale marker, a missing one, and an opposite-polarity one are all non-zero.
- **`validate`** checks a composed body is postable before it reaches the PR. Useful when a body is
  assembled by something other than the reviewer that will post it.

`--head` overrides the binding for tests and for the rare orchestrated path that already resolved
the head. Passing it to work around a staleness refusal defeats V2; do not.

## What remains judgment

The verbs enforce shape. They cannot decide:

- whether an acceptance criterion is actually met
- whether a finding is real or a hunch that will waste a repair round
- whether a diff's convention drift is worth failing over
- whether the gate you are running is the gate this PR needs

Those are the reviewer's, and they are why a gate is an agent rather than a script.

## For a reviewer that is not this pipeline

A verdict may be posted by any identity with write access — a different account, a different model,
a different harness. The contract does not care who judges, only that the judgment is bound to a
head, sits in the right namespace, and does not come from the author (V5).

Such a reviewer must go through `verdict post` or reproduce its output exactly. Reproducing it is
the harder path and gains nothing: an approximately-correct marker reads as absent (V4), and absent
means unreviewed, so a reviewer that hand-composes its own marker most often discovers the mistake
when a merge silently never happens.
