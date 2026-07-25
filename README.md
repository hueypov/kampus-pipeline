# kampus-pipeline

Private, project-local pipeline tooling. This repository is consumed as a Git
submodule at `.pipeline/toolkit`; it is not published to npm.

```bash
git submodule add git@github.com:hueypov/kampus-pipeline.git .pipeline/toolkit
git submodule update --init --recursive
./.pipeline/toolkit/bin/pipeline init
```

`pipeline init` writes only project-local Claude configuration and resolves
every runtime command from the pinned submodule. Run `pipeline init --check`
after filling `.claude/crew.config.jsonc`.

To add the optional generic GitHub Actions baseline (toolkit verification and
documentation-path safety), opt in explicitly:

```bash
./.pipeline/toolkit/bin/pipeline init --with-github-actions
```

It writes only `.github/workflows/pipeline-toolkit.yml` and
`.github/workflows/pipeline-doc-safety.yml`, and never replaces a consumer
workflow that already exists.
