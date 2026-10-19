# Third-Party Notices

## Upstream project

`@dmh2002/dsh-coldread-cache` is a fork of
**[dsh-coldread-cache](https://github.com/iuuuuuuuu/dsh-coldread-cache)**,
Copyright (c) 2026 **iuuuuuuuu**, licensed under the MIT License.

The original MIT license text is preserved in `LICENSE`. That file now carries two
copyright lines: the upstream author's (iuuuuuuuu, listed first) and this fork's
maintainer's (LaoDing). The upstream copyright notice is a condition of the MIT
License and applies to all code inherited from that project.

`package.json` lists `dingminhua` as `author` (npm allows exactly one) and
`iuuuuuuuu` as a `contributor`.

## What this fork changes

Changes made by **LaoDing** (`dingminhua`) on top of the upstream project:

- Backend mounting compatible with `dsh-session-persistence-jsonl` `0.2.1-rc.1` and
  later, where the backend class is no longer exported from the package and is
  instead instantiated inside `apply`. Affects `tests/compat.mjs`,
  `tests/gate/harness.mjs`, `tests/probe-deps.mjs`, `tests/probe-install.mjs`.
- Cross-platform path construction: 108 sites that built paths with a hard-coded
  Windows separator (`STAGE + "\\sessions"`) now use `node:path`'s `join()`, so the
  suite runs on macOS and Linux as well.
- Documentation updates in `README.md` / `README.en.md` describing both backend
  shapes and the measured results across four host versions.
- Packaging metadata for publication under the `@dmh2002` npm scope, plus this file
  and `CHANGELOG.md`.

The runtime code under `lib/` is unmodified from upstream.

## Upstream's own references

The upstream project documents its own sources and measurements in its README and
`tests/`. Refer to the upstream repository for the original authorship of the
resident-parse design.

## Reporting

Issues about **this fork** (packaging, the compatibility fixes above) →
https://github.com/dingminhua/dsh-coldread-cache/issues

Issues about the **original design or upstream code** →
https://github.com/iuuuuuuuu/dsh-coldread-cache

## License

MIT. See `LICENSE` for the full text.
