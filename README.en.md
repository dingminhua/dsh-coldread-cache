# dsh-coldread-cache

**English** | [简体中文](./README.md)

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-topic-2f6feb)](https://github.com/topics/dsh-plugin)

Keeps an active session's stored log parsed, so long sessions stop going sluggish.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin.
It **modifies no file in the DSH installation**: on mount it writes own properties
onto the live persistence backend instance, and restores them on unmount.

---

## Symptom and root cause

The longer a session runs and the more turns it accumulates, the more sluggish the
UI gets: switching sessions drags, sending a message waits, and the disk never
stops. Restarting fixes it — and then it slowly creeps back.

The cause is not a memory leak. It is a **whole-artifact cold read**:

1. DSH stores each session as `session.v4.jsonl.zstd`: concatenated,
   independently decodable Zstandard frames, one JSONL batch per frame, with the
   header as the first frame.
2. The JSONL backend memoizes parsed logs, but the memo is **capped at two
   entries** and keyed by a stat-derived `revision`.
3. **Every append changes that revision**, so a session being written misses the
   memo on essentially every read.
4. A miss is a full cold parse: `readFile` of the whole artifact, Zstandard
   decode of every frame, `JSON.parse` of every row.

Measured on this machine's real logs:

| artifact | events | cold parse |
| --- | --- | --- |
| 16 MB | 15 958 | 576 ms |
| 73 MB | ~39 700 | ~2 400 ms |

The cost is almost entirely the JSON layer, not decompression and not the disk: on
a 73 MB artifact, `JSON.parse` alone is ~1 750 ms and `JSON.stringify`
~2 470 ms.

Caught in the act: a live host with one long session open was reading
**846 MB per 30 s**, peaking at 61.6 MB/s, with 37 477 read operations in 30 s —
against roughly 0 MB/s for a freshly started host.

## What this plugin does

It keeps **one resident decoder per session**, built by the same released format
decoder the backend uses, and extends it instead of rebuilding it:

- an **unchanged** artifact is answered from the resident parse, after one
  `stat`;
- a **grown** artifact has only its new bytes read, decoded, and fed to the
  resident decoder, which appends to the event list it already holds;
- **anything else** is handed back to the backend's own reader untouched. No
  guessing, no patching over.

Measured: feeding a resident 16k-event decoder the frames a real append produced
costs **under a millisecond**, against **576 ms** for the cold parse of the same
log, and the extended artifact is deep-equal to a whole-file parse. The event
objects a read already handed out stay **the same objects** after growth, so a
caller polling the session sees no churn.

### One trap worth naming

Before returning a result the backend calls `freezeStoredEvents`, which
**freezes the decoder's own event array in place**. So the plugin must keep its
resident decoder unfrozen and hand out a **frozen copy** per read. Otherwise the
second append blows up:

```
Cannot add property 15953, object is not extensible
```

## Correctness

A resident parse is reused only when the reuse is provably equivalent to a full
parse:

1. the same artifact — same device and inode, and the same path;
2. the artifact only grew, and the header frame's bytes are unchanged;
3. every byte after the resident length is a whole, independently decodable
   Zstandard frame (a torn tail falls back);
4. feeding those frames to the resident decoder adds rows and nothing else, and
   the format decoder's own relationship constraints still hold;
5. the new rows pass the **same** released-v4 row admission, the same stored-event
   validation, and the same relationship assertions as the backend's own reader,
   and the read reports the revision it **actually observed**.

Anything unprovable falls back. The worst case is a read that stays exactly as
slow as it is without the plugin — never slower, and never a different answer than
a whole-file parse.

## Install

The plugin is loaded from a profile, and it bundles its own loader row:

```jsonc
// <profile>/cordis.patch.yml
- insert:
    - id: coldread-cache
      name: 'dsh-coldread-cache'
```

The recommended way is dsh's own plugin command:

```sh
dsh plugin --profile <name> add dsh-coldread-cache
```

Mounting it by hand needs all three of these; missing one fails startup:

| file | what it needs |
| --- | --- |
| `<profile>/package.json` | the package in `dependencies` |
| `<profile>/package.json` | `dsh-coldread-cache` in `dsh.profile.bundles` |
| `<profile>/cordis.patch.yml` | the `insert` row above |

Mount order does not matter: the plugin first tries
`ctx.get("sessionPersistence")`, and if the service is not up yet it registers
`ctx.on("internal/service", …)` and waits for it. So it takes effect
**automatically at host startup**, with no manual step.

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | serve reads from the resident parse |
| `maxEntries` | `8` | sessions kept resident in this process |
| `maxResidentBytes` | `134217728` | total resident source bytes |
| `statusFile` | `""` | optional path for a live diagnostic document |

The first two are memory policy for the process. The backend's own two-entry memo
is left exactly as it is.

`statusFile` exists for diagnosis: it writes a live document (refreshed by a
heartbeat) saying **which hooks this process actually installed**, how many hits
it served, and the distribution of fallback reasons. A plugin that silently stops
working is worse than one that never worked, so there is a way to see it.

## Verified

```sh
pnpm run gate    # acceptance gate over the real vendored backend
pnpm run fault   # fault injection: prove the gate above can turn red
pnpm run perf    # append-then-read A/B on a real session log
pnpm test        # dependency and install-mechanism probes
```

### The gate

`GATE_GREEN checks=85 failures=0`. The gate drives the **real vendored backend**
twice over the same private copies of real session logs — once pristine, once
patched — and deep-compares the results: the corpus, the append path, torn
artifacts, same-size rewrites, restore to pristine, a residency-free control, and
a **deliberate fault injection that proves the comparison can fail**. A green
without a fault injection is not green.

`pnpm run fault` runs seven injections on their own, proving the gate's
decisive assertions can really fail: one flipped byte breaks the vendored digest
check, a dropped event or one extra field breaks the read comparison, and with
residency switched off the hit count must be zero (otherwise the performance
claim would be proving itself). The gate also takes an exclusive lock on its
stage root — two runs sharing one would corrupt each other's fixtures, and the
lock makes the second run refuse instead of quietly reporting a wrong answer.

Both vendored trees stay byte-identical to their shipped SHA-256
(`027803DDE72AAC7038253F0A8FF9FDCDBF0EB8CAD53ED26EFA3EC610F01587E7`); the gate
asserts that at the **start and the end** of every run.

### The performance A/B

On a real ~90 MB session log, it appends a real batch through the backend's **own
write path** and then times the read that follows it — the read a host does on
every turn — five rounds each, taking the median:

Medians from three independent runs (the same ~90 MB real session, five rounds
each):

| read after an append | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| pristine backend | 2 928 ms | 4 232 ms | 5 972 ms |
| plugin with residency switched off (control) | 5 244 ms | 6 436 ms | 6 493 ms |
| **plugin** | **474 ms** | **410 ms** | **477 ms** |

That is **6× to 12.5×**. The control is the assertion's own
proof: the same loop, the same backend class, the same file, with residency
disabled — it shows no speedup at all, which means the assertion **can really turn
red**.

> Note: this does **not** compare "reading the same file twice". The backend's own
> two-entry memo already makes a repeat read fast, so that comparison would prove
> nothing. What actually hurts is **reading a log that just grew**, which is what
> the A/B measures.

### On a running host

A spare profile was cold-booted on another port (the host in use was left alone),
with no arguments passed:

```json
{
  "backend": "session-persistence-jsonl",
  "installed": ["readStoredLog","decodeStoredLog","persistBatch","persistHeader","truncateTornTail"],
  "failures": {}
}
```

Zero plugin errors in the startup log. Then, driving the UI **by hand** over real
sessions:

```
hits=4   ext=0  cold=1     <- first open
hits=5   ext=0  cold=2     <- open another session
hits=9   ext=1  cold=3     <- back to the first: served by an extension, no cold read
hits=11  ext=2  cold=4     <- another round: two more extensions
```

The last two lines are the point: `extensions` climbs while `coldParses` does
not follow it.

## Limitations

- The fast path covers growth by whole frames and an unchanged artifact. A torn
  tail, a rewrite, a truncation, or a rebuild of the frame list falls back.
- Residency is **per process** and does not survive a host restart; the plugin
  re-installs on mount.
- The first read is always cold — there is no resident result to serve yet.
- The backend's own two-entry memo is untouched, and the plugin has its own byte
  and entry budgets.

## License

MIT

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
