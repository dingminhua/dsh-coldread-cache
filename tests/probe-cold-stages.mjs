/**
 * Attribute one cold open, and check the shape of the artifact it decodes.
 *
 * Opening a historical session costs ~3.7-4.5 s on a 62 MB artifact. The plugin makes the
 * SECOND open fast, so the interesting question is whether the first open is reducible at all.
 *
 * Two earlier versions of this probe failed for instructive reasons:
 *   - synthesizing a header made released validation refuse it ("session/title messageSeqs
 *     must cite distinct earlier human user/message events"): relationships cannot be faked.
 *   - passing inheritedEventCount 0 was also wrong; the real value comes from the read.
 * So this version takes the header, the inherited count, and the event list from the plugin's
 * own resident entry, which is by construction the validated shape.
 *
 * It also reports the FRAME SIZE DISTRIBUTION. A zstd frame costs fixed setup regardless of
 * payload, so an artifact with tens of thousands of tiny frames pays per-frame overhead
 * rather than per-byte cost -- and that is a property of the append path, not the reader.
 *
 * Run: node --expose-gc tests/probe-cold-stages.mjs
 */
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { scanZstdFrames, decompressZstdFrameSync } from "../lib/pristine.js";
import { assertReleasedV4Relationships } from "@deepseek-ai/dsh-session-format-v3-to-v4";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import { SESSIONS, cleanStage, listSessions, makePatchedBackend, release } from "./gate/harness.mjs";

await cleanStage();
const all = await listSessions();
const big = all.slice().sort((a, b) => b.bytes - a.bytes).find((e) => e.bytes > 40 * 1048576 && e.bytes < 70 * 1048576 && !e.torn);
if (big === undefined) { console.log("PROBE_FAIL no fixture"); process.exit(2); }
console.log("fixture: " + big.id.slice(0, 24) + "  " + (big.bytes / 1048576).toFixed(0) + " MB");

// ---- the real cold open through the patched backend, timed, and its resident entry kept.
let realCold;
let entry;
{
  const { backend, cache, disposer } = makePatchedBackend(SESSIONS, {});
  const t0 = performance.now();
  await backend.requireStoredLog(big.id, undefined);
  realCold = performance.now() - t0;
  entry = cache.get(big.id);
  console.log("real cold requireStoredLog: " + realCold.toFixed(0) + " ms, " + entry.events.length + " events");
  console.log("cache after: " + JSON.stringify(cache.stats));
  // A second open of the SAME session: is it the plugin or the backend's own 2-entry memo?
  const t1 = performance.now();
  await backend.requireStoredLog(big.id, undefined);
  console.log("second open: " + (performance.now() - t1).toFixed(0) + " ms, cache " + JSON.stringify(cache.stats));
  disposer();
}

// ---- frame shape: per-frame overhead vs payload
const bytes = await readFile(big.path);
const frames = scanZstdFrames(bytes).frames;
const sizes = frames.slice(1).map((f) => f.end - f.start).sort((a, b) => a - b);
const sum = sizes.reduce((s, v) => s + v, 0);
console.log("");
console.log("  frame shape: " + sizes.length + " data frames, " + (sum / 1048576).toFixed(1) + " MB total");
console.log("    min " + sizes[0] + " B   median " + sizes[Math.floor(sizes.length / 2)] + " B   max " + sizes[sizes.length - 1] + " B");
console.log("    frames under 1 KB: " + sizes.filter((s) => s < 1024).length + "   under 4 KB: " + sizes.filter((s) => s < 4096).length);

// ---- per-frame decompress cost, to expose the fixed overhead
{
  const sample = frames.slice(1, 2001);
  const t0 = performance.now();
  for (const f of sample) decompressZstdFrameSync(bytes.subarray(f.start, f.end));
  const per = (performance.now() - t0) / sample.length;
  console.log("    decompress cost: " + per.toFixed(3) + " ms per frame over " + sample.length + " frames");
  console.log("    projected for all " + sizes.length + ": " + (per * sizes.length).toFixed(0) + " ms");
}

// ---- the validator, on the REAL resident shape
{
  const artifact = { header: entry.meta, inheritedEventCount: entry.inheritedEventCount, events: entry.events };
  const t0 = performance.now();
  assertReleasedV4Relationships(artifact, KNOWN_SESSION_EVENT_TYPES);
  console.log("");
  console.log("  assertReleasedV4Relationships on the real entry: " + (performance.now() - t0).toFixed(0) + " ms");
}
console.log("  (this is the same call the plugin makes per extension; on the COLD path it is");
console.log("   part of the 4.5 s, which is why the cold parse is the thing worth attacking)");

release(entry);
console.log("");
console.log("PROBE_COLDSTAGES ok");
