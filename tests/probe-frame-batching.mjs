/**
 * Can many small zstd frames be decoded in ONE call instead of one call each?
 *
 * The cold open of a 62 MB session is 3892 ms, and 3247 ms of that is 16665 calls to
 * decompressZstdFrameSync at 0.195 ms each. The frames are tiny (median 1298 B), so the cost
 * is per-CALL setup, not per-byte work: zstd frame headers, context allocation, and the
 * sync wrapper's marshalling.
 *
 * The zstd format permits CONCATENATED frames in one stream. If Node's zstdDecompressSync
 * accepts a buffer holding several frames, decoding can be batched and the setup amortized.
 * The plugin treats every frame as an independently decodable unit, so concatenating an
 * ordered run of them is format-legal -- but "should work" is exactly the kind of assumption
 * that produced the freeze regression. This measures it and then CHECKS IT AGAINST GROUND
 * TRUTH: the batched output must be byte-identical to the per-frame output, for every
 * batch size, or the optimization is invalid.
 *
 * Run: node --expose-gc --max-old-space-size=12288 tests/probe-frame-batching.mjs
 */
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";
import { scanZstdFrames, decompressZstdFrameSync } from "../lib/pristine.js";
import { cleanStage, listSessions } from "./gate/harness.mjs";

await cleanStage();
const all = await listSessions();
const big = all.slice().sort((a, b) => b.bytes - a.bytes).find((e) => e.bytes > 40 * 1048576 && e.bytes < 70 * 1048576 && !e.torn);
if (big === undefined) { console.log("PROBE_FAIL no fixture"); process.exit(2); }
console.log("fixture: " + (big.bytes / 1048576).toFixed(0) + " MB");

const bytes = await readFile(big.path);
const frames = scanZstdFrames(bytes).frames;
const data = frames.slice(1);
console.log("data frames: " + data.length);

// ---------------------------------------------------------------- ground truth
// Per-frame decode, exactly as the plugin does it today, and hash the joined plaintext.
import { createHash } from "node:crypto";
const joinHash = (parts) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest("hex"); };

let truth = [];
{
  const t0 = performance.now();
  for (const f of data) truth.push(decompressZstdFrameSync(bytes.subarray(f.start, f.end)));
  const ms = performance.now() - t0;
  console.log("");
  console.log("  per-frame:  " + data.length + " calls in " + ms.toFixed(0) + " ms   sha=" + joinHash(truth).slice(0, 16));
}

// ---------------------------------------------------------------- batched
// Group consecutive frames until the group's COMPRESSED bytes reach a target, then one call.
function batched(targetBytes) {
  const chunks = [];
  let group = [];
  let size = 0;
  const flush = () => { if (group.length === 0) return; chunks.push(Buffer.concat(group)); group = []; size = 0; };
  for (const f of data) {
    const slice = bytes.subarray(f.start, f.end);
    group.push(slice);
    size += slice.length;
    if (size >= targetBytes) flush();
  }
  flush();
  return chunks;
}

const results = [];
for (const target of [64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
  const chunks = batched(target);
  // Decode each batch with ONE call, then re-split the plaintext on the frame boundary?
  // No: frame boundaries in the PLAINTEXT are not recoverable from a merged decode, and the
  // plugin only needs the joined text -- it splits by newline afterwards. So compare joined.
  const t0 = performance.now();
  const parts = [];
  let failed;
  try {
    for (const c of chunks) parts.push(zstdDecompressSync(c));
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error);
  }
  const ms = performance.now() - t0;
  if (failed !== undefined) {
    console.log("  batch " + String(target / 1024).padStart(5) + " KB: FAILED -- " + failed);
    results.push({ target, ok: false });
    continue;
  }
  const hash = joinHash(parts);
  const ok = hash === joinHash(truth);
  console.log("  batch " + String(target / 1024).padStart(5) + " KB: " + chunks.length + " calls in " + ms.toFixed(0) + " ms   sha=" + hash.slice(0, 16) + "   identical=" + ok);
  results.push({ target, ok, ms, calls: chunks.length });
}

// ---------------------------------------------------------------- sanity
// Does zstdDecompressSync really accept concatenated frames? Prove it on two frames whose
// plaintexts are known independently, so a pass here cannot be an artifact of the loop.
{
  const a = decompressZstdFrameSync(bytes.subarray(data[0].start, data[0].end));
  const b = decompressZstdFrameSync(bytes.subarray(data[1].start, data[1].end));
  const both = zstdDecompressSync(Buffer.concat([
    bytes.subarray(data[0].start, data[0].end),
    bytes.subarray(data[1].start, data[1].end),
  ]));
  console.log("");
  console.log("  two concatenated frames: " + (both.equals(Buffer.concat([a, b])) ? "equal to a+b" : "NOT equal to a+b") +
    "  (" + a.length + " + " + b.length + " = " + (a.length + b.length) + " vs " + both.length + ")");
}

const allOk = results.length > 0 && results.every((r) => r.ok);
const best = results.filter((r) => r.ok).sort((x, y) => x.ms - y.ms)[0];
console.log("");
if (allOk && best !== undefined) {
  console.log("PROBE_BATCHING ok -- batched decode is byte-identical at every size; best " +
    (best.target / 1024) + " KB in " + best.ms.toFixed(0) + " ms vs " + data.length + " per-frame calls");
} else {
  console.log("PROBE_BATCHING FAIL -- batched decode is NOT equivalent; do not use it");
}
process.exit(allOk ? 0 : 1);
