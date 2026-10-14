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

The budget is in **compressed source bytes**, but the bill is paid in **heap**: a
parsed log measured about **8x** its compressed size (202 MB of sessions held about
1207 MB of heap), so the default 128 MB budget is roughly 1 GB of heap.
`resident.heapEstimateBytes` / `heapRatio` in the status file report that estimate
live, sampled from real cold parses rather than hardcoded. Raise it on a machine
with room to spare.

**A smaller default was tried and reverted on evidence.** The intuition was "less
budget, same behaviour, less memory", but measuring it on real sessions (one being
written, four being read) said otherwise:

| budget | resident | residency hit rate |
| --- | --- | --- |
| 16 MB | 35 MB | 14% |
| 32 MB | 35 MB | 14% |
| 64 MB | 35 MB | 14% |
| 128 MB | 99 MB | **53%** |
| 256 MB | 167 MB | **93%** |

The path that actually removes the lag — serving an append's read from the resident
parse instead of re-decoding the whole log — already works at 16 MB, because a
written session outranks a read-only one. What the budget above that buys is
residency for sessions a host merely READS: browsing history, the session list,
switching between sessions. So 128 MB is the smallest budget that serves a real
working set, and lowering it trades a measured regression for a memory saving that
is not the bottleneck.

### When does the extension counter climb?

`extensions` only climbs in one situation: the host appends to a session and then
**reads that same session**. Three traffic shapes were measured (8 turns each, real
sessions, 254 MB of fixtures):

| traffic shape | extensions | cold parses |
| --- | --- | --- |
| append, then read the same session (32 MB budget) | 8 | 0 |
| append, then read the same session (128 MB budget) | 8 | 0 |
| append, then read 4 other sessions first (32 MB budget) | 8 | 32 |
| append, then read 4 other sessions first (128 MB budget) | 8 | 32 |
| **read-only, nothing appended** | **0** | 15 |

So `extensions: 0` is **not by itself a fault**: if a host only browsed sessions and
did not run consecutive turns in one of them, zero extensions is the correct reading
and `coldParses` is what grows. Whether the plugin is working is judged by whether the
read that FOLLOWS an append takes the extension path, not by the absolute count. Two
other candidates were ruled out by the same measurements: the write-handle branch (a
host's own append-then-read loop **does** take the fast path) and the budget size (8/8
extensions even at 32 MB with bystander traffic).

### Why it got laggy after long use (fixed)

The extension path **deep-froze the whole session's event graph on every turn**:
`Object.freeze` has to walk every nested object. Freezing itself is correct (it
matches what the pristine backend does), but extension applied it to **all** events
rather than only the newly appended ones, so each turn re-walked the entire session
— a cost that grows linearly with the session. Measured on a 60k-event log:

| work done per extension | cost |
| --- | --- |
| freezing every event in the result (before) | **191.7 / 199.5 ms** (two runs) |
| freezing only the appended events (after) | **0.4 / 1.8 ms** (two runs) |
| the `concat` itself (unavoidable) | 0.3 ms |

A 100-turn session would have spent roughly **20 seconds** just re-freezing. That is
a real source of "it gets slower the longer you use it", and it was introduced by
this plugin. The fix has two parts, each a safety net for the other: (1) extension
freezes only the new events; (2) `freezeStoredEvent` returns immediately when the
root is **already frozen**, since a frozen root means the whole graph is frozen (the
walk always freezes a graph in one pass). Part 2 means part 1 cannot silently
regress into a slow path. The gate asserts that every event in a real extended
result is deeply frozen, and proves that assertion can report a violation using an
deliberately open object.

After the fix, the A/B median is **131 ms** (about 500 ms before).

### Eviction order

When residency is full, does the least recently READ session go first? No — that
fails on a real host. Reading a bystander session IS a cold parse, and a cold parse
makes that bystander the most recently used entry, so the session being WRITTEN gets
pushed out — and "read right after an append" is the one case this plugin exists
for. Measured: a host running for 85 minutes, 405 reads served from residency, and
**zero** extensions, every fallback classified `no-entry`.

The rule is therefore: **a session that has been written outranks one that has only
been read.** Among equals the least recently read goes first, and the last entry is
never evicted. The gate carries a regression assertion for this and proves it can
turn red by fault injection (neutralize the write ranking and the same assertion
must fail). `resident.hot` is how many sessions are currently ranked as written.

`statusFile` exists for diagnosis: it writes a live document (refreshed by a
heartbeat) saying **which hooks this process actually installed**, how many hits
it served, and the distribution of fallback reasons. A plugin that silently stops
working is worse than one that never worked, so there is a way to see it.

## Verified

