#!/usr/bin/env node

/**
 * Local router for the private toolkit CLI.
 *
 * Dependencies are installed and built only by `pipeline init` / `pipeline sync`
 * from the toolkit's pinned lockfile. This command intentionally never invokes a
 * package manager, downloads a package, or changes the adopting repository.
 */
await import("./run.ts");
