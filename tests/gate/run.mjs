/**
 * dsh-coldread-cache acceptance gate.
 *
 * Every check drives the REAL vendored backend: one pristine instance and one
 * plugin-patched instance read the same private copies of real session logs,
 * and their results are deep-compared. No mocks stand in for the backend, the
 * decoder, or the files.
 *
 * The gate is proven able to fail: section 7 injects a stale answer into the cache
 * and requires the comparison to catch it, and section 8's residency assertion is
 * shown to fail when the write ranking it depends on is neutralized.
 *
 * Run: node tests/gate/run.mjs
 */
import { readFile, writeFile, stat, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  check, cleanStage, compareLogs, findSession, listSessions, makeBackend, makePatchedBackend, nextClosedTurn,
  prefixEndingAtClosedTurn, release, section, sha256, stage, summary, STAGE, unfrozenIn, unlockStage,
} from "./harness.mjs";
import { join } from "node:path";

// The installed backends this plugin mounts onto. The default is the backend the
// running host actually loads, resolved through Node rather than named by path.
// Set DSH_VENDOR to a ";"-separated list to guard additional installs (this
// machine keeps a nightly tree and a stable tree, and a plugin that touched
// either must be caught). A missing path is a failure, not a skip.
const DEFAULT_VENDOR = (() => {
  try {
    return createRequire(import.meta.url).resolve("@deepseek-ai/dsh-session-persistence-jsonl");
  } catch {
    return "";
  }
})();
const VENDOR = (process.env.DSH_VENDOR ?? DEFAULT_VENDOR)
  .split(";")
  .filter((entry) => entry.length > 0)
  .map((entry) => entry.trim());
// The digest of the released backend this plugin is written against
// (dsh-session-persistence-jsonl 0.2.1-alpha.2). A hardcoded expectation is the
// point: it must fail when the tree changes, including on an upgrade. Override
// it with DSH_PRISTINE_SHA when validating against a different release.
const PRISTINE_SHA = (process.env.DSH_PRISTINE_SHA
  ?? "027803DDE72AAC7038253F0A8FF9FDCDBF0EB8CAD53ED26EFA3EC610F01587E7").toUpperCase();

const started = performance.now();
const before = [];
for (const path of VENDOR) before.push(await sha256(path).catch(() => undefined));

section("0. the vendored backend is untouched (" + VENDOR.length + " install(s) guarded)");
check(
  before.every((hash) => hash !== undefined),
  "every configured vendored tree exists",
  VENDOR.filter((_, index) => before[index] === undefined).join(", "),
);
for (let index = 0; index < VENDOR.length; index += 1) {
  if (before[index] === undefined) {
    // A missing tree is not a pass: the check could not run.
    check(false, "vendored jsonl module is pristine (" + VENDOR[index] + ")", "missing");
    continue;
  }
  check(before[index].toUpperCase() === PRISTINE_SHA, "vendored jsonl module is pristine (" + VENDOR[index] + ")", before[index]);

}

/* ------------------------------------------------------------------ */
section("0b. the configured defaults are the ones the code uses");
/* ------------------------------------------------------------------ */

/*
 * The default budget lived in two literals -- the schema's and the install path's --
 * and they drifted: the schema advertised 128 MB while a caller that passed no
 * config got 32 MB, a budget measurement had already shown to be a regression
 * (residency hit rate 14% vs 53%). The schema is documentation; the fallback is
 * behaviour, and a user reading one while getting the other is the bug. Deriving
 * both from one constant is the fix, and this is what would have caught it.
 */
const { Config, DEFAULTS } = await import("../../lib/index.js");
const parsedDefaults = Config({});
for (const key of ["enabled", "maxEntries", "maxResidentBytes", "statusFile"]) {
  check(
    parsedDefaults[key] === DEFAULTS[key],
    "the schema default and the install fallback agree on " + key,
    "schema=" + String(parsedDefaults[key]) + " fallback=" + String(DEFAULTS[key]),
  );
}
check(Object.isFrozen(DEFAULTS), "the defaults cannot be mutated at runtime");
check(
  DEFAULTS.maxResidentBytes === 128 * 1024 * 1024,
  "the budget default is the one measurement chose",
  String(DEFAULTS.maxResidentBytes),
);

await cleanStage();

/* ------------------------------------------------------------------ */
section("1. corpus: pristine vs patched, identical files");
/* ------------------------------------------------------------------ */

const candidates = await listSessions();
const corpus = [];
for (const candidate of candidates) {
  if (candidate.bytes > 100 * 1024 * 1024) continue;
  corpus.push(candidate);
  if (corpus.length >= 5) break;
}
check(corpus.length >= 3, "corpus has real sessions to read", "found " + corpus.length);

