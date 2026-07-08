# splice-daml-template

A minimal, green-building **GitHub template** for Daml projects that data-depend
on the **Splice Amulet / Canton Coin** components. It handles the fiddly parts -
vendoring the upstream Splice sources, building the `splice-amulet-test` harness,
and wiring `daml.yaml` to the right DARs - so you can start on your contracts.

## Quick start

```bash
# 1. Create your repo from this template (GitHub "Use this template" or:)
gh repo create my-token --template <owner>/splice-daml-template --clone && cd my-token

# 2. Rename the generic package to yours (prompts for the Splice tag, then removes itself)
./init.sh my-token

# 3. Vendor deps + build the harness, then build + run the smoke test
npm install
npm test
```

`npm test` runs a smoke test that taps Canton Coin through the Amulet harness and
uses the sample production template - proving the whole toolchain end-to-end.

## What's inside

- `daml/splice-app/` - production package (sample `Greeting` template; replace it).
- `daml/splice-app-test/` - integration test package (sample `SmokeTest`).
- `scripts/fetch-dep.sh` - vendor Splice into `deps/`, derive versions, stable-symlink DARs.
- `scripts/build-harness.sh` - build the `splice-amulet-test` bootstrap DAR.
- `versions.env` - the single knob: `SPLICE_TAG`.
- `AGENTS.md` - the operational guide (toolchain, gotchas, versioning model).

## Requirements

- `dpm` (Digital Asset Package Manager) and a JDK 17+ on `PATH`
  (`curl https://get.digitalasset.com/install/install.sh | sh`, then
  `dpm install 3.4.11`).
- `git` + network access (setup clones `canton-network/splice`).

## Bumping Splice

Edit `SPLICE_TAG` in `versions.env`, run `npm run setup`. No other file changes -
unless the new tag ships a different SDK, in which case also update `sdk-version`
in the two `daml.yaml` files (see AGENTS.md).

## License

MIT - see [`LICENSE`](LICENSE).