```sh
pnpm run gate          # acceptance gate over the real vendored backend
pnpm run fault         # fault injection: prove the gate above can turn red
pnpm run perf          # append-then-read A/B on a real session log
pnpm test              # dependency and install-mechanism probes
pnpm run compat        # full cycle against every installed DSH tree (multi-version)
pnpm run probe:contract # the contract can fail: removing a helper must be refused
pnpm run probe:segments # whether validation can be segmented (proves the floor)
pnpm run probe:breakdown # per-stage cost of one extension
pnpm run probe:artifact  # what reader.artifact() costs (proves the explicit check is needed)

pnpm run probe:freeze  # per-turn full freeze vs freezing only new events (asserted)
pnpm run probe:evict   # does residency survive bystander traffic (asserted)
pnpm run probe:budget  # residency hit rate per budget (this is how the default was chosen)
pnpm run probe:heap    # residency heap cost (source bytes -> heap)
```

The `probe:*` scripts are what produced the numbers in this README, and they are
not decoration: `probe:freeze` and `probe:evict` carry assertions and exit 1 when the
behaviour regresses. They need real sessions: `$DSH_HOME\sessions` by default, or point
`DSH_SESSIONS` straight at a sessions directory.

### The gate

`GATE_GREEN checks=95 failures=0` (about 4 minutes). The gate drives the **real
vendored backend** twice over the same private copies of real session logs — once
pristine, once patched — and deep-compares the results: the corpus, the append path,
torn artifacts, same-size rewrites, restore to pristine, a residency-free control,
**residency survival under bystander traffic**, and a **deliberate fault injection
that proves the comparison can fail**. A green without a fault injection is not
green.

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

After the freeze fix below, two more runs on the same fixture measured:

| append-then-read | run A | run B |
| --- | --- | --- |
| pristine backend | 8 417 ms | 2 893 ms |
| residency-free control | 6 959 ms | 4 682 ms |
| **plugin** | **131 ms** | **88 ms** |

That is **22× to 64×** against pristine. The absolute numbers move with the machine's
load — pristine itself varied by 3x between those two runs — so the ratio is the
claim, and the control is what keeps it honest.

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

### A defect found on a real host (fixed)

That run was **short and revisited the same session**, which hid a problem that only
appears over long use. On a host that had been running for 85 minutes of real work,
the status file said:

```json
"stats": { "hits": 405, "extensions": 0, "coldParses": 369,
           "fallbacks": 369, "reasons": { "no-entry": 369 } }
```

**405 reads served from residency, zero extensions, and all 369 fallbacks classified
`no-entry`.** Note that `extensions: 0` alone is **not enough to call this a fault**
(see "When does the extension counter climb?" above). What pins it down is a
**controlled experiment**: with 2 resident entries and 64 bystander reads, does
"append then read the same session" still extend? With the write ranking it does
(1 -> 2); with the ranking neutralized it does **not** (1 -> 1). Same code, same file,
the ranking is the only difference, so the mechanism holds.

So the eviction order was a real defect (ranking by read recency lets a bystander
cold parse push out the session being written), and the 85 minutes of live counters
are consistent with it. This was found by reading the live counters, not by a test;
the fix is what the "Eviction order" section and its fault-injected regression
assertion are about.

## Multi-version compatibility

The plugin does not edit a source tree; it mounts onto a **released backend**. It statically
imports seven `@deepseek-ai/*` packages and replaces five methods on the
`dsh-session-persistence-jsonl` instance. So "compatible" has to mean **it works against a DSH
tree I did not develop on**, not "it works on my machine".

### The declared surface

The plugin's dependence on the backend splits into two kinds, listed separately because they
fail differently:

| Kind | Members | What a missing member does |
| --- | --- | --- |
| Replaced | `readStoredLog`, `decodeStoredLog`, `persistBatch`, `persistHeader`, `truncateTornTail` | Does not install — writes nothing |
| Called | `assertStoredIdentity`, `locate`, `memoizeStoredLog` | Does not install, with a readable reason |

A missing patch point cannot be installed around. A missing helper is worse: the replacement
would throw from **inside somebody else's read**, where there is no recovering. Both are probed
**before anything is written**, so a version that moved degrades to the pristine reader instead
of half-installing.

### How it is tested

```sh
pnpm run compat          # the full cycle against every DSH tree on the machine
pnpm run probe:contract  # the contract can fail: removing a helper must be refused
```

`compat` finds the trees itself (or takes `DSH_TREES`), and for each one: builds a session log
**written by that tree**, attaches the plugin, appends a real batch, reads it back, and asserts
the read was served by **extending the resident parse** rather than a cold re-decode. On this
machine, 3 trees across 2 versions (`0.2.0-rc.2` and `0.2.1-alpha.2`) are all
`COMPAT_GREEN checks=16`.

The suite also uses a loader hook to redirect the plugin's **own** `@deepseek-ai` imports onto
the tree under test. Without that step the test is really "tree A's backend driven by tree B's
validation modules" — invisible when both trees are identical, which is exactly when it would be
least likely to be noticed.

