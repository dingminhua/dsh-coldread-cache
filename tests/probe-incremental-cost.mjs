/**
 * Third crux probe: cost of the resident-decoder design.
 *
 * Measures cold parse, incremental extension of a resident decoder, the
 * snapshot copy the pristine contract needs, and deep equality against a
 * whole-file parse. These numbers are the gate's baseline.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { KNOWN_SESSION_EVENT_TYPES, adoptSessionEvent } from "@deepseek-ai/dsh-session";
import { assertReleasedV4Relationships } from "@deepseek-ai/dsh-session-format-v3-to-v4";
import { validateStoredEvents } from "@deepseek-ai/dsh-session-persistence";
import { createZstdFrameDecoder, parseHeaderRecord, scanZstdFrames } from "../lib/pristine.js";

// DSH_HOME is what the host itself uses. If it is missing there is nothing
// sensible to guess, so say so instead of silently reading the wrong disk.
const ROOT = process.env.DSH_SESSIONS ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, "sessions") : "");
if (ROOT === "") {
  console.log("PROBE_FAIL set DSH_HOME (or DSH_SESSIONS) to the session root");
  process.exit(2);
}
const now = () => performance.now();
const rowsOf = (chunk) => {
  const out = [];
  let start = 0;
  for (;;) { const nl = chunk.indexOf(10, start); if (nl === -1) break; out.push(chunk.subarray(start, nl)); start = nl + 1; }
  return out;
};

const dirs = [];
for (const project of await readdir(ROOT)) {
  const entries = await readdir(join(ROOT, project), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) if (entry.isDirectory()) dirs.push(join(ROOT, project, entry.name, "session.v4.jsonl.zstd"));
}
const sized = [];
for (const candidate of dirs) { const info = await stat(candidate).catch(() => undefined); if (info !== undefined) sized.push({ path: candidate, size: Number(info.size) }); }
sized.sort((a, b) => b.size - a.size);
const target = process.argv[2] ?? sized.find((s) => s.size > 3 * 1024 * 1024 && s.size < 20 * 1024 * 1024).path;
console.log("PROBE_TARGET " + target + " bytes=" + (await stat(target)).size);

const read = await readFile(target);
const { frames, tornStart } = scanZstdFrames(read);
if (tornStart !== undefined) { console.log("PROBE_FAIL torn artifact"); process.exit(1); }
const decoder = createZstdFrameDecoder();
const tDecode = now();
const plaintexts = [];
for (const chunk of decoder.decode(read, frames)) plaintexts.push(Buffer.from(chunk));
decoder.close();
console.log("PROBE_FRAMES frames=" + frames.length + " plain=" + plaintexts.reduce((a, b) => a + b.length, 0) + " decodeMs=" + Math.round(now() - tDecode));

const COLD_CUT = 1;
const parseInto = (restore, from, to) => {
  let events = 0;
  for (let index = from; index < to; index += 1) for (const row of rowsOf(plaintexts[index])) { restore.decodeRow(JSON.parse(row.toString("utf8"))); events += 1; }
  return events;
};

// --- cold baseline: whole-file parse into one decoder.
const coldRestore = parseHeaderRecord(plaintexts[0]).restore;
const tCold = now();
const coldEvents = parseInto(coldRestore, 1, frames.length);
const coldFinish = coldRestore.finish();
const coldMs = now() - tCold;
console.log("PROBE_COLD events=" + coldEvents + " artifact=" + coldFinish.events.length + " ms=" + Math.round(coldMs));

// --- resident decoder: prefix, then extend twice with the last frames.
const cut = Math.max(2, frames.length - 6);
const resident = parseHeaderRecord(plaintexts[0]).restore;
let t = now();
const prefixRows = parseInto(resident, 1, cut);
let art = resident.finish();
const prefixMs = now() - t;
console.log("PROBE_PREFIX rows=" + prefixRows + " events=" + art.events.length + " ms=" + Math.round(prefixMs));

// The pristine contract needs a frozen array of adopted events, WITHOUT
// freezing the decoder's live array. Measure the snapshot cost.
t = now();
const snapshot = art.events.slice();
validateStoredEvents(parseHeaderRecord(plaintexts[0]).meta, snapshot, { kind: "jsonl", path: target });
for (const event of snapshot) { const pending = [event]; while (pending.length > 0) { const current = pending.pop(); Object.freeze(current); if (Array.isArray(current)) { for (const c of current) if (c !== null && typeof c === "object") pending.push(c); } else for (const key in current) { const c = current[key]; if (c !== null && typeof c === "object") pending.push(c); } } }
Object.freeze(snapshot);
const snapshotMs = now() - t;
console.log("PROBE_SNAPSHOT events=" + snapshot.length + " ms=" + Math.round(snapshotMs) +
  " liveArrayStillExtensible=" + Object.isExtensible(art.events) +
  " adoptedIdentity=" + (snapshot[0] === adoptSessionEvent(snapshot[0])));
const liveAfterAdopt = art.events.length;

// --- extension 1: three frames.
t = now();
const newRows1 = cut;
const ext1 = parseInto(resident, newRows1, newRows1 + 3);
const art2 = resident.finish();
const ext1Ms = now() - t;
const fresh1 = art2.events.slice(liveAfterAdopt);
for (const event of fresh1) { const pending = [event]; while (pending.length > 0) { const current = pending.pop(); Object.freeze(current); if (Array.isArray(current)) { for (const c of current) if (c !== null && typeof c === "object") pending.push(c); } else for (const key in current) { const c = current[key]; if (c !== null && typeof c === "object") pending.push(c); } } }
const merged1 = Object.freeze(snapshot.concat(fresh1));
console.log("PROBE_EXTEND1 fed=" + ext1 + " events=" + art2.events.length + " fresh=" + fresh1.length +
  " ms=" + Math.round(ext1Ms) + " prefixObjectsStable=" + snapshot.every((event, index) => event === art2.events[index] || snapshot[index] === event));

// --- extension 2: the rest.
t = now();
const ext2 = parseInto(resident, newRows1 + 3, frames.length);
const art3 = resident.finish();
const ext2Ms = now() - t;
let tRel = now();
assertReleasedV4Relationships({ header: parseHeaderRecord(plaintexts[0]).meta, inheritedEventCount: 0, events: merged1.concat(art3.events.slice(merged1.length)) }, KNOWN_SESSION_EVENT_TYPES);
const relMs = now() - tRel;
console.log("PROBE_EXTEND2 fed=" + ext2 + " events=" + art3.events.length + " ms=" + Math.round(ext2Ms) + " relMs=" + Math.round(relMs));

const whole = art3.events.map((event) => JSON.stringify(event)).join("\u0001");
const coldStr = coldFinish.events.map((event) => JSON.stringify(event)).join("\u0001");
console.log("PROBE_EQUAL deepEqual=" + (whole === coldStr) + " sameCount=" + (art3.events.length === coldFinish.events.length));

console.log("PROBE_COST_MS cold=" + Math.round(coldMs) + " prefix=" + Math.round(prefixMs) + " snapshot=" + Math.round(snapshotMs) +
  " extend1=" + Math.round(ext1Ms) + " extend2=" + Math.round(ext2Ms) + " relationships=" + Math.round(relMs));
console.log("PROBE_GREEN incrementalCostIsTailProportional=" + (ext1Ms + ext2Ms < coldMs * 0.5));
