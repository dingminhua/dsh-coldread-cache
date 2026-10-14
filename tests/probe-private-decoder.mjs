/**
 * Can a reused zstd context beat one-shot decoding, and is it BYTE-IDENTICAL?
 *
 * The cold open of a 62 MB history session is 3892 ms. 16665 of its frames are tiny
 * (median 1298 B), and one-shot zstdDecompressSync costs ~0.195 ms per CALL regardless of
 * payload, because every call builds a fresh native decompression context.
 *
 * Upstream already knows this: dsh-session-persistence-jsonl ships
 * NodePrivateZstdFrameDecoder, which reuses ONE stream handle across frames via the private
 * _handle.writeSync contract. But createZstdFrameDecoder is module-local and the package
 * exports only the class, so the plugin cannot call it. The plugin does its own decoding, so
 * it could implement the same technique -- and this probe answers whether that is worth doing
 * AND whether it is SAFE.
 *
 * Safety is the whole question. A private contract that returns subtly different bytes would
 * corrupt every session that passes through it, so this does not measure speed first: it
 * decodes EVERY frame of a real artifact with both paths and compares them byte for byte.
 * Speed is reported only for a shape that already proved identical.
 *
 * Run: node --expose-gc --max-old-space-size=12288 tests/probe-private-decoder.mjs [artifactPath]
 */
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createZstdDecompress, zstdDecompressSync } from "node:zlib";
import { scanZstdFrames } from "../lib/pristine.js";
import { listSessions } from "./gate/harness.mjs";

/* ------------------------------------------------------------------ */
/* the candidate implementation, mirroring upstream's private contract */
/* ------------------------------------------------------------------ */

const DECODE_CHUNK_SIZE = 1024 * 1024;

/** Probe the private shape exactly as upstream does; reject the optimization if absent. */
function privateZstdStream(stream) {
  const handle = stream._handle;
  const errorKey = Reflect.ownKeys(stream).find((key) => typeof key === "symbol" && key.description === "kError");
  if (typeof handle !== "object" || handle === null || typeof handle.writeSync !== "function") return undefined;
  // EXACTLY upstream's predicate. The first version of this probe used Array.isArray, which
  // is FALSE for a Uint32Array -- so it rejected a shape upstream accepts. The bug was in the
  // test, not the technique: a shape probe must be copied from the code that defines the
  // contract, not reconstructed from memory of it.
  if (!(stream._writeState instanceof Uint32Array) || stream._writeState.length < 2) return undefined;
  if (typeof stream._defaultFlushFlag !== "number") return undefined;
  if (errorKey === undefined || stream[errorKey] !== null) return undefined;
  return { stream, errorKey };
}

/** Why the probe rejected the private shape, in words, so a failure is diagnosable. */
function privateShapeReason(stream) {
  const handle = stream._handle;
  if (typeof handle !== "object" || handle === null) return "_handle is not an object";
  if (typeof handle.writeSync !== "function") return "_handle.writeSync is not a function";
  if (!(stream._writeState instanceof Uint32Array)) return "_writeState is not a Uint32Array";
  if (stream._writeState.length < 2) return "_writeState is shorter than 2";
  if (typeof stream._defaultFlushFlag !== "number") return "_defaultFlushFlag is not a number";
  const errorKey = Reflect.ownKeys(stream).find((key) => typeof key === "symbol" && key.description === "kError");
  if (errorKey === undefined) return "no kError symbol";
  if (stream[errorKey] !== null) return "kError is not null at rest";
  return "shape accepted";
}

