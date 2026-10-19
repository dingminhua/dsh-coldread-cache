/**
 * Where does history enumeration spend its time, and how much of it does the header cache remove?
 *
 * list() is not one cost. It is listGenerations (a readdir walk of every project and session
 * directory, plus a generation pick per directory) and then listArtifacts (one open plus one
 * first-frame decode PER SESSION). Caching headers can only remove the second part, and the
 * first measurement of the whole call (839 ms) already showed most of the time was NOT in
 * opening 548 files. Measuring the whole thing and claiming the win would be exactly the
 * over-attribution this project has already been burned by.
 *
 * This times each stage separately on the real corpus, with and without the plugin, so the
 * remaining bottleneck is named rather than guessed.
 *
 * Run: node --expose-gc --max-old-space-size=12288 tests/probe-list-stages.mjs
 */
import { performance } from "node:perf_hooks";
import { SESSIONS, cleanStage, listSessions, makeBackend, makePatchedBackend } from "./gate/harness.mjs";
import { join } from "node:path";

await cleanStage();
const ROOT = SESSIONS;
const all = await listSessions();
console.log("corpus: " + all.length + " artifacts");

const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const ROUNDS = 5;

async function timeStage(label, fn) {
  const runs = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    globalThis.gc?.();
    const t0 = performance.now();
    await fn();
    runs.push(performance.now() - t0);
  }
  console.log("    " + label.padEnd(34) + runs.map((v) => v.toFixed(0).padStart(5)).join(" ") + "   median " + med(runs).toFixed(0).padStart(5) + " ms");
  return med(runs);
}

console.log("");
console.log("  UNCACHED (pristine backend)");
const plain = await makeBackend(ROOT);
await plain.backend.list({});
console.log("    " + "stage".padEnd(34) + "runs".padEnd(30) + "        median");
const plainGen = await timeStage("listGenerations", () => plain.backend.listGenerations());
const plainArt = await timeStage("listArtifacts", () => plain.backend.listArtifacts());
const plainAll = await timeStage("list", () => plain.backend.list({}));

console.log("");
console.log("  CACHED (plugin attached)");
const patched = await makePatchedBackend(ROOT, {});
await patched.backend.list({});
const patchGen = await timeStage("listGenerations", () => patched.backend.listGenerations());
const patchArt = await timeStage("listArtifacts", () => patched.backend.listArtifacts());
const patchAll = await timeStage("list", () => patched.backend.list({}));

console.log("");
console.log("  attribution");
console.log("    listGenerations (readdir walk):  " + plainGen.toFixed(0) + " ms -> " + patchGen.toFixed(0) + " ms   (not touched by the header cache)");
console.log("    listArtifacts   (header reads):  " + plainArt.toFixed(0) + " ms -> " + patchArt.toFixed(0) + " ms   " + (plainArt / patchArt).toFixed(2) + "x");
console.log("    list()                          " + plainAll.toFixed(0) + " ms -> " + patchAll.toFixed(0) + " ms   " + (plainAll / patchAll).toFixed(2) + "x");
console.log("    share of list() that is the walk: " + (plainGen / plainAll * 100).toFixed(0) + "% uncached, " + (patchGen / patchAll * 100).toFixed(0) + "% cached");

const state = patched.backend[Symbol.for("dsh.coldread-cache.ownership")];
console.log("");
console.log("    header cache counters: " + JSON.stringify(state?.cache?.stats ?? {}));
patched.disposer();
console.log("");
console.log("PROBE_LIST_STAGES ok");