for (const candidate of corpus) {
  const staged = await stage(candidate.id);
  const pristine = await makeBackend(join(STAGE, "sessions"));
  const patched = await makePatchedBackend(join(STAGE, "sessions"));
  check(patched.state.real === patched.backend, "the plugin patched the backend instance itself (" + candidate.id.slice(0, 12) + ")");
  check(Object.hasOwn(patched.backend, "readStoredLog"), "readStoredLog is an own property while installed");
  check(Object.hasOwn(patched.backend, "decodeStoredLog"), "decodeStoredLog is an own property while installed");

  let expected;
  let actual;
  let expectedError;
  let actualError;
  try {
    expected = await pristine.backend.readStoredLog(staged.path, candidate.id, undefined);
  } catch (error) {
    expectedError = error;
  }
  // The comparison after this read only needs one side live at a time.
  try {
    actual = await patched.backend.readStoredLog(staged.path, candidate.id, undefined);
  } catch (error) {
    actualError = error;
  }
  const label = candidate.id.slice(0, 12) + " (" + candidate.bytes + " B)";
  if (expectedError !== undefined || actualError !== undefined) {
    check(
      expectedError !== undefined && actualError !== undefined && expectedError.constructor === actualError.constructor &&
        String(expectedError.message).slice(0, 60) === String(actualError.message).slice(0, 60),
      "both backends refuse the same artifact the same way " + label,
      "pristine=" + (expectedError?.message ?? "ok") + " patched=" + (actualError?.message ?? "ok"),
    );
  } else {
    const diffs = compareLogs(expected, actual);
    check(diffs.length === 0, "patched read equals pristine read " + label, diffs.join("; "));
    check(actual.eventState === "shared-frozen", "read reports the shared-frozen event state " + label, String(actual.eventState));

    // A second read must reuse residency and must share the frozen events.
    const again = await patched.backend.readStoredLog(staged.path, candidate.id, undefined);
    check(again.events.length === expected.events.length, "second read has the same length " + label);
    check(again.events[0] === actual.events[0], "second read shares the resident event objects " + label);
    const againDiffs = compareLogs(expected, again);
    check(againDiffs.length === 0, "second read still equals pristine " + label, againDiffs.join("; "));
    check(
      patched.cache.stats.coldParses === 1 && patched.cache.stats.hits === 1,
      "one cold parse and one residency hit for two reads " + label,
      JSON.stringify(patched.cache.stats),
    );
  }
  patched.disposer();
  release(expected, actual);
}

/* ------------------------------------------------------------------ */
section("2. append: the resident parse is extended, not rebuilt");
/* ------------------------------------------------------------------ */

// Pick the largest corpus member that the pristine backend can actually read:
// some real artifacts on this machine are torn and are covered by section 1.
let big;
let staged;
let totalEvents = 0;
for (const candidate of corpus) {
  const attempt = await stage(candidate.id);
  const probe = await makeBackend(join(STAGE, "sessions"));
  try {
    const probeLog = await probe.backend.readStoredLog(attempt.path, candidate.id, undefined);
    totalEvents = probeLog.events.length;
    big = candidate;
    staged = attempt;
    break;
  } catch {
    /* unreadable artifacts are covered by section 1 */
  }
}
check(big !== undefined, "found a readable corpus member for the append checks");
if (big === undefined) {
  console.log("\nGATE_ABORT no readable corpus member");
  process.exit(1);
}
check(totalEvents > 1000, "the append fixture is a real session", String(totalEvents) + " events");

// Rebuild the artifact as a shorter, frame-aligned prefix, then grow it back by
// a REAL append through the backend's own write path.
const { scanZstdFrames } = await import("../../lib/pristine.js");
const full = await readFile(staged.path);
const frames = scanZstdFrames(full).frames;
check(frames.length > 3, "the artifact has enough frames to split", String(frames.length));
// The prefix has to be a legal place to continue from: the validator refuses a
// `turn/start` while a turn is open, so cutting mid-turn would make every append
// illegal. Walk the frames back to the last one that ends a turn.
const cut = await prefixEndingAtClosedTurn(staged.path);
check(cut !== undefined, "found a frame-aligned prefix that ends at a closed turn", cut === undefined ? "none" : "frame " + cut.cut + " of " + frames.length);
if (cut === undefined) {
  console.log("\nGATE_ABORT no frame-aligned prefix ends at a closed turn");
  process.exit(1);
}
const cutFrames = cut.cut;
const prefixBytes = cut.bytes;

const pristinePrefix = await makeBackend(join(STAGE, "sessions"));
const patchedPrefix = await makePatchedBackend(join(STAGE, "sessions"));
await writeFile(staged.path, prefixBytes);
const expectedPrefix = await pristinePrefix.backend.readStoredLog(staged.path, big.id, undefined);
const actualPrefix = await patchedPrefix.backend.readStoredLog(staged.path, big.id, undefined);
check(compareLogs(expectedPrefix, actualPrefix).length === 0, "the frame-aligned prefix reads identically", compareLogs(expectedPrefix, actualPrefix).join("; "));
const base = expectedPrefix.events.length;
check(actualPrefix.events.length === base, "both backends see the same prefix length", actualPrefix.events.length + " == " + base);
const appended = nextClosedTurn(expectedPrefix);
check(appended.length === 4 && appended[0].type === "turn/start" && appended[3].type === "turn/end", "the fixture produced a complete turn to append", String(appended.length) + " rows");
const expectedAfterAppend = base + appended.length;

