/**
 * Attribute the plugin's COLD read, stage by stage, and prove which stage is the regression.
 *
 * Measured: the patched cold read is 4107 ms against pristine's 2506 ms on a 62 MB artifact.
 * The plugin is 1.6x SLOWER on the one path a user actually triggers when opening a session
 * from history. Two suspects were identified by reading the code:
 *
 *   1. lib/pristine.js decodeFrames uses the PUBLIC one-shot zstdDecompressSync per frame,
 *      while upstream's backend picks NodePrivateZstdFrameDecoder (reused native context).
 *      Measured separately at 2.9x.
 *   2. LiveLogReader.write() runs chunk.indexOf(10) per chunk, and the cold path feeds it
 *      16665 separate frame buffers, so the newline scan restarts per frame.
 *
 * This probe times each stage of the plugin's OWN cold path by calling the real primitives in
 * the same order coldRead does, then reports the sum against the real cold read. It also tests
 * the two candidate fixes in isolation so the plan rests on measurement:
 *
 *   - decodeFramesPublic vs a reused-context decode, on identical input
 *   - writeManyFrames vs one concatenated buffer, on identical plaintext
 *
 * Run: node --expose-gc --max-old-space-size=12288 tests/probe-cold-attribution.mjs
 */
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { createZstdDecompress } from "node:zlib";
import { scanZstdFrames, decodeFrames, LiveLogReader, assertZstdHeaderFrame } from "../lib/pristine.js";
import { SESSIONS, cleanStage, listSessions, makePatchedBackend, release } from "./gate/harness.mjs";

await cleanStage();
const all = await listSessions();
const big = all.slice().sort((a, b) => b.bytes - a.bytes).find((e) => e.bytes > 40 * 1048576 && e.bytes < 70 * 1048576 && !e.torn);
if (big === undefined) { console.log("PROBE_FAIL no fixture"); process.exit(2); }
const bytes = await readFile(big.path);
const frames = scanZstdFrames(bytes).frames;
console.log("artifact " + (bytes.length / 1048576).toFixed(1) + " MB, " + frames.length + " frames (" + (frames.length - 1) + " data)");

/* ---- candidate: reused-context decoder (mirrors upstream's private contract) ---- */
const CHUNK = 1024 * 1024;
function privateDecoder() {
  const stream = createZstdDecompress({ chunkSize: CHUNK });
  const handle = stream._handle;
  const errorKey = Reflect.ownKeys(stream).find((k) => typeof k === "symbol" && k.description === "kError");
  if (typeof handle?.writeSync !== "function" || !(stream._writeState instanceof Uint32Array)
      || typeof stream._defaultFlushFlag !== "number" || errorKey === undefined || stream[errorKey] !== null) {
    stream.close();
    return undefined;
  }
  const output = Buffer.allocUnsafe(CHUNK);
  let decoderError;
  stream.on("error", (e) => { decoderError ??= e; });
  return {
    decodeFrame(input) {
      let inputOffset = 0;
      let inputRemaining = input.length;
      const parts = [];
      for (;;) {
        handle.writeSync(stream._defaultFlushFlag, input, inputOffset, inputRemaining, output, 0, output.length);
        if (decoderError !== undefined) throw decoderError;
        const internal = stream[errorKey];
        if (internal !== null && internal !== undefined) throw internal instanceof Error ? internal : new Error("zstd internal");
        const consumed = inputRemaining - stream._writeState[1];
        const produced = output.length - stream._writeState[0];
        inputOffset += consumed;
        inputRemaining -= consumed;
        if (produced === output.length) parts.push(Buffer.from(output));
        else if (produced > 0) parts.push(Buffer.from(output.subarray(0, produced)));
        if (inputRemaining === 0) break;
        if (consumed === 0 && produced === 0) throw new Error("no progress");
      }
      return parts.length === 1 ? parts[0] : Buffer.concat(parts);
    },
    close() { try { stream.close(); } catch {} },
  };
}

