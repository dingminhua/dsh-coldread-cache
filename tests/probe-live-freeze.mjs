/**
 * Second crux probe. The pristine tail freezes the decoder artifact's event
 * ARRAY in place (freezeStoredEvents). If that array is the collector's live
 * array, then a resident decoder can never append again. Measure it.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { adoptSessionEvent } from "@deepseek-ai/dsh-session";
import { validateStoredEvents } from "@deepseek-ai/dsh-session-persistence";
import { createZstdFrameDecoder, parseHeaderRecord, scanZstdFrames } from "../lib/pristine.js";

// DSH_HOME is what the host itself uses. If it is missing there is nothing
// sensible to guess, so say so instead of silently reading the wrong disk.
const ROOT = process.env.DSH_SESSIONS ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, "sessions") : "");
if (ROOT === "") {
  console.log("PROBE_FAIL set DSH_HOME (or DSH_SESSIONS) to the session root");
  process.exit(2);
}

const dirs = [];
for (const project of await readdir(ROOT)) {
  const entries = await readdir(join(ROOT, project), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) if (entry.isDirectory()) dirs.push(join(ROOT, project, entry.name, "session.v4.jsonl.zstd"));
}
const sized = [];
for (const candidate of dirs) {
  const info = await stat(candidate).catch(() => undefined);
  if (info !== undefined) sized.push({ path: candidate, size: Number(info.size) });
}
sized.sort((a, b) => b.size - a.size);
const target = sized.find((s) => s.size > 3 * 1024 * 1024 && s.size < 20 * 1024 * 1024);
console.log("PROBE_TARGET " + target.path + " bytes=" + target.size);

const buffer = await readFile(target.path);
const { frames, tornStart } = scanZstdFrames(buffer);
if (tornStart !== undefined) { console.log("PROBE_FAIL torn artifact"); process.exit(1); }
const decoder = createZstdFrameDecoder();
const plaintexts = [];
for (const chunk of decoder.decode(buffer, frames)) plaintexts.push(Buffer.from(chunk));
decoder.close();
console.log("PROBE_FRAMES frames=" + frames.length + " plain=" + plaintexts.reduce((a, b) => a + b.length, 0));

const parsed = parseHeaderRecord(plaintexts[0]);
const restore = parsed.restore;
const cut = Math.max(2, frames.length - 3);
const feed = (from, to) => { for (let i = from; i < to; i += 1) {
  // decodeRow needs one row at a time: split the frame plaintext on newlines.
  const chunk = plaintexts[i];
  let start = 0;
  for (;;) {
    const nl = chunk.indexOf(10, start);
    if (nl === -1) break;
    restore.decodeRow(JSON.parse(chunk.subarray(start, nl).toString("utf8")));
    start = nl + 1;
  }
} };

feed(1, cut);
const a1 = restore.finish();
console.log("PROBE_A1 events=" + a1.events.length + " artifactKeys=" + JSON.stringify(Object.keys(a1)));

// The pristine tail, applied to this artifact exactly as decodeStoredLog does.
const pristineAdopt = (events) => {
  const meta = parsed.meta;
  validateStoredEvents(meta, events, { kind: "jsonl", path: target.path });
  for (const event of events) {
    for (const pending of [event]) { Object.freeze(pending); }
  }
  Object.freeze(events);
};
const sameIdentity = a1.events.some((event, index) => adoptSessionEvent(event) === event);
console.log("PROBE_ADOPT_IDENTITY anySame=" + sameIdentity);

pristineAdopt(a1.events);
console.log("PROBE_FROZEN arrayFrozen=" + Object.isFrozen(a1.events) + " elementFrozen=" + Object.isFrozen(a1.events[0]));

let appended = "none";
try {
  feed(cut, frames.length);
  appended = "ok";
} catch (error) {
  appended = "threw:" + (error instanceof Error ? error.message : String(error)).slice(0, 120);
}
console.log("PROBE_APPEND_AFTER_FREEZE " + appended);

if (appended === "ok") {
  let a2 = null;
  try { a2 = restore.finish(); } catch (error) { console.log("PROBE_FINISH_AFTER_FREEZE threw:" + String(error).slice(0, 140)); }
  if (a2 !== null) {
    console.log("PROBE_A2 events=" + a2.events.length + " sameArray=" + (a2.events === a1.events));
    // B: fresh whole-file decoder for comparison.
    const whole = parseHeaderRecord(plaintexts[0]).restore;
    let s = 0;
    for (let i = 1; i < frames.length; i += 1) {
      const chunk = plaintexts[i];
      s = 0;
      for (;;) { const nl = chunk.indexOf(10, s); if (nl === -1) break; whole.decodeRow(JSON.parse(chunk.subarray(s, nl).toString("utf8"))); s = nl + 1; }
    }
    const b = whole.finish();
    console.log("PROBE_WHOLE events=" + b.events.length +
      " deepEqual=" + (JSON.stringify(a2.events) === JSON.stringify(b.events)) +
      " prefixSame=" + (a2.events.length >= a1.events.length));
  }
}
console.log("PROBE_DONE");