const statsBefore = { ...patchedPrefix.cache.stats };
await patchedPrefix.backend.persistBatch(expectedPrefix.meta, appended, true, expectedPrefix.inheritedEventCount);
const statsAfterWrite = { ...patchedPrefix.cache.stats };
check(statsAfterWrite.coldParses === statsBefore.coldParses, "the append itself did not cold parse", "coldParses " + statsBefore.coldParses + " -> " + statsAfterWrite.coldParses);

const actualFull = await patchedPrefix.backend.readStoredLog(staged.path, big.id, undefined);
const statsAfter = patchedPrefix.cache.stats;
// The pristine comparison is taken on the same file state the patched backend
// just read, so the stat-derived revisions are comparable.
const pristineFull = await makeBackend(join(STAGE, "sessions"));
const expectedFull = await pristineFull.backend.readStoredLog(staged.path, big.id, undefined);

check(actualFull.events.length === expectedAfterAppend, "the grown read has every event", actualFull.events.length + " == " + expectedAfterAppend);
check(compareLogs(expectedFull, actualFull, { revision: false }).length === 0, "the grown artifact equals the pristine whole-file read", compareLogs(expectedFull, actualFull, { revision: false }).join("; "));
check(statsAfter.coldParses === statsBefore.coldParses, "growth did NOT trigger a cold parse", "coldParses " + statsBefore.coldParses + " -> " + statsAfter.coldParses);
check(statsAfter.extensions >= 1, "growth was served by an extension", "extensions=" + statsAfter.extensions);
check(actualFull.events[0] === actualPrefix.events[0], "the prefix's frozen event objects survived the extension");
// The extension freezes only the appended events and trusts that the resident ones
// are already frozen. That trust is what makes the extension cheap, so verify the
// result really is frozen all the way down -- and verify the check can fail, or it
// is decoration.
const unfrozen = unfrozenIn(actualFull.events);
check(unfrozen === undefined, "every event in the extended result is deeply frozen", String(unfrozen));
check(
  unfrozenIn(Object.freeze([{ open: true }])) === "$[0]",
  "the deep-frozen check really can report a violation",
  String(unfrozenIn(Object.freeze([{ open: true }]))),
);
check(actualPrefix.events.every((event, index) => actualFull.events[index] === event), "every prefix event object is the same object after growth");

// The extension must not have left the pristine memo out of date.
const viaMemo = await patchedPrefix.backend.readStoredLog(staged.path, big.id, undefined);
check(compareLogs(expectedFull, viaMemo, { revision: false }).length === 0, "a third read (memo) still equals pristine", compareLogs(expectedFull, viaMemo, { revision: false }).join("; "));
release(actualFull, expectedFull, actualPrefix, expectedPrefix);

/* ------------------------------------------------------------------ */
section("3. fault injection: a torn tail must fall back and still be right");
/* ------------------------------------------------------------------ */

const tornBytes = Buffer.concat([prefixBytes, full.subarray(frames[cutFrames].start, frames[cutFrames].start + 9)]);
const pristineTorn = await makeBackend(join(STAGE, "sessions"));
const patchedTorn = await makePatchedBackend(join(STAGE, "sessions"));
// Build residency on the prefix, then drop a torn frame on top of it.
await writeFile(staged.path, prefixBytes);
await patchedTorn.backend.readStoredLog(staged.path, big.id, undefined);
await writeFile(staged.path, tornBytes);
// Hash the artifact on both sides of the comparison. The plugin refuses the fast path on a torn
// tail and hands the SAME bytes to the same pristine reader, so the two answers must be identical
// -- and if they ever are not, the first question is whether both reads saw the same file. An
// earlier version of this section compared unordered multisets and did not hash, so a rare
// disagreement was undiagnosable: it reported "differ at 1 positions" with no way to tell a
// plugin defect from the fixture having moved.
const tornHashBefore = await sha256(staged.path);
let expectedTorn;
let expectedTornError;
try {
  expectedTorn = await pristineTorn.backend.readStoredLog(staged.path, big.id, undefined);
} catch (error) {
  expectedTornError = error;
}
const tornHashBetween = await sha256(staged.path);
let actualTorn;
let actualTornError;
try {
  actualTorn = await patchedTorn.backend.readStoredLog(staged.path, big.id, undefined);
} catch (error) {
  actualTornError = error;
}
const tornHashAfter = await sha256(staged.path);
check(tornHashBefore === tornHashBetween && tornHashBetween === tornHashAfter,
  "the torn artifact was byte-identical across both reads (the comparison is meaningful)",
  tornHashBefore.slice(0, 16) + " / " + tornHashBetween.slice(0, 16) + " / " + tornHashAfter.slice(0, 16));
