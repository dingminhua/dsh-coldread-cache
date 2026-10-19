/**
 * Does a host's own write-then-read loop actually take the fast path?
 *
 * The live host reported extensions=0 while ten sessions were being appended to, and
 * the backend's JsonlSessionHandle.read() has a branch that made this worth checking
 * (lib/index.js:69): when a write handle still holds its `primed` snapshot it answers
 * from memory without touching storage, so those reads might never reach the plugin.
 * If that were what a host does on every turn, the plugin's real benefit would be
 * smaller than the A/B implies.
 *
 * It is not what happens: the loop is measured here across the exact sequence a host
 * uses -- open a write handle, append, read back -- and it takes the fast path. That
 * rules the branch out as the cause and is worth keeping as a probe, because it is
 * the one sequence the whole plugin is built around.
 *
 * Run: node --expose-gc tests/probe-write-handle.mjs
 */
import { cleanStage, listSessions, makePatchedBackend, nextClosedTurn, release, stage, STAGE, unlockStage } from "./gate/harness.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

await cleanStage();
const all = await listSessions();
const big = all.find((e) => e.bytes > 4 * 1048576 && e.bytes < 40 * 1048576);
if (big === undefined) { console.log("PROBE_FAIL"); process.exit(2); }
const staged = await stage(big.id);
const { prefixEndingAtClosedTurn } = await import("./gate/harness.mjs");
const cut = await prefixEndingAtClosedTurn(staged.path);
if (cut === undefined) { console.log("PROBE_FAIL no closed turn"); process.exit(2); }
await writeFile(staged.path, cut.bytes);

const { backend, cache, disposer } = await makePatchedBackend(join(STAGE, "sessions"), {});
const snap = () => ({ hits: cache.stats.hits, ext: cache.stats.extensions, cold: cache.stats.coldParses });

// A write handle, exactly as a host holds one for the session it is driving.
const writer = await backend.open(big.id, "write");
let read = await writer.read();
const opened = snap();
console.log("after open(write)+read:      " + JSON.stringify(opened) + "  (the read populated residency)");

// Three turns of the host's own loop: append, then read back through the SAME handle.
for (let turn = 0; turn < 3; turn += 1) {
  await writer.append(nextClosedTurn({ events: read.events }));
  read = await writer.read();
}
const viaWrite = snap();
console.log("after 3 append+read (write): " + JSON.stringify(viaWrite));
console.log("  -> cold parses added: " + (viaWrite.cold - opened.cold) + ", extensions added: " + (viaWrite.ext - opened.ext));

// Now the same session read through a SEPARATE read handle, which is what a UI
// reopen, a second reader, or a fresh process does.
const reader = await backend.open(big.id, "read");
await reader.read();
await reader.close();
const viaRead = snap();
console.log("after a separate read handle: " + JSON.stringify(viaRead));
console.log("  -> extensions added: " + (viaRead.ext - viaWrite.ext));

await writer.close();
disposer();
await unlockStage();

// The finding, which was NOT what the first version of this probe expected. The
// write-handle loop DOES extend residency (3 extensions, 0 cold parses), so a host
// that appends and reads back through its own handle takes the fast path. The
// separate read handle afterwards adds NO extension, because the artifact had not
// grown since -- it is served as a residency hit instead, which is the other half of
// the same design.
//
// So the live host's extensions=0 was not caused by the write-handle branch, and
// the probe now asserts the real behaviour on both sides: a growth is extended, and
// a read of an unchanged artifact is served without any new decode at all.
const writeLoopExtended = viaWrite.ext > opened.ext;
const writeLoopColdParsed = viaWrite.cold > opened.cold;
const separateReadWasHit = viaRead.hits > viaWrite.hits;
const separateReadColdParsed = viaRead.cold > viaWrite.cold;
console.log("\nwrite-handle loop extended residency: " + writeLoopExtended + "  (expected true)");
console.log("write-handle loop cold parsed:        " + writeLoopColdParsed + "  (expected false)");
console.log("separate read handle was a hit:       " + separateReadWasHit + "  (expected true)");
console.log("separate read handle cold parsed:     " + separateReadColdParsed + "  (expected false)");
const ok = writeLoopExtended && !writeLoopColdParsed && separateReadWasHit && !separateReadColdParsed;
console.log(ok ? "\nPROBE_WRITEHANDLE ok" : "\nPROBE_WRITEHANDLE FAIL");
process.exit(ok ? 0 : 1);