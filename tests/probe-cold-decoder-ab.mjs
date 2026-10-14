/**
 * Does the plugin's COLD path decode more slowly than the backend it replaces?
 *
 * The plugin does its own frame decoding (lib/pristine.js decodeFrames) and that function
 * uses the PUBLIC one-shot zstdDecompressSync for every frame. Upstream's backend does not:
 * its createZstdFrameDecoder() returns NodePrivateZstdFrameDecoder.create() ?? public, i.e.
 * it prefers a reused-context private decoder, and on Node 26 that probe SUCCEEDS.
 *
 * So on a cold read -- exactly what a user triggers when opening a session from history --
 * the plugin may be SLOWER than the backend it is supposed to accelerate. That would be a
 * regression introduced by the very file that exists to avoid one, and the earlier measurement
 * of a 3892 ms cold open makes it plausible.
 *
 * This measures both, on the same artifact, in the same process, interleaved, and reports the
 * decode-only difference so the comparison cannot be explained by the plugin's extra work
 * (validation, freezing, resident bookkeeping).
 *
 * Run: node --expose-gc --max-old-space-size=12288 tests/probe-cold-decoder-ab.mjs
 */
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { zstdDecompressSync, createZstdDecompress } from "node:zlib";
import { scanZstdFrames, decodeFrames } from "../lib/pristine.js";
import { SESSIONS, cleanStage, listSessions, makeBackend, makePatchedBackend, release } from "./gate/harness.mjs";

await cleanStage();
const all = await listSessions();
const big = all.slice().sort((a, b) => b.bytes - a.bytes).find((e) => e.bytes > 40 * 1048576 && e.bytes < 70 * 1048576 && !e.torn);
if (big === undefined) { console.log("PROBE_FAIL no fixture"); process.exit(2); }
console.log("artifact: " + (big.bytes / 1048576).toFixed(1) + " MB");

// ---------------------------------------------------------------- what does upstream pick?
const DECODE_CHUNK_SIZE = 1024 * 1024;
{
  const stream = createZstdDecompress({ chunkSize: DECODE_CHUNK_SIZE });
  const handle = stream._handle;
  const errorKey = Reflect.ownKeys(stream).find((k) => typeof k === "symbol" && k.description === "kError");
  const usable = typeof handle === "object" && handle !== null && typeof handle.writeSync === "function"
    && stream._writeState instanceof Uint32Array && stream._writeState.length >= 2
    && typeof stream._defaultFlushFlag === "number" && errorKey !== undefined && stream[errorKey] === null;
  console.log("upstream would use the PRIVATE decoder: " + usable);
  stream.close();
}

// ---------------------------------------------------------------- decode-only, both ways
const bytes = await readFile(big.path);
const frames = scanZstdFrames(bytes).frames;
console.log("frames: " + frames.length + " (" + (frames.length - 1) + " data)");

function decodePublic() {
  const t0 = performance.now();
  const parts = decodeFrames(bytes, frames.slice(1));
  const ms = performance.now() - t0;
  const bytesOut = parts.reduce((s, p) => s + p.length, 0);
  release(parts);
  return { ms, bytesOut };
}