if (expectedTornError !== undefined || actualTornError !== undefined) {
  check(expectedTornError !== undefined && actualTornError !== undefined, "a torn artifact is refused by both", String(expectedTornError?.message ?? actualTornError?.message));
} else {
  // A torn tail leaves legitimate recovery latitude: the pristine backend reads
  // the complete frames of the buffer it was given, and the plugin's fallback
  // may decode the recovered tail with a different yield point. The promise is
  // that the plugin never answers from residency here, not that it stops at the
  // same byte as an independent decode of a deliberately damaged file.
  // Exact comparison. The multiset form was chosen to allow recovery latitude, but on a torn
  // tail the plugin does not recover anything itself: it refuses the fast path and the pristine
  // reader produces the answer. Both sides therefore run the same code on the same bytes, and a
  // set-level match would hide a reordering that the loose form was written to permit.
  const diffs = compareLogs(expectedTorn, actualTorn, { revision: false });
  if (diffs.length > 0) {
    // Dump the differing events. A count cannot be acted on; the event can. This path only
    // runs when the check has already failed, so it costs nothing on a green run.
    const left = expectedTorn.events.map((event) => JSON.stringify(event)).sort();
    const right = actualTorn.events.map((event) => JSON.stringify(event)).sort();
    const counts = new Map();
    for (const event of left) counts.set(event, (counts.get(event) ?? 0) + 1);
    for (const event of right) counts.set(event, (counts.get(event) ?? 0) - 1);
    console.log("       pristine events=" + left.length + " patched events=" + right.length);
    let shown = 0;
    for (const [event, n] of counts) {
      if (n === 0 || shown >= 3) continue;
      shown += 1;
      console.log("       " + (n > 0 ? "ONLY PRISTINE" : "ONLY PATCHED") + " x" + Math.abs(n) + " " + event.slice(0, 400));
    }
    if (shown === 0) {
      // Equal multisets but a different order: report the first index whose string differs.
      const at = left.findIndex((event, index) => event !== right[index]);
      console.log("       equal multisets, first differing sorted index " + at);
      console.log("       pristine " + String(left[at]).slice(0, 300));
      console.log("       patched  " + String(right[at]).slice(0, 300));
      console.log("       keyOrderPristine " + JSON.stringify(Object.keys(expectedTorn.events[0] ?? {})));
      console.log("       keyOrderPatched  " + JSON.stringify(Object.keys(actualTorn.events[0] ?? {})));
    }
  }
  check(diffs.length === 0, "torn-tail read recovers the same events as pristine", diffs.join("; "));
  check(patchedTorn.cache.stats.reasons["torn-tail"] > 0, "the torn tail was refused by the fast path", JSON.stringify(patchedTorn.cache.stats.reasons));
}
check(Object.keys(patchedTorn.cache.stats.reasons).length > 0, "fault injection reached the fallback path", JSON.stringify(patchedTorn.cache.stats.reasons));
release(expectedTorn, actualTorn);

/* ------------------------------------------------------------------ */
section("4. fault injection: an unchanged artifact cannot be served stale");
/* ------------------------------------------------------------------ */

// Sections 4 to 7 do not need a huge fixture: they exercise the fast path's
// refusals, restore, and the comparison itself. A small readable session keeps
// the gate's peak memory bounded and proves the same properties.
release(full, prefixBytes, tornBytes, frames);
let small;
let smallStaged;
for (const candidate of [...candidates].reverse()) {
  if (candidate.bytes < 800 * 1024 || candidate.bytes > 12 * 1024 * 1024) continue;
  const attempt = await stage(candidate.id);
  const probe = await makeBackend(join(STAGE, "sessions"));
  try {
    const probeLog = await probe.backend.readStoredLog(attempt.path, candidate.id, undefined);
    if (probeLog.events.length > 200) {
      small = candidate;
      smallStaged = attempt;
      break;
    }
  } catch {
    /* keep looking */
  }
}
check(small !== undefined, "found a small readable session for the refusal checks");
if (small === undefined) {
  console.log("\nGATE_ABORT no small readable session");
  process.exit(1);
}
const smallFull = await readFile(smallStaged.path);
const smallFrames = scanZstdFrames(smallFull).frames;
check(smallFrames.length > 2, "the small fixture has frames", String(smallFrames.length));

const pristineSwap = await makeBackend(join(STAGE, "sessions"));
const patchedSwap = await makePatchedBackend(join(STAGE, "sessions"));
await writeFile(smallStaged.path, smallFull);
const firstSwap = await patchedSwap.backend.readStoredLog(smallStaged.path, small.id, undefined);
const firstSwapEvents = firstSwap.events.length;
release(firstSwap);
// Same length, different bytes: the resident parse must not be reused.
const flipped = Buffer.from(smallFull);
flipped[Math.floor(flipped.length * 0.75)] ^= 0xff;
await writeFile(smallStaged.path, flipped);
let expectedSwap;
let expectedSwapError;
try {
  expectedSwap = await pristineSwap.backend.readStoredLog(smallStaged.path, small.id, undefined);
} catch (error) {
  expectedSwapError = error;
}
let actualSwap;
let actualSwapError;
try {
  actualSwap = await patchedSwap.backend.readStoredLog(smallStaged.path, small.id, undefined);
} catch (error) {
  actualSwapError = error;
}
check(
  (expectedSwapError === undefined) === (actualSwapError === undefined),
  "a same-size rewrite is treated the same by both backends",
  "pristine=" + (expectedSwapError?.message ?? "ok") + " patched=" + (actualSwapError?.message ?? "ok"),
);
if (expectedSwap !== undefined && actualSwap !== undefined) {
  check(compareLogs(expectedSwap, actualSwap).length === 0, "the same-size rewrite read equals pristine", compareLogs(expectedSwap, actualSwap).join("; "));
  check(actualSwap.events.length === firstSwapEvents, "the rewrite kept the event count", actualSwap.events.length + " == " + firstSwapEvents);
  release(expectedSwap, actualSwap);
}
release(flipped);
check(
  (patchedSwap.cache.stats.reasons["artifact-shrank"] ?? 0) > 0 ||
    (patchedSwap.cache.stats.reasons["different-file"] ?? 0) > 0 ||
    (patchedSwap.cache.stats.reasons["torn-tail"] ?? 0) > 0,
  "the same-size rewrite was refused by the fast path",
  JSON.stringify(patchedSwap.cache.stats.reasons),
);

