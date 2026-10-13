/**
 * The regression probe for the per-turn freeze cost.
 *
 * The extension path used to deep-freeze the WHOLE session on every turn, so the
 * cost grew linearly with the session (measured 191.7 ms per turn at 60k events,
 * about 19 s over a 100-turn session). The fix is that an already-frozen root stops
 * the walk, because a frozen root means the whole graph is frozen.
 *
 * This measures both sides, so it is a real regression test rather than a record of
 * a past number: if the short-circuit is removed, the "already frozen" case
 * collapses back to a full walk and the assertion fails. The unfrozen case is
 * included to show the walk it is avoiding is genuinely expensive.
 *
 * Run: node tests/probe-extension-cost.mjs
 */
import { readFile } from "node:fs/promises";
import { listSessions } from "./gate/harness.mjs";
import { scanZstdFrames, decodeFrames, LiveLogReader, freezeStoredEvent } from "../lib/pristine.js";

const all = await listSessions();
const target = all.find((e) => e.bytes > 50 * 1048576 && e.bytes < 100 * 1048576);
if (target === undefined) { console.log("PROBE_FAIL no large fixture"); process.exit(2); }
const buffer = await readFile(target.path);
const scanned = scanZstdFrames(buffer);
const chunks = decodeFrames(buffer, scanned.frames);
const reader = new LiveLogReader(chunks[0]);
for (let index = 1; index < chunks.length; index += 1) reader.write(chunks[index]);
const events = reader.artifact().events;
const n = events.length;
console.log("events: " + n);

const time = (label, fn, rounds = 10) => {
  fn();
  const times = [];
  for (let i = 0; i < rounds; i += 1) {
    const started = performance.now();
    fn();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(rounds / 2)];
  console.log("  " + label.padEnd(50) + median.toFixed(2) + " ms");
  return median;
};

// A pristine, fully-frozen list, exactly as the extension path leaves one.
const frozen = events.slice();
for (const event of frozen) freezeStoredEvent(event);
Object.freeze(frozen);

console.log("per turn at " + n + " events:");

/*
 * One full unfrozen copy is built BEFORE timing. The copy means a JSON round-trip,
 * and timing that alongside the freeze would attribute serialization cost to
 * freezing -- a projection from a 4000-event sample was tried first and disagreed
 * with a direct measurement (345 ms projected vs 192 ms measured), which is why
 * this measures the real full list instead of scaling a sample.
 */
const unfrozen = JSON.parse(JSON.stringify(frozen));

const timeOnce = (label, fn) => {
  const started = performance.now();
  fn();
  const ms = performance.now() - started;
  console.log("  " + label.padEnd(52) + ms.toFixed(1) + " ms");
  return ms;
};

// The work the fix avoids: a deep walk of the full graph while it is still open.
const coldWalk = timeOnce("deep-freeze the whole session, unfrozen (before)", () => {
  for (const event of unfrozen) freezeStoredEvent(event);
});
// The work it does now: the root is already frozen, so the walk must not start.
const warmWalk = timeOnce("re-freeze the same session, already frozen (now)", () => {
  for (const event of frozen) freezeStoredEvent(event);
});

console.log("\nsaved per turn: ~" + (coldWalk - warmWalk).toFixed(1) + " ms");
console.log("over a 100-turn session: ~" + (((coldWalk - warmWalk) * 100) / 1000).toFixed(1) + " s");

// The assertion: an already-frozen graph must be effectively free. A real full walk
// costs hundreds of ms, so a 20 ms ceiling cannot pass by accident.
const CEILING_MS = 20;
const ok = warmWalk < CEILING_MS && coldWalk > 100;
if (!ok) {
  console.log("\nPROBE_FAIL the short-circuit is gone: re-freezing an already-frozen list took " +
    warmWalk.toFixed(1) + " ms (ceiling " + CEILING_MS + " ms; a real full walk is " + coldWalk.toFixed(1) + " ms)");
  process.exit(1);
}
console.log("\nPROBE_EXTCOST ok warm=" + warmWalk.toFixed(1) + "ms cold=" + coldWalk.toFixed(1) + "ms");