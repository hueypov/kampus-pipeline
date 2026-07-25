# Vendored accessibility asset

`axe.min.js` is the pinned browser build of
[axe-core](https://github.com/dequelabs/axe-core) version **4.10.2**.

| Field | Value |
|---|---|
| File | `axe.min.js` |
| sha256 | `b511cd9dec01c76f4b2ad1723b66b6db37d4c2eb4ed199076e1829d9ee7b75e3` |
| License | MPL-2.0; the upstream copyright and license notice remain in the asset header. |
| Source | `https://registry.npmjs.org/axe-core/-/axe-core-4.10.2.tgz` |

The asset is vendored so a repository-defined accessibility audit can use a
known, network-free browser scanner without depending on a CDN, a particular
test stage, or a specific browser automation framework.

To update it, deliberately replace the asset from the upstream release, update
the version and checksum above, and review the resulting rule-set change.