/* ------------------------------------------------------------------ */
section("5. restore: the instance goes back to pristine");
/* ------------------------------------------------------------------ */

// The unpatched instance is built first and patched afterwards, so a clean
// restore means it ends up holding no own property at all.
const restoreTarget = await makeBackend(join(STAGE, "sessions"));
const ownBefore = JSON.stringify(Object.keys(restoreTarget.backend).sort());
await writeFile(smallStaged.path, smallFull);
const restorable = await makePatchedBackend(join(STAGE, "sessions"), {}, restoreTarget.backend);
const beforeRestore = await restorable.backend.readStoredLog(smallStaged.path, small.id, undefined);
check(Object.hasOwn(restorable.backend, "readStoredLog"), "installed before restore");
restorable.disposer();
check(!Object.hasOwn(restorable.backend, "readStoredLog"), "readStoredLog is gone after restore");
check(!Object.hasOwn(restorable.backend, "decodeStoredLog"), "decodeStoredLog is gone after restore");
check(!Object.hasOwn(restorable.backend, "persistBatch"), "persistBatch is gone after restore");
check(
  JSON.stringify(Object.keys(restoreTarget.backend).sort()) === ownBefore,
  "restore left the instance with exactly its original own properties",
  JSON.stringify(Object.keys(restoreTarget.backend).sort()),
);
const afterRestore = await restoreTarget.backend.readStoredLog(smallStaged.path, small.id, undefined);
check(compareLogs(beforeRestore, afterRestore).length === 0, "reads still work and agree after restore", compareLogs(beforeRestore, afterRestore).join("; "));
release(beforeRestore, afterRestore);

/* ------------------------------------------------------------------ */
section("6. control: with residency switched off the counters show it");
/* ------------------------------------------------------------------ */

const offBackend = await makePatchedBackend(join(STAGE, "sessions"), { maxResidentBytes: 1 });
const offExpected = await makeBackend(join(STAGE, "sessions"));
const offActual = await offBackend.backend.readStoredLog(smallStaged.path, small.id, undefined);
const offExpectedValue = await offExpected.backend.readStoredLog(smallStaged.path, small.id, undefined);
check(compareLogs(offExpectedValue, offActual).length === 0, "a residency-free patched backend still answers correctly", compareLogs(offExpectedValue, offActual).join("; "));
check(
  (offBackend.cache.stats.reasons["no-entry"] ?? 0) > 0 || (offBackend.cache.stats.reasons["tail-too-large"] ?? 0) > 0,
  "the control backend really refused to serve from residency",
  JSON.stringify(offBackend.cache.stats.reasons),
);
offBackend.disposer();
release(offActual, offExpectedValue);

/* ------------------------------------------------------------------ */
section("7. the comparison can fail: inject a stale answer");
/* ------------------------------------------------------------------ */

const sabotage = await makePatchedBackend(join(STAGE, "sessions"));
const stale = await sabotage.backend.readStoredLog(smallStaged.path, small.id, undefined);
const staleAnswer = stale;
const staleEvents = stale.events.length;
const shortBytes = smallFull.subarray(0, smallFrames[Math.max(1, smallFrames.length - 2)].start);
const pristineShort = await makeBackend(join(STAGE, "sessions"));
await writeFile(smallStaged.path, shortBytes);
const shortTruth = await pristineShort.backend.readStoredLog(smallStaged.path, small.id, undefined);
check(shortTruth.events.length !== staleEvents, "the stale answer really is wrong", shortTruth.events.length + " != " + staleEvents);
const originalServe = sabotage.cache.serve;
sabotage.cache.serve = () => Promise.resolve(staleAnswer);
const sabotaged = await sabotage.backend.readStoredLog(smallStaged.path, small.id, undefined);
const caught = compareLogs(shortTruth, sabotaged).length > 0;
delete sabotage.cache.serve;
check(sabotage.cache.serve === originalServe, "the injected serve was removed", String(sabotage.cache.serve === originalServe));
check(caught, "the comparison catches a stale answer (this is what makes the rest meaningful)");
const recovered = await sabotage.backend.readStoredLog(smallStaged.path, small.id, undefined);
check(compareLogs(shortTruth, recovered).length === 0, "after removing the injection the answers agree again", compareLogs(shortTruth, recovered).join("; "));
sabotage.disposer();
release(staleAnswer, shortTruth, recovered, smallFull, shortBytes, flipped);

/* ------------------------------------------------------------------ */
section("8. a written session keeps its residency under bystander traffic");
/* ------------------------------------------------------------------ */

