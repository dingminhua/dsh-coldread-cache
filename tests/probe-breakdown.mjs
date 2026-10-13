/**
 * Where does the remaining per-extension time go?
 *
 * The extension path is already ~100 ms on a 55k-event session (down from ~500 ms), but
 * that is still on the one path a host takes every turn. Before optimizing anything
 * else, break the cost down by stage so the next change is aimed at the largest term
 * rather than at whatever looks suspicious in the source.
 *
 * Run: node --expose-gc tests/probe-breakdown.mjs
 */
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { assertReleasedV4Relationships } from "@deepseek-ai/dsh-session-format-v3-to-v4";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import {
  cleanStage, listSessions, makePatchedBackend, nextClosedTurn, prefixEndingAtClosedTurn, release, stage,
  STAGE, unlockStage,
} from "./gate/harness.mjs";

await cleanStage();
const all = await listSessions();
let fixture;
for (const candidate of all) {
  if (candidate.bytes > 60 * 1048576 || candidate.bytes < 8 * 1048576) continue;
  const copy = await stage(candidate.id);
  const closed = await prefixEndingAtClosedTurn(copy.path);
  if (closed === undefined) continue;
  await writeFile(copy.path, closed.bytes);
  fixture = copy;
  break;
}
if (fixture === undefined) { console.log("PROBE_FAIL no appendable fixture"); process.exit(2); }
console.log("fixture: " + Math.round(fixture.bytes / 1048576) + " MB");

const { backend, cache, disposer } = makePatchedBackend(STAGE + "\\sessions", {});
const writer = await backend.open(fixture.id, "write");
let read = await writer.read();
console.log("events:  " + read.events.length);
console.log("resident source: " + Math.round(cache.bytes / 1048576) + " MB\n");

const REPEAT = 6;
const full = [];
for (let turn = 0; turn < REPEAT; turn += 1) {
  const t0 = performance.now();
  await writer.append(nextClosedTurn({ events: read.events }));
  read = await writer.read();
  full.push(performance.now() - t0);
}
full.sort((a, b) => a - b);
const median = full[Math.floor(full.length / 2)];

const entry = cache.get(fixture.id);
const stages = {};

// 1. concat: the O(n) array copy that builds the merged event list.
{
  const t0 = performance.now();
  for (let i = 0; i < REPEAT; i += 1) entry.events.concat([]);
  stages["concat, O(n) array copy"] = (performance.now() - t0) / REPEAT;
}

// 2. the lifecycle walk: the released validator walks EVERY event, not only the new
//    ones, so this is the other O(n) term. The known-type argument is a Set.
{
  const artifact = {
    header: entry.meta,
    inheritedEventCount: entry.inheritedEventCount,
    events: entry.events,
  };
  const t0 = performance.now();
  for (let i = 0; i < REPEAT; i += 1) {
    assertReleasedV4Relationships(artifact, KNOWN_SESSION_EVENT_TYPES);
  }
  stages["assertReleasedV4Relationships, O(n) walk"] = (performance.now() - t0) / REPEAT;
}

// 3. the per-event admission check the plugin also runs, over the whole list.
{
  const t0 = performance.now();
  for (let i = 0; i < REPEAT; i += 1) {
    for (const event of entry.events) if (typeof event.type !== "string") throw new Error("bad");
  }
  stages["full-list scan, O(n) control"] = (performance.now() - t0) / REPEAT;
}

// 4. an O(1) control, to show what is pure loop overhead.
{
  const t0 = performance.now();
  for (let i = 0; i < REPEAT; i += 1) entry.events.length;
  stages["events.length, O(1) control"] = (performance.now() - t0) / REPEAT;
}

console.log("full extension median: " + median.toFixed(1) + " ms\n");
console.log("stage isolation (per call):");
const rows = Object.entries(stages).sort((a, b) => b[1] - a[1]);
for (const [label, ms] of rows) console.log("  " + label.padEnd(40) + ms.toFixed(2) + " ms");
const accounted = rows.reduce((n, pair) => n + pair[1], 0);
console.log("\n  accounted for: " + accounted.toFixed(2) + " of " + median.toFixed(1) + " ms (" +
  Math.round((accounted / median) * 100) + "%)");
console.log("  unaccounted:   " + (median - accounted).toFixed(2) + " ms (stat, read, commit, host)");

await writer.close();
release(read);
disposer();
await unlockStage();
console.log("\nPROBE_BREAKDOWN ok");