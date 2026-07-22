# canton-token-forge

A reusable, multi-instrument CIP-0056 (CN Token Standard) compliant token for
demos and sandboxes. It is interface-faithful to the standard and structurally
faithful to Amulet (rules/factory contract, two-template locking, two-step
transfer, allocation/DvP, registry HTTP API) but has NO economics (no decay,
fees, mining rounds, rewards, or DSO governance). Issuance is free/admin-authorized,
plus an optional per-instrument faucet.

## Quick start

```bash
# 1. Vendor the Splice interface DARs into deps/
npm install

# 2. Build both packages, then run the smoke script
npm test
```

`npm test` builds the production package and runs the version-marker smoke
script (`Canton.TokenForge.Test.Smoke:smoke`), proving the token interface deps
are vendored and the toolchain works end-to-end. Real interface tests land in
Plan 01+.

## What's inside

- `daml/canton-token-forge/` - production package. It data-depends ONLY on the
  seven `splice-api-token-*` interface DARs (holding, metadata,
  transfer-instruction, allocation, allocation-instruction, allocation-request,
  burn-mint) and NOT on `splice-amulet`. The current sample is a
  `Canton.TokenForge.Version` marker module; real templates are added in Plan 01+.
- `daml/canton-token-forge-test/` - test package with an amulet-free smoke script
  (`Canton.TokenForge.Test.Smoke`) that data-depends on the compiled production DAR.
- `scripts/fetch-dep.sh` - vendor Splice into `deps/`, derive versions, stable-symlink DARs.
- `scripts/build-harness.sh` - build the Amulet test harness (unused by default; only
  built by Plan 05 conformance).
- `versions.env` - the single knob: `SPLICE_TAG`.
- `CLAUDE.md` - the operational guide (toolchain, gotchas, versioning model);
  `AGENTS.md` is a thin pointer to it for non-Claude agents.

## Requirements

- `dpm` (Digital Asset Package Manager) and a JDK 17+ on `PATH`
  (`curl https://get.digitalasset.com/install/install.sh | sh`, then
  `dpm install 3.4.11`).
- `git` + network access (setup clones `canton-network/splice`).

## Bumping Splice

Edit `SPLICE_TAG` in `versions.env`, run `npm run setup`. No other file changes -
unless the new tag ships a different SDK, in which case also update `sdk-version`
in the two `daml.yaml` files (see CLAUDE.md).

## License

MIT - see [`LICENSE`](LICENSE).