/*
 * The defect this guards, measured on a real host: 85 minutes of use, 405 reads
 * served from residency, and ZERO extensions. Eviction ranked entries by read
 * recency, and a bystander read is a cold parse that makes that bystander the
 * most recently used entry -- so the session being appended to was pushed out
 * before its next append could extend it, which is the one case the plugin exists
 * for. A written session must outrank a merely-read one.
 */
// The active session has to accept an append, and an append needs a file whose
// recovered state ends at a CLOSED turn: the lifecycle validator refuses a
// `turn/start` while a turn is open, and real artifacts routinely end mid-turn.
// A readability probe is not enough -- the torn artifact in this corpus reads
// back successfully but ends mid-turn -- so reuse section 2's cut, which is the
// operation that produces a legal place to continue from.
const evictActive = big;
// Bystanders are only ever read, and a read is a cold parse whether the artifact
// is 4 MB or 90 MB. Small ones keep the section's memory bounded -- staging the
// whole corpus a second time aborted the process with 0xC0000409 instead of
// failing a check, which is a gate that cannot report its own verdict.
const evictStaged = [];
for (const candidate of candidates) {
  if (evictStaged.length >= 4) break;
  if (candidate.id === evictActive.id) continue;
  if (candidate.bytes > 6 * 1024 * 1024 || candidate.bytes < 64 * 1024) continue;
  evictStaged.push(await stage(candidate.id));
}
check(evictStaged.length >= 2, "there are bystander sessions to read", String(evictStaged.length));

/**
 * Run the eviction scenario once, from a freshly cut artifact.
 *
 * `inject` neutralizes the write ranking, which reproduces the production defect
 * this section guards: with the ranking gone, eviction falls back to read
 * recency, so a bystander read evicts the session being appended to. The injected
 * run MUST fail to extend -- that is what proves the un-injected run's success
 * means something, and it is the same fault a real host showed (405 reads served
 * from residency, zero extensions, every fallback classified `no-entry`).
 */
async function evictionScenario(inject) {
  const attempt = await stage(evictActive.id);
  const cut = await prefixEndingAtClosedTurn(attempt.path);
  if (cut === undefined) return undefined;
  await writeFile(attempt.path, cut.bytes);
  const patched = await makePatchedBackend(join(STAGE, "sessions"), { maxEntries: 2 });
  const real = patched.cache.noteWrite;
  if (inject) patched.cache.noteWrite = () => {};
  const writer = await patched.backend.open(evictActive.id, "write");
  let read = await writer.read();
  await writer.append(nextClosedTurn({ events: read.events }));
  read = await writer.read();
  const first = patched.cache.stats.extensions;
  // Bystander reads are what a busy host does between turns of the active session.
  for (let round = 0; round < 3; round += 1) {
    for (const bystander of evictStaged) {
      const handle = await patched.backend.open(bystander.id, "read");
      await handle.read();
      await handle.close();
    }
  }
  await writer.append(nextClosedTurn({ events: read.events }));
  read = await writer.read();
  const second = patched.cache.stats.extensions;
  const resident = patched.cache.size;
  await writer.close();
  if (inject) patched.cache.noteWrite = real;
  check(patched.cache.noteWrite === real, "the injected ranking was removed", String(patched.cache.noteWrite === real));
  patched.disposer();
  release(read);
  return { first, second, resident };
}

const injected = await evictionScenario(true);
check(injected !== undefined, "the eviction scenario ran");
if (injected !== undefined) {
  check(injected.first >= 1, "the first append extends the resident parse", String(injected.first));
  check(
    injected.second === injected.first,
    "the injection reproduces the defect, so the check below is able to fail",
    "extensions " + injected.first + " -> " + injected.second,
  );
}

const survived = await evictionScenario(false);
check(survived !== undefined, "the un-injected eviction scenario ran");
if (survived !== undefined) {
  check(survived.first >= 1, "the first append extends the resident parse", String(survived.first));
  check(
    survived.second > survived.first,
    "a written session stays resident through bystander reads, so the next append extends it",
    "extensions " + survived.first + " -> " + survived.second + " across " + evictStaged.length * 3 + " bystander reads",
  );
  check(survived.resident <= 2, "residency stayed inside its entry budget", String(survived.resident));
}
/* ------------------------------------------------------------------ */
section("9. the compatibility contract holds on the installed backend");
/* ------------------------------------------------------------------ */

