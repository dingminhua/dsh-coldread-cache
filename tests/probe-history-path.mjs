/**
 * Where does "loading history" actually spend its time?
 *
 * The plugin optimizes one path: a session that is appended to and then read back. Browsing
 * history is a different path, and it was never measured. This probe drives the REAL backend
 * over the REAL corpus and reports each stage separately, so the next optimization targets a
 * measured cost instead of a guess.
 *
 * Stages, in the order a host hits them:
 *   list()            -- enumerate every session; reads each file's first frame for its header
 *   requireStoredLog  -- open one session: resolve it, then decode the whole log (patched)
 *
 * Run: node --expose-gc tests/probe-history-path.mjs
 */
import { performance } from "node:perf_hooks";
import { SESSIONS, STAGE, cleanStage, listSessions, makeBackend, makePatchedBackend, release } from "./gate/harness.mjs";

await cleanStage();
const all = await listSessions();
console.log("corpus: " + all.length + " artifacts, " + (all.reduce((s, e) => s + e.bytes, 0) / 1048576).toFixed(0) + " MB");

// ------------------------------------------------------------------ list()
// Over the real root: this is exactly what a host does when it paints the session list.
{
  const { backend } = makeBackend(SESSIONS);
  // Warm the directory enumeration so the first run is not measuring cold NTFS metadata.
  await backend.list({});
  const runs = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    const entries = await backend.list({});
    runs.push(performance.now() - t0);
    if (i === 0) console.log("  list() returned " + entries.length + " snapshots");
  }
  runs.sort((a, b) => a - b);
  console.log("");
  console.log("  list()            median " + runs[2].toFixed(0) + " ms   (runs " + runs.map((r) => r.toFixed(0)).join(", ") + ")");
  console.log("                    " + (runs[2] / all.length).toFixed(2) + " ms per session");
}

// ------------------------------------------------------------------ open one
// Opening a historical session: what the user clicks. Cold, then warm.
{
  const big = all.slice().sort((a, b) => b.bytes - a.bytes).find((e) => e.bytes > 20 * 1048576 && e.bytes < 70 * 1048576 && !e.torn);
  console.log("");
  console.log("  opening " + big.id.slice(0, 20) + " (" + (big.bytes / 1048576).toFixed(0) + " MB)");
  const { backend, cache, disposer } = makePatchedBackend(SESSIONS, {});
  const t0 = performance.now();
  const first = await backend.requireStoredLog(big.id, undefined);
  const cold = performance.now() - t0;
  const t1 = performance.now();
  const second = await backend.requireStoredLog(big.id, undefined);
  const warm = performance.now() - t1;
  console.log("  requireStoredLog  cold " + cold.toFixed(0) + " ms   warm " + warm.toFixed(0) + " ms");
  console.log("                    events " + first.events.length + "  same " + (second.events.length === first.events.length));
  console.log("                    cache " + JSON.stringify(cache.stats));
  release(first, second);
  disposer();
}

console.log("");
console.log("PROBE_HISTORY ok");
