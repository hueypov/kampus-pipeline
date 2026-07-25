# pipeline-cli

`pipeline-cli` is the private toolkit’s local command router. It groups small,
tested Git, GitHub, repository-analysis, and workflow utilities behind one
project-local command.

It is not a public package, a global command, or a registry dependency.

## Use from an adopting repository

After the private toolkit submodule has been initialized, invoke it through the
project’s package script:

```bash
pnpm pipeline cli commands compact
pnpm pipeline cli <tool> --help
pnpm pipeline cli <tool> <arguments>
```

`pipeline init` installs and builds the pinned toolkit workspace from its
lockfile. The CLI never installs dependencies, fetches a package from a
registry, or changes the consumer repository just to make itself available.

## Tool contracts

Each command must either:

- derive its behavior from the current Git repository, supplied arguments, or
  an explicit repository-owned configuration file; or
- fail with a clear message that the target repository has not supplied the
  required contract.

A command must not assume a particular default branch, application directory,
cloud provider, feature-flag system, Git hook runner, label taxonomy, or
release policy.

For the current command list and arguments, run:

```bash
pnpm pipeline cli commands compact
```

## Toolkit development

From the toolkit checkout:

```bash
pnpm --filter @kampus/pipeline-cli typecheck
pnpm --filter @kampus/pipeline-cli test
pnpm --filter @kampus/pipeline-cli build
```

Do not publish this package. Consumers update by moving their pinned
`.pipeline/toolkit` submodule commit and running `pnpm pipeline sync`.