{
  const { applyToService, HOOKS } = await import("../../lib/index.js");
  const HOOK_COUNT = HOOKS.length;
  const { ctx, backend } = await makeBackend(join(STAGE, "sessions"));

  // The installed backend must satisfy the declared surface: five patch points plus
  // the three helpers the replacements call.
  {
    const { state, disposer } = await makePatchedBackend(join(STAGE, "sessions"), {}, backend);
    check(state?.installed?.length === HOOK_COUNT, "the installed backend installs every hook", String(state?.installed?.length));
    check(Object.keys(state?.failures ?? {}).length === 0, "the installed backend meets the declared contract",
      JSON.stringify(state?.failures));
    disposer();
  }

  // The refusal must be reachable. These are prototype methods, so deleting an own
  // property proves nothing -- shadow the helper with a non-function own property,
  // which is what an API that moved looks like.
  {
    const before = HOOKS.map((key) => backend[key]);
    Object.defineProperty(backend, "memoizeStoredLog", { value: undefined, configurable: true, writable: true });
    try {
      const service = { [Symbol.for("cordis.original")]: backend };
      const disposer = applyToService(ctx, service, {});
      const state = backend[Symbol.for("dsh.coldread-cache.ownership")];
      check(state?.installed?.length === 0, "a backend missing a helper is refused, not half-patched",
        JSON.stringify(state?.installed));
      check(typeof state?.failures?.required === "string" && state.failures.required.includes("memoizeStoredLog"),
        "the refusal names the missing member", JSON.stringify(state?.failures));
      check(HOOKS.every((key, index) => backend[key] === before[index]),
        "no hook was written on a refused backend");
      disposer?.();
    } finally {
      delete backend.memoizeStoredLog;
    }
  }

  // And the same instance must install once the helper is back, so the refusal above
  // was caused by the removal and not by a second attach being impossible.
  {
    const { state, disposer } = await makePatchedBackend(join(STAGE, "sessions"), {}, backend);
    check(state?.installed?.length === HOOK_COUNT, "the instance installs once the helper is restored", JSON.stringify(state?.failures));
    disposer();
  }
  check(HOOKS.every((key) => !Object.hasOwn(backend, key)), "the instance is pristine after the contract checks");
}

/* ------------------------------------------------------------------ */
/* fixtures shared by the cold-path and history sections                */
/* ------------------------------------------------------------------ */

// Two real artifacts, chosen by size so a decode comparison has enough frames to be meaningful
// and the staging cost stays bounded. Both are selected once and reused by sections 10 and 11.
const coldFixtures = (await listSessions())
  .filter((entry) => entry.torn !== true)
  .sort((left, right) => right.bytes - left.bytes);
const largeFixture = (coldFixtures.find((entry) => entry.bytes > 8 * 1048576 && entry.bytes < 40 * 1048576)
  ?? coldFixtures[0])?.id;
const secondFixture = (coldFixtures.find((entry) => entry.id !== largeFixture && entry.bytes > 4 * 1048576)
  ?? coldFixtures.find((entry) => entry.id !== largeFixture))?.id;
check(largeFixture !== undefined && secondFixture !== undefined,
  "two usable fixtures were found for the cold-path and history sections",
  String(largeFixture) + ", " + String(secondFixture));

/** Compare two session lists by the header fields, ignoring revision and size. */
const deepEqualIds = (left, right) => {
  const shape = (list) => list
    .map((entry) => [String(entry.header?.id), String(entry.header?.createdAt), String(entry.header?.cwd)])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(shape(left)) === JSON.stringify(shape(right));
};

/* ------------------------------------------------------------------ */
section("10. the cold path is not slower than the backend it replaces");
/* ------------------------------------------------------------------ */

