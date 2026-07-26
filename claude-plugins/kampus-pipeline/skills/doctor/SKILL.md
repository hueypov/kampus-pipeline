---
name: doctor
description: Check that a repository is ready to use the private, project-local kampus pipeline toolkit. Use for "doctor", "preflight", "check pipeline prerequisites", or "verify pipeline setup".
---

# doctor

Run the toolkit's read-only portable-core preflight from an adopting repository:

```bash
pnpm pipeline init --check
```

It validates the Git project root, initialized `.pipeline/toolkit` submodule,
required Node and pnpm versions, and every managed portable-core path, hook, and
package script recorded by `pipeline init`.

It does not require GitHub authentication, tmux, a crew configuration, or
user-level Claude settings merely to validate the local bootstrap. Before an
agent runs a GitHub workflow, verify its current credentials and target with:

```bash
gh auth status
gh repo view --json nameWithOwner -q .nameWithOwner
```

Run any enabled optional integration's documented preflight separately.

Report the command output exactly. Do not run fix commands, alter tracker state,
or install global packages on the operator's behalf.
