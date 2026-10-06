# Rebranding this fork

This repository is a derivative of an Apache-2.0 upstream project, carrying the
HowToFix identity. The rename is driven by two files so the identity can be
changed again at any time without hand-editing the tree:

- `rebrand.gondolin.json` — the only place names live (upstream side and fork side)
- `scripts/rebrand-gondolin.mjs` — the rewrite tool

## Changing the identity

1. Edit `rebrand.gondolin.json`. Every field is used:

   ```json
   {
     "upstream": { "org", "scope", "app", "cli", "envPrefix", "company", "website" },
     "brand":    { "org", "scope", "app", "cli", "envPrefix", "company", "website" }
   }
   ```

   `cli` is the coding-agent CLI this sandbox integrates with (the fork ships
   `hxf`); it is rewritten in prose, file names and the extension example.

2. Dry run first — it prints every file it would touch and counts the matches
   per rule, and writes nothing:

   ```bash
   node scripts/rebrand-gondolin.mjs --dry
   ```

3. Apply, then rebuild and retest:

   ```bash
   node scripts/rebrand-gondolin.mjs --apply
   pnpm install --ignore-scripts
   cd host && pnpm run build
   ```

## Rules the tool follows

- **Ordered, longest first.** A scoped package name (`@scope/app-krun-runner`)
  is rewritten before the bare app name, so nothing is double-substituted.
- **Idempotent.** `rebrand.gondolin.state.json` records each applied run. The
  tool and its config are excluded from rewriting, so a second run still knows
  the original names.
- **Third parties are never touched.** `trufflesecurity`, `containers/libkrun`,
  `containers/libkrunfw`, `nodejs/node`, `joyent/node`, `wasilibs/go-re2` and
  the TC39 proposal name other people's projects. Renaming them would break
  downloads and citations.
- **Lockfiles and build output are skipped.** They are regenerated.

## What a rename does not cover

- **Published packages.** `pnpm-lock.yaml` and the `.github` release workflows
  reference the npm scope; re-run `pnpm install` after a scope change so the
  lockfile follows, and the workflows pick up the new scope automatically
  because they are rewritten in place.
- **Release artifacts.** `builtin-sandbox-helper-registry.json` points at
  GitHub release URLs. After a rename those URLs must exist, which means the
  sandbox-helper release workflow has to run once on the new repository.
- **The `gondolin` product name itself.** It is kept: it is this project's own
  identity and the npm package name depends on it. Change `brand.app` only if
  you also intend to publish under a different package name.