{
  const { createZstdFrameDecoder, decodeFrames, scanZstdFrames, zstdFrameDecoderKind } = await import("../../lib/pristine.js");
  const { createZstdDecompress, zstdDecompressSync } = await import("node:zlib");
  const { readFile } = await import("node:fs/promises");

  // The decoder must select the same implementation upstream does. Upstream's line is
  // `NodePrivateZstdFrameDecoder.create() ?? new PublicZstdFrameDecoder()`; a port that took
  // only the fallback was measured 1.48x SLOWER than pristine on a cold open.
  const privateUsable = (() => {
    const stream = createZstdDecompress({ chunkSize: 1024 * 1024 });
    const handle = stream._handle;
    const errorKey = Reflect.ownKeys(stream).find((k) => typeof k === "symbol" && k.description === "kError");
    const ok = typeof handle?.writeSync === "function"
      && stream._writeState instanceof Uint32Array && stream._writeState.length >= 2
      && typeof stream._defaultFlushFlag === "number"
      && errorKey !== undefined && stream[errorKey] === null;
    stream.close();
    return ok;
  })();
  const chosen = createZstdFrameDecoder();
  check(typeof chosen?.decode === "function" && typeof chosen?.close === "function",
    "a frame decoder is created (private shape " + (privateUsable ? "available on this Node" : "unavailable") + ")");
  chosen.close();

  // THE PRIMARY CHECK, and it asserts a FACT rather than an inference.
  //
  // The first version of this only compared the selected decoder's speed against the public
  // one. Forcing the public path then made both sides the same code, so they compared equal and
  // the check passed while the optimization was absent -- a fake-green gate, caught by injecting
  // the fault and watching it stay green. Asking the plugin which decoder it selected cannot be
  // satisfied by a fallback, so this is the assertion the speed measurement is paired with.
  const kind = zstdFrameDecoderKind();
  check(privateUsable ? kind === "private" : kind === "public",
    "the decoder selection matches what this runtime supports",
    "runtime " + process.version + " privateUsable=" + privateUsable + " selected=" + kind);

  // The cold decode must be byte-identical to the one-shot API, frame for frame. This is the
  // correctness half: a private-contract decoder that returns different bytes would corrupt
  // every session.
  const fixture = await findSession(largeFixture);
  const raw = await readFile(fixture.path);
  // Sample size matters here and the first version got it wrong. Comparing 400 frames, two
  // measurements of the SAME decoder differed by 20% (66 ms vs 55 ms) -- enough to turn the
  // "not slower" check red with no real difference present. A check whose red can be noise is
  // worse than no check. Four thousand frames puts the real ~2x gap far outside that band.
  const frames = scanZstdFrames(raw).frames.slice(1, 4001);
  const mine = decodeFrames(raw, frames);
  let mismatches = 0;
  for (let i = 0; i < frames.length; i += 1) {
    if (!mine[i].equals(zstdDecompressSync(raw.subarray(frames[i].start, frames[i].end)))) mismatches += 1;
  }
  check(mismatches === 0, "the cold decoder is byte-identical to the one-shot API on " + frames.length + " frames",
    "mismatches " + mismatches);
  release(mine);

  // Decode speed, interleaved with gc forced between arms so allocation pressure cannot
  // masquerade as a decoder difference. The first version of this comparison omitted that and
  // reported the reused-context decoder as 0.72x when it is 2.07x.
  const settle = () => globalThis.gc?.();
  const timePublic = () => {
    settle();
    const t0 = performance.now();
    let n = 0;
    for (const f of frames) n += zstdDecompressSync(raw.subarray(f.start, f.end)).length;
    return { ms: performance.now() - t0, n };
  };
  const timeSelected = () => {
    settle();
    const d = createZstdFrameDecoder();
    const t0 = performance.now();
    let n = 0;
    for (const p of d.decode(raw, frames)) n += p.length;
    const ms = performance.now() - t0;
    d.close();
    return { ms, n };
  };
  // Interleaved rounds with gc forced, so a warm-up or an allocation pause cannot be read as
  // a decoder difference -- the same control that resolved the 2.07x-vs-0.72x contradiction.
  const pub = [];
  const sel = [];
  for (let round = 0; round < 5; round += 1) {
    const first = timePublic();
    const second = timeSelected();
    pub.push(first.ms);
    sel.push(second.ms);
    if (round === 0) {
      check(second.n === first.n, "both decoders produced the same total plaintext bytes",
        second.n + " vs " + first.n);
    }
  }
  const medOf = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const pubMs = medOf(pub);
  const selMs = medOf(sel);
  if (privateUsable) {
    // A bounded allowance rather than a strict inequality: the point is to catch a decoder
    // that fell back to the slow public path (a ~2x gap), not to fail on scheduler noise.
    check(selMs <= pubMs * 1.25, "the selected decoder is not slower than the public fallback",
      "selected " + selMs.toFixed(0) + " ms vs public " + pubMs.toFixed(0) + " ms on " + frames.length +
      " frames (" + (pubMs / selMs).toFixed(2) + "x, rounds " + sel.map((v) => v.toFixed(0)).join("/") + ")");
  } else {
    check(true, "private shape unavailable; the public fallback is the correct selection here");
  }
}

/* ------------------------------------------------------------------ */
section("11. history enumeration: the header cache hits, and cannot go stale");
/* ------------------------------------------------------------------ */

{
  const { backend, disposer } = await makePatchedBackend(join(STAGE, "sessions"), {});
  const ownership = backend[Symbol.for("dsh.coldread-cache.ownership")];
  const headers = ownership?.headers;
  check(headers !== undefined, "the header cache is exposed for inspection");

  // A staged corpus of two real artifacts, so hits and identity are both exercised.
  await stage(largeFixture, STAGE);
  await stage(secondFixture, STAGE);
  const first = await backend.list({});
  const second = await backend.list({});
  check(second.length === first.length && first.length >= 2,
    "the staged corpus lists its sessions", String(first.length));
  check(headers.hits > 0, "a repeated list is served from the header cache", String(headers.hits) + " hits");
  check(deepEqualIds(first, second), "the cached list matches the uncached one session for session");

  // Fault injection: corrupt one artifact and require it to stop being listed. A cache that
  // ignored the file identity would keep serving the header it already had.
  const victim = second[0];
  const victimPath = await backend.findLog(victim.header.id).then((s) => s?.sourcePath);
  if (victimPath !== undefined) {
    const saved = await readFile(victimPath);
    await writeFile(victimPath, Buffer.from("not a zstd frame at all"));
    const afterCorruption = await backend.list({});
    check(afterCorruption.length === second.length - 1,
      "a corrupted artifact is dropped from the list (the cache did not serve a stale header)",
      "listed " + afterCorruption.length + " of " + second.length);
    await writeFile(victimPath, saved);
    const restored = await backend.list({});
    check(restored.length === second.length, "restoring the artifact restores the listing",
      String(restored.length));
  } else {
    check(false, "the corrupted-artifact injection could find its target path");
  }
  disposer();
}

/* ------------------------------------------------------------------ */
section("12. the vendored backend is still untouched");
/* ------------------------------------------------------------------ */

const after = [];
for (const path of VENDOR) after.push(await sha256(path).catch(() => undefined));
for (let index = 0; index < VENDOR.length; index += 1) {
  check(
    after[index] !== undefined && after[index] === before[index],
    "vendored jsonl module unchanged by the gate (" + VENDOR[index] + ")",
    String(after[index]),
  );
}

await unlockStage();
await rm(STAGE, { recursive: true, force: true });
console.log("\nGATE_SECONDS " + ((performance.now() - started) / 1000).toFixed(1));
process.exit(summary() ? 0 : 1);
