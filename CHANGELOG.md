# Changelog

All notable changes to this project are documented in this file.

This is a fork of [iuuuuuuuu/dsh-coldread-cache](https://github.com/iuuuuuuuu/dsh-coldread-cache).
Version numbers below are for this fork only and do not track upstream releases.

## 0.1.0 (2026-10-19)

First public release under the `@dmh2002` npm scope. Based on upstream
`dsh-coldread-cache` 0.1.0 (`ff83ab3`).

### Added

- Support for `dsh-session-persistence-jsonl` `0.2.1-rc.1` and later, where the
  backend class is no longer exported from the package. A `mountBackend()` /
  `buildBackend()` helper picks the right strategy per host version: when a class
  is exported it is constructed directly, otherwise the package is applied through
  `ctx.plugin()` and the instance is recovered from the service's
  `Symbol.for("cordis.original")`. `makeBackend()` and `makePatchedBackend()` became
  async as a consequence; 21 call sites now await them.
- Patch-point verification against the live backend instance rather than against a
  class prototype, so both backend shapes are covered.
- `THIRD_PARTY_NOTICES.md` recording the upstream copyright and the scope of this
  fork's changes.
- `CHANGELOG.md` (this file).

### Fixed

- 108 path constructions that hard-coded a Windows separator (`STAGE + "\\sessions"`)
  produced filenames containing a backslash on macOS and Linux, making
  `listSessions()` fail with `ENOENT`. All of them now use `join()`, across 23 files.
- Test entry points `tests/probe-deps.mjs` and `tests/probe-install.mjs` crashed with
  `TypeError: Cannot read properties of undefined (reading 'prototype')` on hosts
  where the backend class is not exported. This is what `npm test` runs, so the
  default test command was broken on those hosts.

### Changed

- `engines.node` is now `^22.19.0 || >=24.0.0`, aligned with other plugins in the
  same family.
- `peerDependencies` are pinned to `>=0.2.0-rc.2 <0.3.0-0` for the `dsh-*` packages
  instead of `*`. The lower bound is the oldest host line verified by the test
  suite; the upper bound carries `-0` because DSH has so far only shipped
  prereleases.
- `repository`, `bugs` and `homepage` point at this fork instead of upstream.
- Package published as `@dmh2002/dsh-coldread-cache`.

### Verified

Four real installation trees, each mounted and checked (`COMPAT_GREEN checks=16
failures=0`):

| Host version | Backend shape | Result |
| --- | --- | --- |
| `0.2.0-rc.2` | class exported | green |
| `0.2.1-alpha.2` | class exported | green |
| `0.2.1-rc.1` | `apply` only | green |
| `0.2.1-rc.2` | `apply` only | green |

On `0.2.1-rc.2` additionally: `GATE_GREEN checks=121`, `FAULT_GREEN checks=7`,
`PERF_GREEN checks=4`. Read-after-append on a real 9.2 MB / 12,369-event session:
**313.2 ms → 13.3 ms**.

The gate suite pins the backend package hash via `DSH_PRISTINE_SHA`; it must be
overridden when switching trees, otherwise section 0 reports a tampered vendored
module. That is the guard working, not a regression.

### Re-verified on 0.2.1-rc.5 (2026-10-30)

The host moved from `0.2.1-rc.1` to `0.2.1-rc.5`. Across that span the whole
`packages/session/` tree changed **only** in `package.json` version numbers — no
source edits to the backend, the format packages, or the read path.

Re-ran the suites against `0.2.1-rc.5` anyway, because "the diff only touched
version strings" is not the same as "the published artifact still mounts":

- `COMPAT_GREEN checks=16 failures=0` (all six hooks installed, append served by
  extending the resident parse, zero cold parses)
- `GATE_GREEN checks=121 failures=0`
- `FAULT_GREEN checks=7 failures=0`
- `PERF_GREEN checks=4 failures=0` — read-after-append **787.8 ms → 41.3 ms**
- `npm test` exit 0

No code changes were needed. The absolute timings on this run are higher than the
`rc.2` figures above because the corpus picked a larger staged artifact (13,904
events vs 12,369); the ratio is what the assertion checks.