```
COMPAT_ALL_GREEN trees=3 failed=0
  exit=0  COMPAT_GREEN checks=16 failures=0   0.2.0-rc.2
  exit=0  COMPAT_GREEN checks=16 failures=0   0.2.1-alpha.2 (nightly)
  exit=0  COMPAT_GREEN checks=16 failures=0   0.2.1-alpha.2 (stable)
```

### Two things the survey turned up

- The two versions differ by 17 old / 21 new lines, all in the migration verifier's exit
  handling and a `readGenerationHeader` rename (`header` → `metadata`). **Nothing in the read or
  append path changed.**
- The older tree (`0.2.0-rc.2`) **cannot read a session the newer harness wrote**: it refuses
  `working-directory/change` as an unknown, non-ignorable event type. That is a **data-level**
  incompatibility, unrelated to the plugin — and it is why a test fixture must be produced by the
  tree under test.

## History loading: two real regressions, and their fixes

Every optimization above targets "append then read". **Loading history is a different path**, and it
had never been measured. Measuring it showed the plugin was **slower than the pristine backend** on
it — which is the mechanical reason a long-used DSH also feels slow when loading history.

### Measure the two paths first

| Path | Cost | What it is |
| --- | --- | --- |
| `list()` (session list) | **839 ms** | walks 548 sessions, opening each file for its header |
| cold read of one 62 MB session | **3892 ms** | what a user triggers by opening a session from history |

The cold read breaks down into decompressing 16665 frames (**3006 ms**) and parsing 40478 JSON
records (**2007 ms**). The frames are tiny (median 1298 B) and each costs **0.195 ms** to decode —
**almost all of it per-call setup**, not per-byte work.

### Regression 1: the plugin used the slow decoder

Upstream's backend does **not** decode frame by frame with the one-shot API. Its
`createZstdFrameDecoder()` is

```js
return NodePrivateZstdFrameDecoder.create() ?? new PublicZstdFrameDecoder();
```

i.e. it **prefers** a decoder that reuses one native context, falling back to the public API only when
its shape probe fails. The plugin's port copied only the public half, so every frame of a cold read
built a fresh native context.

Controlled measurement (alternating rounds, gc forced between arms, median):

| | median |
| --- | --- |
| public one-shot, per frame | 906 ms |
| reused context | **439 ms** — **2.07x** |

> This nearly went wrong: another run reported the reused context as **0.72x (slower)**. Both cannot
> be true. The difference was that run had already allocated 277 MB of plaintext, polluting GC state.
> With gc forced between arms and the arms alternated, the result is stably 2.07x. **When two
> measurements disagree, find the environmental difference — do not just believe the convenient one.**

### Regression 2: it materialized all the plaintext at once

The plugin collected all 16665 decompressed frames (about **278 MB** of plaintext alive at once) before
handing them to the reader. The reader already handles records that span frames, so collecting bought
nothing and paid allocation and GC for it.

### After the fixes

| | before | after |
| --- | --- | --- |
| cold read, 62 MB session, vs pristine | **1.48x SLOWER** (4227 ms vs 2855 ms) | **1.11x faster** (2667 ms vs 2974 ms) |

### The session list: a header cache

`list()` opens **every** session file and decodes its first frame to read the header, even when that
header cannot have changed. That is most of the cost of enumerating history.

The plugin adds a sixth hook, `readGenerationHeader`, caching the backend's **own return value** keyed by
the generation file's identity (the same stat-derived key the backend's own coldLogMemo uses). This
cache is **not** the residency cache and must not be confused with it:

| | residency | header cache |
| --- | --- | --- |
| holds | parsed events | parsed headers |
| size | hundreds of MB | ~500 B each |
| budgeted | by bytes, 128 MB | by count, 4096 (~2 MB) |

Keeping them separate is what lets history enumeration get fast without touching the memory budget the
event cache is carefully tuned around.

| Stage | pristine | patched | |
| --- | --- | --- | --- |
| `listGenerations` (directory walk) | 786 ms | 556 ms | not covered by the cache |
| `listArtifacts` (per-session header reads) | 2964 ms | **701 ms** | **4.23x** |
| `list()` total | 1499 ms | **762 ms** | **1.97x** |

Measured counters: **548 entries, 1092 hits, 552 misses** — hits dominate, so this is the cache working
and not luck.

### Two fake-green gates, both caught and fixed

Writing these gate checks produced **two in a row** that looked green without verifying anything. Both
were caught by **fault injection**, not by reading the code:

1. The first compared the speed of the selected decoder against the public API. Forcing the selection
   onto the public path made **both sides the same code**, so they compared equal and the check stayed
   green. Worse, at a 400-frame sample two measurements of the *same* code differed by 20% (66 vs
   55 ms), so the check lived inside its own noise band.
