/**
 * Resolve a contradiction: is the reused-context zstd decoder faster or slower?
 *
 * Two interleaved probes measured it faster (2.06x, 2.91x). A third, which allocated 277 MB of
 * plaintext before measuring it, reported 0.72x. Those cannot both be right, and a plan built
 * on the wrong one would be worse than no plan.
 *
 * The difference between the runs is what preceded the measurement, so the suspect is
 * allocation and GC state rather than the decoder. This probe removes that variable:
 *
 *   - every arm starts from the same state: buffers released, gc() forced
 *   - arms are interleaved round-robin, so drift hits both equally
 *   - each arm's plaintext is released immediately after it is measured
 *   - the result is reported as a median over rounds, not a single run
 *
 * It also measures the FULL cold path (pristine vs patched) in the same controlled way, because
 * that is the number the user actually feels: the plugin is supposed to make reads fast, and it
 * must not be making the FIRST read slower.
 *
 * Run: node --expose-gc --max-old-space-size=12288 tests/probe-decoder-resolve.mjs
 */
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { createZstdDecompress, zstdDecompressSync } from "node:zlib";
import { scanZstdFrames } from "../lib/pristine.js";
import { SESSIONS, cleanStage, listSessions, makeBackend, makePatchedBackend, release } from "./gate/harness.mjs";

await cleanStage();
const all = await listSessions();
const big = all.slice().sort((a, b) => b.bytes - a.bytes).find((e) => e.bytes > 40 * 1048576 && e.bytes < 70 * 1048576 && !e.torn);
const bytes = await readFile(big.path);
const frames = scanZstdFrames(bytes).frames.slice(1);
console.log("artifact " + (bytes.length / 1048576).toFixed(1) + " MB, " + frames.length + " data frames");

const CHUNK = 1024 * 1024;
function makePrivate() {
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
    frame(input) {
      let off = 0;
      let remaining = input.length;
      const parts = [];
      for (;;) {
        handle.writeSync(stream._defaultFlushFlag, input, off, remaining, output, 0, output.length);
        if (decoderError !== undefined) throw decoderError;
        const internal = stream[errorKey];
        if (internal !== null && internal !== undefined) throw internal instanceof Error ? internal : new Error("zstd internal");
        const consumed = remaining - stream._writeState[1];
        const produced = output.length - stream._writeState[0];
        off += consumed; remaining -= consumed;
        if (produced > 0) parts.push(produced === output.length ? Buffer.from(output) : Buffer.from(output.subarray(0, produced)));
        if (remaining === 0) break;
        if (consumed === 0 && produced === 0) throw new Error("no progress");
      }
      return parts.length === 1 ? parts[0] : Buffer.concat(parts);
    },
    close() { try { stream.close(); } catch {} },
  };
}

const settle = () => { globalThis.gc?.(); globalThis.gc?.(); };

function armPublic() {
  settle();
  const t0 = performance.now();
  let n = 0;
  for (const f of frames) { const b = zstdDecompressSync(bytes.subarray(f.start, f.end)); n += b.length; }
  const ms = performance.now() - t0;
  return { ms, n };
}
function armPrivate() {
  settle();
  const d = makePrivate();
  if (d === undefined) return undefined;
  const t0 = performance.now();
  let n = 0;
  for (const f of frames) { const b = d.frame(bytes.subarray(f.start, f.end)); n += b.length; }
  const ms = performance.now() - t0;
  d.close();
  return { ms, n };
}

// ---- correctness first: identical output on a large prefix, both arms
{
  const d = makePrivate();
  let bad = 0;
  for (let i = 0; i < 3000; i += 1) {
    const f = bytes.subarray(frames[i].start, frames[i].end);
    if (!d.frame(f).equals(zstdDecompressSync(f))) bad += 1;
  }
  d.close();
  console.log("first 3000 frames identical: " + (bad === 0) + (bad ? "  mismatches=" + bad : ""));
  if (bad > 0) { console.log("PROBE_FAIL mismatch"); process.exit(1); }
}

const pubMs = [];
const priMs = [];
let pubN = 0;
let priN = 0;
for (let round = 0; round < 5; round += 1) {
  const p = armPublic();
  if (p !== undefined) { pubN = p.n; }
  const q = armPrivate();
  if (q !== undefined) { priN = q.n; }
  // alternate the order so a systematic warm-up still hits both arms
  const q2 = armPrivate();
  if (q2 !== undefined) { priMs.push(q2.ms); priN = q2.n; }
  const p2 = armPublic();
  if (p2 !== undefined) { pubMs.push(p2.ms); pubN = p2.n; }
}
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
console.log("");
console.log("  reused-context decode: rounds " + priMs.map((v) => v.toFixed(0)).join(", ") + "  -> median " + med(priMs).toFixed(0) + " ms");
console.log("  public one-shot decode: rounds " + pubMs.map((v) => v.toFixed(0)).join(", ") + "  -> median " + med(pubMs).toFixed(0) + " ms");
console.log("  identical byte totals: " + (pubN === priN) + " (" + pubN + ")");
console.log("  RESULT: reused-context is " + (med(priMs) < med(pubMs) ? (med(pubMs) / med(priMs)).toFixed(2) + "x FASTER" : (med(priMs) / med(pubMs)).toFixed(2) + "x SLOWER"));
release(bytes);

// ---- full cold path, interleaved, so the user-visible number is trustworthy
console.log("");
console.log("  full cold read, interleaved rounds");
const pristineMs = [];
const patchedMs = [];
for (let round = 0; round < 3; round += 1) {
  settle();
  {
    const p = makeBackend(SESSIONS);
    const t0 = performance.now();
    const s = await p.backend.requireStoredLog(big.id, undefined);
    pristineMs.push(performance.now() - t0);
    release(s);
  }
  settle();
  {
    const q = makePatchedBackend(SESSIONS, {});
    const t0 = performance.now();
    const s = await q.backend.requireStoredLog(big.id, undefined);
    patchedMs.push(performance.now() - t0);
    release(s);
    q.disposer();
  }
}
console.log("    pristine: " + pristineMs.map((v) => v.toFixed(0)).join(", ") + "  median " + med(pristineMs).toFixed(0) + " ms");
console.log("    patched : " + patchedMs.map((v) => v.toFixed(0)).join(", ") + "  median " + med(patchedMs).toFixed(0) + " ms");
const ratio = med(patchedMs) / med(pristineMs);
console.log("    COLD READ: patched is " + (ratio > 1 ? ratio.toFixed(2) + "x SLOWER than pristine" : (1 / ratio).toFixed(2) + "x faster than pristine"));
console.log("");
console.log("PROBE_RESOLVE ok");
