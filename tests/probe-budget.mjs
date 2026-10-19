/**
 * How does the byte budget change what residency can actually do?
 *
 * Lowering the default budget looked like a pure win: less heap for the same
 * behaviour. It is not, because a real working set is several sessions of tens of
 * megabytes, and the budget is measured in SOURCE bytes while the sessions are
 * what fill it. A budget smaller than one session degenerates residency to a
 * single entry: every read of a different session evicts the last one, so the
 * append-then-read path never finds its entry and the plugin stops paying off.
 *
 * This replays the access pattern a host actually produces -- read a session, read
 * another, come back, append, read -- against several budgets, and reports the hit
 * rate and the heap each budget implies. The live host is the reason: it showed 68
 * refusals against 12 hits, all classified `no-entry`.
 *
 * Run: node --expose-gc tests/probe-budget.mjs
 */
import { writeFile } from "node:fs/promises";
import {
  cleanStage, listSessions, makePatchedBackend, nextClosedTurn, prefixEndingAtClosedTurn, release, stage,
  STAGE, unlockStage,
} from "./gate/harness.mjs";
import { join } from "node:path";

await cleanStage();
const all = await listSessions();
// A realistic working set: sessions of the size this machine really has.
const working = all.filter((e) => e.bytes > 4 * 1048576 && e.bytes < 40 * 1048576).slice(0, 5);
if (working.length < 4) { console.log("PROBE_FAIL need fixtures"); process.exit(2); }
// Every fixture is cut to a closed turn: the lifecycle validator refuses a
// `turn/start` while a turn is open, and real artifacts routinely end mid-turn.
const staged = [];
for (const entry of working) {
  const copy = await stage(entry.id);
  const cut = await prefixEndingAtClosedTurn(copy.path);
  if (cut === undefined) continue;
  await writeFile(copy.path, cut.bytes);
  staged.push(copy);
}
if (staged.length < 4) { console.log("PROBE_FAIL need closed-turn fixtures"); process.exit(2); }
const totalMB = Math.round(working.reduce((n, e) => n + e.bytes, 0) / 1048576);
console.log("working set: " + working.map((e) => Math.round(e.bytes / 1048576)).join(", ") + " MB  (total " + totalMB + " MB)");

/*
 * The pattern a host really produces: ONE session is being written, and the others
 * are read (history, list, search). The round-robin version of this probe wrote to
 * every session, which made them all rank as "being written" and hid the effect of
 * the ranking -- and the ranking is what decides whether a small budget is enough.
 */
async function run(maxResidentBytes, maxEntries) {
  const patched = await makePatchedBackend(join(STAGE, "sessions"), { maxResidentBytes, maxEntries });
  const active = staged[0];
  const bystanders = staged.slice(1);
  const writer = await patched.backend.open(active.id, "write");
  let extensions = 0;
  let turns = 0;
  for (let turn = 0; turn < 10; turn += 1) {
    // Bystander traffic between turns: what browsing history does.
    for (const s of bystanders) {
      const handle = await patched.backend.open(s.id, "read");
      await handle.read();
      await handle.close();
    }
    const read = await writer.read();
    const before = patched.cache.stats.extensions;
    await writer.append(nextClosedTurn({ events: read.events }));
    await writer.read();
    if (patched.cache.stats.extensions > before) extensions += 1;
    turns += 1;
    release(read);
  }
  await writer.close();
  const stats = { ...patched.cache.stats };
  const entries = patched.cache.size;
  const bytes = patched.cache.bytes;
  patched.disposer();
  return { stats, entries, bytes, extensions, turns };
}

console.log("\npattern: 1 written session, " + (staged.length - 1) + " read-only bystanders, 10 turns");
console.log("budget      entries  resident        extensions/turns  cold  refusals  hit-rate");
const budgets = [16, 32, 64, 128, 256].map((mb) => mb * 1048576);
for (const budget of budgets) {
  const r = await run(budget, 8);
  const refusals = r.stats.fallbacks;
  const rate = ((r.stats.hits / Math.max(1, r.stats.hits + refusals)) * 100).toFixed(0) + "%";
  console.log(
    ((budget / 1048576) + "MB").padEnd(12) + String(r.entries).padEnd(9) +
    (Math.round(r.bytes / 1048576) + "MB").padEnd(18) + (r.extensions + "/" + r.turns).padEnd(18) +
    String(r.stats.coldParses).padEnd(6) + String(refusals).padEnd(11) + rate,
  );
}

console.log("\nheap at the measured ~8x ratio: " + budgets.map((b) => (b / 1048576) * 8 + "MB").join(", "));
await unlockStage();
console.log("\nPROBE_BUDGET ok");