// The same loop the plugin runs, but with the private decoder substituted, so the ONLY
// difference is the decoder. If this is faster, the difference is the decoder and not the code.
function makePrivateDecoder() {
  const stream = createZstdDecompress({ chunkSize: DECODE_CHUNK_SIZE });
  const errorKey = Reflect.ownKeys(stream).find((k) => typeof k === "symbol" && k.description === "kError");
  const output = Buffer.allocUnsafe(DECODE_CHUNK_SIZE);
  let decoderError;
  stream.on("error", (e) => { decoderError ??= e; });
  const decodeFrame = (input) => {
    const handle = stream._handle;
    let inputOffset = 0;
    let inputRemaining = input.length;
    const fullChunks = [];
    for (;;) {
      handle.writeSync(stream._defaultFlushFlag, input, inputOffset, inputRemaining, output, 0, output.length);
      if (decoderError !== undefined) throw decoderError;
      const internal = stream[errorKey];
      if (internal !== null && internal !== undefined) {
        if (internal instanceof Error) throw internal;
        throw new Error("non-Error zstd internal failure");
      }
      const outputAfter = stream._writeState[0];
      const inputAfter = stream._writeState[1];
      const consumed = inputRemaining - inputAfter;
      const produced = output.length - outputAfter;
      inputOffset += consumed;
      inputRemaining -= consumed;
      if (produced === output.length) fullChunks.push(Buffer.from(output));
      else if (produced > 0) fullChunks.push(Buffer.from(output.subarray(0, produced)));
      if (inputRemaining === 0) break;
      if (consumed === 0 && produced === 0) throw new Error("zstd made no progress");
    }
    return fullChunks.length === 1 ? fullChunks[0] : Buffer.concat(fullChunks);
  };
  return { decodeFrame, close: () => { try { stream.close(); } catch {} } };
}

function decodePrivate() {
  const d = makePrivateDecoder();
  const t0 = performance.now();
  const parts = [];
  for (const f of frames.slice(1)) parts.push(d.decodeFrame(bytes.subarray(f.start, f.end)));
  const ms = performance.now() - t0;
  const bytesOut = parts.reduce((s, p) => s + p.length, 0);
  d.close();
  release(parts);
  return { ms, bytesOut };
}

// correctness gate before any speed claim
{
  const a = decodeFrames(bytes, frames.slice(1, 400));
  const d = makePrivateDecoder();
  let bad = 0;
  for (const f of frames.slice(1, 400)) {
    if (!d.decodeFrame(bytes.subarray(f.start, f.end)).equals(a.shift())) bad += 1;
  }
  d.close();
  console.log("first 399 frames identical: " + (bad === 0) + (bad ? "  mismatches=" + bad : ""));
  if (bad > 0) { console.log("PROBE_FAIL decoder mismatch"); process.exit(1); }
}

const pub = [decodePublic(), decodePublic(), decodePublic()];
const pri = [decodePrivate(), decodePrivate(), decodePrivate()];
const pubBest = Math.min(...pub.map((r) => r.ms));
const priBest = Math.min(...pri.map((r) => r.ms));
console.log("");
console.log("  decode only, public one-shot (what the plugin does today)");
console.log("    " + pub.map((r) => r.ms.toFixed(0)).join(" / ") + " ms   bytes " + pub[0].bytesOut);
console.log("  decode only, private reused context (what upstream picks)");
console.log("    " + pri.map((r) => r.ms.toFixed(0)).join(" / ") + " ms   bytes " + pri[0].bytesOut);
console.log("  identical output: " + (pub[0].bytesOut === pri[0].bytesOut));
console.log("  decoder speedup: " + (pubBest / priBest).toFixed(2) + "x   (" + (pubBest - priBest).toFixed(0) + " ms saved per cold read)");

// ---------------------------------------------------------------- the real backends, cold
console.log("");
console.log("  real cold path, same artifact, interleaved");
{
  // pristine
  const p = makeBackend(SESSIONS);
  const t0 = performance.now();
  const stored = await p.backend.requireStoredLog(big.id, undefined);
  const pristineMs = performance.now() - t0;
  console.log("    pristine requireStoredLog : " + pristineMs.toFixed(0) + " ms  events " + stored.events.length);
  release(stored);
}
{
  const q = makePatchedBackend(SESSIONS, {});
  const t0 = performance.now();
  const stored = await q.backend.requireStoredLog(big.id, undefined);
  const patchedMs = performance.now() - t0;
  console.log("    patched  requireStoredLog : " + patchedMs.toFixed(0) + " ms  events " + stored.events.length + "  cache " + JSON.stringify(q.cache.stats));
  const t1 = performance.now();
  await q.backend.requireStoredLog(big.id, undefined);
  console.log("    patched  second read      : " + (performance.now() - t1).toFixed(0) + " ms");
  release(stored);
  q.disposer();
}

console.log("");
console.log("PROBE_COLD_AB ok");
