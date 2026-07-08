# CLAUDE.md

This repository follows **[`AGENTS.md`](AGENTS.md)** - read it first for the
toolchain, build/test commands, hard rules, and gotchas.

Quick orientation:

- This is a **Daml** project built with **`dpm`** (not a JavaScript project - the
  `npm` scripts just wrap `dpm` and vendor dependencies). If a parent-directory
  `CLAUDE.md` describes generic JS/`npm` workflows, **`AGENTS.md` here overrides
  it**.
- Vendor deps first: `npm install` (or `bash scripts/fetch-dep.sh` for deps
  only) - the packages data-depend on the Splice DARs in `deps/` (gitignored), so
  a build fails without them.
- Versions: pin **only** the Splice tag in `versions.env`; everything else is
  derived (see AGENTS.md "Versioning: one knob").
- Never edit `deps/`. Never put the test harness in the production package.
  Commits use no `Co-Authored-By` trailer.
