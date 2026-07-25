---
name: doctor
description: Check that a repository is ready to use the private, project-local kampus pipeline toolkit. Use for "doctor", "preflight", "check pipeline prerequisites", "verify pipeline setup", or "/doctor".
---

# doctor

Run the toolkit's read-only preflight from the adopting repository root:

```bash
pnpm pipeline init --check
```

This validates the Git project root, initialized `.pipeline/toolkit` submodule,
Node, pnpm, the local `pipeline-cli` and `pipeline-crew-mcp` packages, Claude
Code, GitHub CLI authentication, tmux, and the crew configuration template.

If the crew is configured, also validate the real operator config before
starting sessions:

```bash
pnpm pipeline crew check-config
```

Report the command output exactly. Do not run fix commands, add labels, change
GitHub configuration, or install registry packages on the operator's behalf.
