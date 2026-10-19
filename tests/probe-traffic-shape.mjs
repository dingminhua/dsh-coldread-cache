/**
 * Reproduce the live host's configuration and read pattern exactly.
 *
 * The running host reported extensions=0 while ten sessions were being written. Two
 * candidate causes were ruled out by measurement: the write-handle branch (the host's
 * own append-then-read loop DOES extend residency) and the byte budget (a 32MB budget
 * still extended 9 times in 10 turns on 35MB sessions). What is left is the shape of
 * the traffic: how often a host actually READS a session right after appending to it.
 *
 * This measures residency behaviour across several traffic shapes so the live numbers
 * can be interpreted instead of guessed at.
 *
 * Run: node --expose-gc tests/probe-traffic-shape.mjs
 */
import { writeFile } from "node:fs/promises";
import {
  cleanStage, listSessions, makePatchedBackend, nextClosedTurn, prefixEndingAtClosedTurn, release, stage,
  STAGE, unlockStage,
} from "./gate/harness.mjs";
import { join } from "node:path";

await cleanStage();
const all = await listSessions();
const cut = [];
for (const candidate of all) {
  if (cut.length >= 5) break;
  if (candidate.bytes > 60 * 1048576 || candidate.bytes < 2 * 1048576) continue;
  const copy = await stage(candidate.id);
  const closed = await prefixEndingAtClosedTurn(copy.path);
  if (closed === undefined) continue;
  await writeFile(copy.path, closed.bytes);
  cut.push(copy);
}
if (cut.length < 4) { console.log("PROBE_FAIL need fixtures"); process.exit(2); }
const active = cut[0];
const others = cut.slice(1);
const totalMB = Math.round(cut.reduce((n, c) => n + c.bytes, 0) / 1048576);
console.log("fixtures: " + cut.map((c) => Math.round(c.bytes / 1048576)).join(", ") + " MB  (total " + totalMB + " MB)");

const snap = (cache) => ({ ...cache.stats });

/** Shape A: the host appends and immediately reads the SAME session (the A/B model). */
async function appendThenReadSameSession(budget) {
  const patched = await makePatchedBackend(join(STAGE, "sessions"), { maxResidentBytes: budget });
  const writer = await patched.backend.open(active.id, "write");
  let read = await writer.read();
  const before = snap(patched.cache);
  for (let turn = 0; turn < 8; turn += 1) {
    await writer.append(nextClosedTurn({ events: read.events }));
    read = await writer.read();
  }
  const after = snap(patched.cache);
  await writer.close();
  patched.disposer();
  release(read);
  return { ext: after.extensions - before.extensions, cold: after.coldParses - before.coldParses };
}

/** Shape B: the host appends, and reads OTHER sessions before coming back. */
async function appendThenReadOtherSessions(budget) {
  const patched = await makePatchedBackend(join(STAGE, "sessions"), { maxResidentBytes: budget });
  const writer = await patched.backend.open(active.id, "write");
  let read = await writer.read();
  const before = snap(patched.cache);
  for (let turn = 0; turn < 8; turn += 1) {
    await writer.append(nextClosedTurn({ events: read.events }));
    for (const other of others) {
      const handle = await patched.backend.open(other.id, "read");
      await handle.read();
      await handle.close();
    }
    read = await writer.read();
  }
  const after = snap(patched.cache);
  await writer.close();
  patched.disposer();
  release(read);
  return { ext: after.extensions - before.extensions, cold: after.coldParses - before.coldParses };
}

/** Shape C: the host only ever READS sessions; nothing is appended to. */
async function readOnly() {
  const patched = await makePatchedBackend(join(STAGE, "sessions"), { maxResidentBytes: 128 * 1048576 });
  const before = snap(patched.cache);
  for (let round = 0; round < 3; round += 1) {
    for (const c of cut) {
      const handle = await patched.backend.open(c.id, "read");
      await handle.read();
      await handle.close();
    }
  }
  const after = snap(patched.cache);
  patched.disposer();
  return { ext: after.extensions - before.extensions, cold: after.coldParses - before.coldParses };
}

const rows = [
  ["A. append + read the same session (32MB)", await appendThenReadSameSession(32 * 1048576)],
  ["A. append + read the same session (128MB)", await appendThenReadSameSession(128 * 1048576)],
  ["B. append + read 4 others first (32MB)", await appendThenReadOtherSessions(32 * 1048576)],
  ["B. append + read 4 others first (128MB)", await appendThenReadOtherSessions(128 * 1048576)],
  ["C. read-only, nothing appended", await readOnly()],
];
console.log("\nshape                                         extensions  cold parses");
for (const [label, r] of rows) {
  console.log("  " + label.padEnd(44) + String(r.ext).padEnd(12) + r.cold);
}

// The finding: the plugin's benefit is entirely a function of whether the host reads
// a session right after appending to it. If shape C is what a host mostly does, then
// extensions stay near zero no matter how the plugin is tuned -- and the honest
// reading of a live ext=0 is "this host does not exercise the fast path often",
// which is a statement about the traffic, not a defect in the cache.
console.log("\nPROBE_TRAFFIC ok");
await unlockStage();