const marks = [];
let last = performance.now();
const mark = (l) => { const n = performance.now(); marks.push([l, n - last]); last = n; };

// ---- stage: decode (public, as the plugin does today)
const t_decode_pub = performance.now();
const chunksPublic = decodeFrames(bytes, frames);
const decodePublicMs = performance.now() - t_decode_pub;
mark("decodeFrames (public one-shot, " + (frames.length - 1) + " calls)");

// ---- stage: header + feed every frame to the reader
{
  const reader = new LiveLogReader(chunksPublic[0]);
  assertZstdHeaderFrame(chunksPublic[0]);
  for (let i = 1; i < chunksPublic.length; i += 1) reader.write(chunksPublic[i]);
  const artifact = reader.artifact();
  mark("LiveLogReader: feed " + (chunksPublic.length - 1) + " frames + finish");
  globalThis.__events = artifact.events.length;
}
release(chunksPublic);
globalThis.gc?.();

// ---- the same two stages with the two candidate changes, each measured alone
console.log("");
console.log("  as the plugin does it today");
let total = 0;
for (const [l, ms] of marks) { total += ms; console.log("    " + l.padEnd(52) + ms.toFixed(0).padStart(7) + " ms"); }
console.log("    " + "decode + feed (excl. validation/freeze)".padEnd(52) + total.toFixed(0).padStart(7) + " ms");

// candidate A: private decoder for the decode stage
let decodePrivateMs;
let chunksPrivate;
{
  const d = privateDecoder();
  if (d === undefined) { console.log("    private decoder UNAVAILABLE"); decodePrivateMs = undefined; }
  else {
    const t0 = performance.now();
    chunksPrivate = [];
    for (const f of frames) chunksPrivate.push(d.decodeFrame(bytes.subarray(f.start, f.end)));
    decodePrivateMs = performance.now() - t0;
    d.close();
  }
}

// candidate B: feed ONE concatenated plaintext instead of N chunks
let feedConcatMs;
{
  const reader = new LiveLogReader(chunksPublic === undefined ? chunksPrivate[0] : chunksPrivate[0]);
  const joined = Buffer.concat(chunksPrivate.slice(1));
  const t0 = performance.now();
  reader.write(joined);
  reader.artifact();
  feedConcatMs = performance.now() - t0;
  release(joined);
  globalThis.gc?.();
}

console.log("");
console.log("  each candidate change, measured alone on the same input");
console.log("    " + "decode: public one-shot".padEnd(52) + decodePublicMs.toFixed(0).padStart(7) + " ms");
if (decodePrivateMs !== undefined) {
  console.log("    " + "decode: reused context".padEnd(52) + decodePrivateMs.toFixed(0).padStart(7) + " ms   " + (decodePublicMs / decodePrivateMs).toFixed(2) + "x");
}
console.log("    " + "feed: 16665 separate frame writes".padEnd(52) + marks[1][1].toFixed(0).padStart(7) + " ms");
console.log("    " + "feed: one concatenated write".padEnd(52) + feedConcatMs.toFixed(0).padStart(7) + " ms   " + (marks[1][1] / feedConcatMs).toFixed(2) + "x");

// ---- control: the real cold read, for the total to be judged against
console.log("");
{
  const q = makePatchedBackend(SESSIONS, {});
  const t0 = performance.now();
  const stored = await q.backend.requireStoredLog(big.id, undefined);
  console.log("    real patched cold requireStoredLog".padEnd(52) + (performance.now() - t0).toFixed(0).padStart(7) + " ms   events " + stored.events.length);
  release(stored);
  q.disposer();
}

const projected = (decodePrivateMs ?? decodePublicMs) + feedConcatMs;
console.log("");
console.log("  projected cold path with both changes: " + projected.toFixed(0) + " ms");
console.log("  (validation, freeze, identity, and the backend's own reads add on top)");
console.log("");
console.log("PROBE_COLD_ATTR ok");
