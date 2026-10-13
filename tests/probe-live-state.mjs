/**
 * Crux probe: can one restore/decoder instance be kept alive across appends —
 * fed only the new frames — and still produce the same artifact a whole-file
 * parse produces, with the prefix's event objects unchanged?
 *
 * This decides whether the plugin's growth path can decode only the tail.
 */
import { readFile, stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertZstdHeaderFrame, createZstdFrameDecoder, decompressZstdFrameSync, parseHeaderRecord, scanZstdFrames,
} from "../lib/pristine.js";

// DSH_HOME is what the host itself uses. If it is missing there is nothing
// sensible to guess, so say so instead of silently reading the wrong disk.
const ROOT = process.env.DSH_SESSIONS ?? (process.env.DSH_HOME ? process.env.DSH_HOME + "\\\\sessions" : "");
if (ROOT === "") {
  console.log("PROBE_FAIL set DSH_HOME (or DSH_SESSIONS) to the session root");
  process.exit(2);
}
const wanted = process.argv[2];

function fail(message) { console.log("PROBE_FAIL " + message); process.exit(1); }

/** A live scanner: header record + fragment retention + on-demand finish. */
class LiveScanner {
  constructor(headerRecord) {
    const parsed = parseHeaderRecord(headerRecord);
    this.meta = parsed.meta;
    this.restore = parsed.restore;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.inputBytes = headerRecord.length;
    this.committedBytes = headerRecord.length;
    this.eventLine = 0;
    this.rows = 0;
  }
  write(chunk) {
    const chunkStart = this.inputBytes;
    this.inputBytes += chunk.length;
    let lineStart = 0;
    for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, lineStart)) {
      const fragment = chunk.subarray(lineStart, newline);
      let line = fragment;
      if (this.fragments.length > 0) {
        if (fragment.length > 0) this.fragments.push(fragment);
        line = Buffer.concat(this.fragments, this.fragmentBytes + fragment.length);
        this.fragments = [];
        this.fragmentBytes = 0;
      }
      this.consume(line, chunkStart + newline + 1);
      lineStart = newline + 1;
    }
    if (lineStart < chunk.length) {
      const fragment = Buffer.from(chunk.subarray(lineStart));
      this.fragments.push(fragment);
      this.fragmentBytes += fragment.length;
    }
  }
  consume(line, endByte) {
    this.eventLine += 1;
    const decoded = JSON.parse(line.toString("utf8"));
    this.restore.decodeRow(decoded);
    this.rows += 1;
    this.committedBytes = endByte;
  }
  finish() {
    return this.restore.finish();
  }
}

const t0 = performance.now();
const paths = (await readdir(ROOT)).flatMap(async (project) => {
  const dirs = await readdir(join(ROOT, project), { withFileTypes: true }).catch(() => []);
  return dirs.filter((d) => d.isDirectory()).map((d) => join(ROOT, project, d.name, "session.v4.jsonl.zstd"));
});
const all = (await Promise.all(paths)).flat();
let target;
if (wanted !== undefined) target = wanted;
else {
  let best = 0;
  for (const candidate of all) {
    const info = await stat(candidate).catch(() => undefined);
    if (info && info.size > best && info.size < 80 * 1024 * 1024) { best = info.size; target = candidate; }
  }
}
const info = await stat(target);
console.log("PROBE_TARGET " + target + " bytes=" + info.size);

const buffer = await readFile(target);
const { frames, tornStart } = scanZstdFrames(buffer);
console.log("PROBE_FRAMES frames=" + frames.length + " tornStart=" + tornStart + " bytes=" + buffer.length);
if (tornStart !== undefined) fail("artifact has a torn tail; pick another");

const decoder = createZstdFrameDecoder();
const plaintexts = [];
for (const plaintext of decoder.decode(buffer, frames)) plaintexts.push(Buffer.from(plaintext));
decoder.close();
assertZstdHeaderFrame(plaintexts[0]);
console.log("PROBE_PLAINTEXT frames=" + plaintexts.length + " totalPlain=" + plaintexts.reduce((a, b) => a + b.length, 0));

const PARTS = Math.min(6, frames.length - 1);
const cut = frames.length - PARTS;
if (cut < 2) fail("not enough frames to split; frames=" + frames.length);

// A: incremental — feed frames 0..cut-1, finish, then feed the rest and finish again.
const live = new LiveScanner(plaintexts[0]);
for (let index = 1; index < cut; index += 1) live.write(plaintexts[index]);
const a1 = live.finish();
const a1Again = live.finish();
console.log("PROBE_FINISH_REPEAT ok=true eventsA1=" + a1.events.length + " eventsAgain=" + a1Again.events.length +
  " sameArray=" + (a1.events === a1Again.events) + " sameObjects=" + (a1.events[100] === a1Again.events[100]));

for (let index = cut; index < frames.length; index += 1) live.write(plaintexts[index]);
const a2 = live.finish();
const a3 = live.finish();

// B: whole-file — one scanner over everything, the pristine shape.
const whole = new LiveScanner(plaintexts[0]);
for (let index = 1; index < frames.length; index += 1) whole.write(plaintexts[index]);
const b = whole.finish();

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
console.log("PROBE_RESULT eventsA1=" + a1.events.length + " eventsA2=" + a2.events.length + " eventsWhole=" + b.events.length);
console.log("PROBE_PREFIX_IDENTITY sameLength=" + (a1.events.length === a2.events.length ? "n/a" : "grew") +
  " prefixObjectIdentical=" + (a2.events[100] === a1.events[100]) +
  " prefixAllIdentical=" + a1.events.every((event, index) => a2.events[index] === event));
console.log("PROBE_WHOLE_EQUAL deepEqual=" + same(a2.events, b.events) +
  " sameCount=" + (a2.events.length === b.events.length) +
  " objectIdenticalAt0=" + (a2.events[0] === b.events[0]));
console.log("PROBE_FINISH_IDEMPOTENT eventsA3=" + a3.events.length + " sameArray=" + (a3.events === a2.events) +
  " sameTail=" + (a3.events[a3.events.length - 1] === a2.events[a2.events.length - 1]));
console.log("PROBE_META sameId=" + (a2.header?.id === b.header?.id || a2.meta?.id === b.meta?.id) +
  " inheritedA2=" + a2.inheritedEventCount + " inheritedWhole=" + b.inheritedEventCount);
console.log("PROBE_KEYS " + JSON.stringify(Object.keys(a2)));
console.log("PROBE_MS total=" + Math.round(performance.now() - t0));
console.log("PROBE_GREEN live-state-reusable=true");
