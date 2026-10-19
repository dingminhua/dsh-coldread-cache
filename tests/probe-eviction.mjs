/**
 * Does the residency survive a busy host, or is it evicted before it can pay off?
 *
 * The status file from a real running host reported extensions=0 with every
 * fallback classified `no-entry`: it cold-parsed 369 times, served 405 reads from
 * residency, and never once extended a resident parse. That is the one case the
 * plugin exists for, so this reproduces the interleaving that causes it.
 *
 * The shape is the host's own: one session is being appended to across turns,
 * while a busy session list and history view read many OTHER sessions in between.
 * Those bystander reads are cold parses, and a cold parse is what evicts.
 *
 * Run: node --expose-gc tests/probe-eviction.mjs
 */
import { cleanStage, listSessions, makePatchedBackend, nextClosedTurn, release, stage, STAGE, unlockStage } from "./gate/harness.mjs";
import { join } from "node:path";

await cleanStage();
const all = await listSessions();
const bystanders = all.filter((e) => e.bytes > 65536 && e.bytes < 6 * 1048576).slice(0, 16);
const active = all.find((e) => e.bytes > 4 * 1048576 && e.bytes < 40 * 1048576);
if (active === undefined || bystanders.length < 12) { console.log("PROBE_FAIL need fixtures"); process.exit(2); }

const attempt = await stage(active.id);
const staged = [];
for (const b of bystanders) staged.push(await stage(b.id));

const { backend, cache, disposer } = await makePatchedBackend(join(STAGE, "sessions"), { maxEntries: 4, maxResidentBytes: 32 * 1048576 });
console.log("active " + active.id.slice(0, 13) + ", " + staged.length + " bystanders, maxEntries=4");

const writer = await backend.open(active.id, "write");
let read = await writer.read();
let events = read.events;

// Turn 1: append and read back -- the extension the plugin promises.
await writer.append(nextClosedTurn({ events }));
read = await writer.read();
events = read.events;
const afterFirst = cache.stats.extensions;
console.log("turn 1: ext=" + cache.stats.extensions + " (expect 1)");

// Between turns the host reads other sessions: history, list, search.
for (let round = 0; round < 4; round += 1) {
  for (const s of staged) {
    const h = await backend.open(s.id, "read");
    await h.read();
    await h.close();
  }
}
console.log("after " + (staged.length * 4) + " bystander reads: resident=" + cache.size + "/" + Math.round(cache.bytes / 1048576) + "MB");

// Turn 2: the session was appended to again while the reader was away.
await writer.append(nextClosedTurn({ events }));
read = await writer.read();
events = read.events;
const afterSecond = cache.stats.extensions;
console.log("turn 2: ext=" + cache.stats.extensions + " (expect 2)");

await writer.close();
disposer();
await unlockStage();

const ok = afterFirst === 1 && afterSecond === 2;
console.log("\nreasons=" + JSON.stringify(cache.stats.reasons));
console.log("PROBE_" + (ok ? "SURVIVED" : "EVICTED") + " first=" + afterFirst + " second=" + afterSecond);
process.exit(ok ? 0 : 1);