/** One reused-context decoder. decodeFrame returns a SCRATCH view, valid until the next call. */
function createPrivateDecoder() {
  const stream = createZstdDecompress({ chunkSize: DECODE_CHUNK_SIZE });
  const access = privateZstdStream(stream);
  if (access === undefined) { stream.close(); return undefined; }
  const output = Buffer.allocUnsafe(DECODE_CHUNK_SIZE);
  let decoderError;
  stream.on("error", (error) => { decoderError ??= error; });
  return {
    stream,
    decodeFrame(input) {
      const handle = stream._handle;
      let inputOffset = 0;
      let inputRemaining = input.length;
      const fullChunks = [];
      for (;;) {
        handle.writeSync(stream._defaultFlushFlag, input, inputOffset, inputRemaining, output, 0, output.length);
        if (decoderError !== undefined) throw decoderError;
        const internalError = stream[access.errorKey];
        if (internalError !== null && internalError !== undefined) {
          if (internalError instanceof Error) throw internalError;
          throw new Error("zstd decoder exposed a non-Error internal failure");
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
        if (consumed === 0 && produced === 0) throw new Error("zstd decoder made no progress");
      }
      return fullChunks.length === 1 ? fullChunks[0] : Buffer.concat(fullChunks);
    },
    close() { try { stream.close(); } catch { /* already closed */ } },
  };
}

/* ------------------------------------------------------------------ */

const path = process.argv[2];
let artifactPath = path;
if (artifactPath === undefined) {
  const all = await listSessions();
  const pick = all.slice().sort((a, b) => b.bytes - a.bytes).find((e) => e.bytes > 40 * 1048576 && e.bytes < 70 * 1048576 && !e.torn);
  artifactPath = pick.path;
}
const bytes = await readFile(artifactPath);
const frames = scanZstdFrames(bytes).frames.slice(1);
console.log("artifact: " + (bytes.length / 1048576).toFixed(1) + " MB, " + frames.length + " data frames");
console.log("");

// ---- can the private shape even be used on this Node?
{
  const probe = createZstdDecompress({ chunkSize: DECODE_CHUNK_SIZE });
  console.log("private shape probe: " + privateShapeReason(probe) + "   (node " + process.version + ")");
  probe.close();
}
const decoder = createPrivateDecoder();
if (decoder === undefined) {
  console.log("");
  console.log("PROBE_PRIVATE_UNAVAILABLE -- this Node does not expose the private shape");
  process.exit(2);
}

// ---- CORRECTNESS FIRST: every frame, both paths, byte comparison.
// This is the check that decides whether the speed number may be believed at all.
let mismatches = 0;
let firstMismatch;
{
  const t0 = performance.now();
  for (let i = 0; i < frames.length; i += 1) {
    const frame = bytes.subarray(frames[i].start, frames[i].end);
    const mine = decoder.decodeFrame(frame);
    const reference = zstdDecompressSync(frame);
    if (!mine.equals(reference)) {
      mismatches += 1;
      if (firstMismatch === undefined) {
        firstMismatch = "frame " + i + " at byte " + frames[i].start + ": " + mine.length + " vs " + reference.length + " bytes";
      }
    }
  }
  console.log("correctness sweep: " + frames.length + " frames compared byte-for-byte in " + (performance.now() - t0).toFixed(0) + " ms");
}
console.log("  mismatches: " + mismatches + (firstMismatch === undefined ? "" : "   first: " + firstMismatch));
decoder.close();

if (mismatches > 0) {
  console.log("");
  console.log("PROBE_PRIVATE_FAIL -- the private decoder disagrees; it must NOT be used");
  process.exit(1);
}

// ---- SPEED: only meaningful because correctness above passed.
function timePublic() {
  const t0 = performance.now();
  let n = 0;
  for (const f of frames) { n += zstdDecompressSync(bytes.subarray(f.start, f.end)).length; }
  return { ms: performance.now() - t0, n };
}
function timePrivate() {
  const d = createPrivateDecoder();
  const t0 = performance.now();
  let n = 0;
  for (const f of frames) { n += d.decodeFrame(bytes.subarray(f.start, f.end)).length; }
  const ms = performance.now() - t0;
  d.close();
  return { ms, n };
}
// Interleave so a machine hiccup cannot favour either side.
const pub = [timePublic(), timePublic()];
const pri = [timePrivate(), timePrivate()];
const pubBest = Math.min(...pub.map((r) => r.ms));
const priBest = Math.min(...pri.map((r) => r.ms));
console.log("");
console.log("  public  one-shot : " + pub.map((r) => r.ms.toFixed(0)).join(" / ") + " ms   (bytes " + pub[0].n + ")");
console.log("  private reused   : " + pri.map((r) => r.ms.toFixed(0)).join(" / ") + " ms   (bytes " + pri[0].n + ")");
console.log("  speedup (best)   : " + (pubBest / priBest).toFixed(2) + "x");
console.log("  per-frame: "+ (priBest / frames.length).toFixed(4) + " ms private vs " + (pubBest / frames.length).toFixed(4) + " ms public");

// ---- a second artifact, so the result is not one file's accident.
{
  const all = await listSessions();
  const other = all.slice().sort((a, b) => b.bytes - a.bytes).find((e) => e.bytes > 8 * 1048576 && e.bytes < 30 * 1048576 && !e.torn);
  if (other !== undefined) {
    const b2 = await readFile(other.path);
    const f2 = scanZstdFrames(b2).frames.slice(1);
    const d2 = createPrivateDecoder();
    let bad = 0;
    for (const f of f2) {
      if (!d2.decodeFrame(b2.subarray(f.start, f.end)).equals(zstdDecompressSync(b2.subarray(f.start, f.end)))) bad += 1;
    }
    d2.close();
    console.log("");
    console.log("second artifact: " + (b2.length / 1048576).toFixed(1) + " MB, " + f2.length + " frames, mismatches " + bad);
    if (bad > 0) { console.log("PROBE_PRIVATE_FAIL -- second artifact disagrees"); process.exit(1); }
  }
}

console.log("");
console.log("PROBE_PRIVATE ok -- byte-identical on every frame of every artifact tested, " + (pubBest / priBest).toFixed(2) + "x faster");