2. Reporting which decoder was selected still stayed green under injection — because the reporting
   function **bypassed** the `createZstdFrameDecoder()` under test and called the constructor directly.
   It reported what was *available*, not what was *selected*.

The fix is to make the selection **observable**: each decoder carries its own `kind`, and the reporter
must go **through** the selection. Injection now goes red with a diagnosable reason:

```
FAIL the decoder selection matches what this runtime supports
  :: runtime v26.0.0 privateUsable=true selected=public
```

Note that the **timing** check in the same run was still green — which is exactly the point: **a timing
difference is not evidence that the mechanism works.**

### A third gate defect: a false red

One of the verification rounds went red on the torn-tail check: `the recovered event sets differ at
1 positions`. A one-in-five failure is the hardest kind: not reproducible on demand, and the message
was **undiagnosable** — it did not say whether an event was missing, an extra one appeared, or one
field differed.

So the first three steps were not about the plugin:

1. **Make it diagnosable.** Replace "differ at N positions" with a multiset difference that prints
   the extra or missing event itself.
2. **Reproduce it in isolation.** Re-run section 3's exact scenario (including the real append
   before it), 10-12 alternating rounds. Every round was **identical**, and **repeatable**.
3. **Rule out the file moving.** Hash the artifact at every step of the comparison. Both sides read
   **the same bytes**; neither rewrote it.

Attention therefore turned to **the check itself**. It compared events with `JSON.stringify`, and that
string is **sensitive to key order** — while key order is not part of a session event's meaning: the
backend's own predicate is `isDeepStrictEqual`, which ignores it. `probe:keyorder` proves the
mechanism: two events differing **only in key order** are equal to the deep predicate and different to
stringify.

The fix was to **tighten** the comparison, not loosen it: on a torn tail the plugin does no recovery
at all — it refuses the fast path and hands the same bytes to the same pristine reader — so the two
answers should be **byte-identical**, not merely equal as sets. The check is now a strict deep
equality, pinned by the input hash, so a future red can only mean the answers differ, not that the
file moved.

| Aspect | before | after |
| --- | --- | --- |
| Comparison | `JSON.stringify` multiset (key-order sensitive) | strict deep equality (the backend's own predicate) |
| Input pinned | no | SHA256 before and after each side's read |
| Failure message | "differ at 1 positions" | the extra or missing event |
| Repeatability | not checked | same bytes read twice must give the same answer |

> **Honest boundary**: the failure's in-process state was not captured, so key order is **not proven**
> to be its cause. What is proven: that check can go red for a reason unrelated to what it tests, and
> after tightening it, 8 consecutive runs are green and 12 controlled reproductions are byte-identical.
> That is an **evidence-backed explanation**, not a confirmed conclusion.

Worth recording as a general shape: a gate can fail in three ways — **false green** (passes without
verifying), **false red** (fails for an unrelated reason, sending you to fix code that was never
broken), and **undiagnosable** (red with nothing to act on). This round hit all three.

## Where optimization stops

This round's goal was to stop once no further optimization is confirmed possible. The conclusion
is that **the remaining 57 ms is the released validator's price, and a plugin should not and
cannot remove it.**

One extension over a 55 MB / 58523-event session costs **63.2 ms** in total:

| Stage | Time | Share |
| --- | --- | --- |
| `assertReleasedV4Relationships` (walks every event) | 56.91 ms | 90% |
| Full-list scan (O(n) control) | 2.01 ms | 3% |
| `concat` (O(n) array copy) | 0.31 ms | 0.5% |
| Everything else | ~3.9 ms | 6% |

Segmenting it — validating only the newly appended events — was considered, and
`probe:segments` rules it out:

```
full walk over all 58523 events   80.6 ms   accepted
walk over only the last 4 events   0.07 ms
  tail-only validation: tool/ptc-dispatch is outside an open turn
  a segment after turn/end: turn/start does not open the expected turn
```

**Validation is a sequential state machine: whether an event is accepted depends on the events
before it.** A tail slice is refused outright, so "resume from a checkpoint" does not hold here.
Doing it would mean reimplementing the `Relationships` state machine
(lines 539–857 of `dsh-session-format-v3-to-v4`), which is module-local and unexported — i.e.
standing up a second copy of released validation logic. That is a much larger risk than the freeze
fix was, and it is not worth taking.

Two related points were also confirmed:

- `entry.reader.artifact()` costs **0.0 ms** (it checks the version and returns), so the plugin's
  explicit validator call is **not redundant** — it is the only full validation on this path.
- The CPU profile shows the cost is dominated by the cold parse's first pass (`#consume` 22.5%,
  `processChunkSync` 13.2%, GC 9.0%), not by the validator loop itself.

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
