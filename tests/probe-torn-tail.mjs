/**
 * Is the torn-tail fallback actually equivalent to pristine, or only usually?
 *
 * Section 3 of the gate compares a torn artifact's recovery between the two backends. It failed
 * once in five runs, which is the worst kind of result: not reproducible on demand, and its
 * message ("the event sets differ at 1 positions") did not say whether an event was missing, an
 * extra one appeared, or one field differed.
 *
 * This reproduces that exact scenario in a loop and prints both sides' shape every time, so a
 * rare disagreement becomes a named difference instead of a count.
 *
 * Run: node --expose-gc --max-old-space-size=12288 tests/probe-torn-tail.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  cleanStage, compareLogs, listSessions, makeBackend, makePatchedBackend, nextClosedTurn,
  prefixEndingAtClosedTurn, release, stage, STAGE, unlockStage,
} from "./gate/harness.mjs";

await cleanStage();
const ROUNDS = Number(process.env.TORN_ROUNDS ?? 12);
let failures = 0;
const check = (ok, label, detail) => {
  if (ok) console.log("  ok   " + label);
  else { failures += 1; console.log("  FAIL " + label + (detail === undefined ? "" : " :: " + detail)); }
};

const { scanZstdFrames } = await import("../lib/pristine.js");
const corpus = await listSessions();

// Same fixture selection rule as the gate: the first corpus member pristine can read.
let big;
let staged;
for (const candidate of corpus) {
  const attempt = await stage(candidate.id);
  const probe = makeBackend(STAGE + "\\sessions");
  try {
    await probe.backend.readStoredLog(attempt.path, candidate.id, undefined);
    big = candidate;
    staged = attempt;
    break;
  } catch { /* unreadable artifacts are a different section */ }
}
check(big !== undefined, "found a readable corpus member");
const full = await readFile(staged.path);
const frames = scanZstdFrames(full).frames;
const cut = await prefixEndingAtClosedTurn(staged.path);
check(cut !== undefined, "found a frame-aligned prefix ending at a closed turn");

// Nine bytes of the next frame: enough to start a frame, not enough to finish one.
const tornBytes = Buffer.concat([cut.bytes, full.subarray(frames[cut.cut].start, frames[cut.cut].start + 9)]);
const root = STAGE + "\\sessions";
console.log("");
console.log("  fixture " + big.id + "  prefix " + cut.bytes.length + " B  torn " + tornBytes.length + " B");
console.log("");

const shape = (log) => ({
  events: log?.events?.length,
  tail: log?.recoveredTail?.length ?? 0,
  truncateTo: log?.tornTruncateTo,
  status: log?.status,
});

for (let round = 1; round <= ROUNDS; round += 1) {
  const pristine = makeBackend(root);
  const patched = makePatchedBackend(root, {});
  await writeFile(staged.path, cut.bytes);
  await patched.backend.readStoredLog(staged.path, big.id, undefined);
  // The gate appends a real turn here (its section 2) before the torn write. That is the one
  // structural difference between this probe and the gate, so it must be reproduced: a
  // residency built on the prefix alone is not the same state as one extended by an append.
  const prefixLog = await pristine.backend.readStoredLog(staged.path, big.id, undefined);
  const appended = nextClosedTurn(prefixLog);
  await patched.backend.persistBatch(prefixLog.meta, appended, true, prefixLog.inheritedEventCount);
  release(prefixLog);
  await writeFile(staged.path, tornBytes);

  let expected;
  let expectedError;
  try { expected = await pristine.backend.readStoredLog(staged.path, big.id, undefined); } catch (e) { expectedError = e; }
  let actual;
  let actualError;
  try { actual = await patched.backend.readStoredLog(staged.path, big.id, undefined); } catch (e) { actualError = e; }

  if (expectedError !== undefined || actualError !== undefined) {
    check(expectedError !== undefined && actualError !== undefined,
      "round " + round + ": both refuse",
      String(expectedError?.message) + " | " + String(actualError?.message));
  } else {
    // Two comparisons, because they answer different questions.
    //   set   -- the weaker one section 3 uses today; tolerant of recovery latitude.
    //   exact -- what a torn tail should actually produce: the plugin refuses the fast path and
    //            hands the same bytes to the same pristine reader, so the answers must be equal
    //            in order and content, not merely equal as multisets.
    const diffs = compareLogs(expected, actual, { revision: false, order: "set" });
    const exact = compareLogs(expected, actual, { revision: false });
    // Repeatability: read the SAME fixed damaged file again with a fresh instance and require
    // the plugin to give the same answer. If it does not, the answer depends on something other
    // than the input, and a rare gate failure could come from the plugin rather than the fixture.
    const repeatBackend = makePatchedBackend(root, {});
    await repeatBackend.backend.readStoredLog(staged.path, big.id, undefined);
    const repeated = await repeatBackend.backend.readStoredLog(staged.path, big.id, undefined);
    const repeatDiffs = compareLogs(actual, repeated, { revision: false });
    repeatBackend.disposer();
    release(repeated);
    const reasons = JSON.stringify(patched.cache.stats.reasons);
    if (repeatDiffs.length > 0) {
      failures += 1;
      console.log("  FAIL round " + round + " NOT REPEATABLE: " + repeatDiffs.join(" ;; "));
      console.log("       first  " + JSON.stringify(shape(actual)));
      console.log("       second " + JSON.stringify(shape(repeated)));
    }
    if (diffs.length === 0 && exact.length === 0) {
      console.log("  ok   round " + round + ": identical (set and exact)   " + JSON.stringify(shape(expected)) + "  reasons " + reasons);
    } else {
      failures += 1;
      console.log("  FAIL round " + round + ": set=" + diffs.join(" ;; ") + " exact=" + exact.join(" ;; "));
      console.log("       pristine " + JSON.stringify(shape(expected)));
      console.log("       patched  " + JSON.stringify(shape(actual)));
      console.log("       reasons  " + reasons);
      // The differing events themselves. A count cannot be acted on; the event can.
      const left = expected.events.map((e) => JSON.stringify(e)).sort();
      const right = actual.events.map((e) => JSON.stringify(e)).sort();
      const counts = new Map();
      for (const e of left) counts.set(e, (counts.get(e) ?? 0) + 1);
      for (const e of right) counts.set(e, (counts.get(e) ?? 0) - 1);
      for (const [e, n] of counts) {
        if (n === 0) continue;
        console.log("       " + (n > 0 ? "ONLY PRISTINE" : "ONLY PATCHED ") + " x" + Math.abs(n) + "  " + e.slice(0, 300));
      }
      // Key-order differences would make two semantically equal events stringify differently.
      const orderOf = (e) => JSON.stringify(Object.keys(e));
      const pristineKeys = new Set(expected.events.map(orderOf));
      const patchedKeys = new Set(actual.events.map(orderOf));
      console.log("       key orders pristine=" + [...pristineKeys].length + " patched=" + [...patchedKeys].length);
    }
  }
  release(expected, actual);
  pristine.disposer?.();
  patched.disposer();
}

await unlockStage();
console.log("");
console.log("PROBE_TORN_" + (failures === 0 ? "ok" : "FAIL") + " rounds=" + ROUNDS);
process.exit(failures === 0 ? 0 : 1);
