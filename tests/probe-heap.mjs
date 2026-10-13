/**
 * What does residency actually cost in heap, next to what the backend already holds?
 *
 * The artifact byte count is not the memory bill: a parsed log is JS objects, and
 * this is the number that decides whether the plugin is a fair trade on a
 * long-running host. Both halves read the SAME staged artifacts, so the only
 * difference is who is holding the parse.
 *
 * Run: node --expose-gc tests/probe-heap.mjs
 */
import { cleanStage, listSessions, makeBackend, makePatchedBackend, release, stage, STAGE, unlockStage } from "./gate/harness.mjs";

const mb = (bytes) => (bytes / 1048576).toFixed(0) + "MB";
const settle = async () => {
  for (let i = 0; i < 5; i += 1) { globalThis.gc?.(); await new Promise((r) => setTimeout(r, 50)); }
  return process.memoryUsage().heapUsed;
};

await cleanStage();
const all = await listSessions();
const pick = all.filter((e) => e.bytes > 4 * 1048576 && e.bytes < 40 * 1048576).slice(0, 6);
const artifactBytes = pick.reduce((n, e) => n + e.bytes, 0);
console.log("sessions: " + pick.map((e) => mb(e.bytes)).join(", ") + "  total " + mb(artifactBytes));

const staged = [];
for (const entry of pick) staged.push(await stage(entry.id));

/* ---- pristine: the two-entry memo the backend already keeps ------------- */
let base = await settle();
console.log("\nbaseline:                        " + mb(base));
const pristine = makeBackend(STAGE + "\\sessions");
for (let i = 0; i < staged.length; i += 1) {
  const log = await pristine.backend.readStoredLog(staged[i].path, pick[i].id, undefined);
  const now = await settle();
  console.log("pristine after " + (i + 1) + " parse(s):        " + mb(now) + "  (+" + mb(now - base) + ")  memo=" + pristine.backend.coldLogMemo.size);
  release(log);
}
const pristineCost = (await settle()) - base;
pristine.backend.coldLogMemo.clear();
await settle();

/* ---- plugin: the same artifacts, held by its own residency ------------- */
base = await settle();
const patched = makePatchedBackend(STAGE + "\\sessions", { maxEntries: 8 });
for (let i = 0; i < staged.length; i += 1) {
  const log = await patched.backend.readStoredLog(staged[i].path, pick[i].id, undefined);
  const now = await settle();
  console.log("plugin   after " + (i + 1) + " parse(s):        " + mb(now) + "  (+" + mb(now - base) + ")  resident=" + patched.cache.size + "/" + mb(patched.cache.bytes));
  release(log);
}
const pluginCost = (await settle()) - base;

console.log("\nartifacts:                       " + mb(artifactBytes));
console.log("pristine memo (2-entry cap):     " + mb(pristineCost) + "  (" + (pristineCost / artifactBytes).toFixed(1) + "x artifact)");
console.log("plugin residency (8-entry cap):  " + mb(pluginCost) + "  (" + (pluginCost / artifactBytes).toFixed(1) + "x artifact)");
console.log("plugin minus pristine:           " + mb(pluginCost - pristineCost));
const perArtifact = pluginCost / artifactBytes;
console.log("\nAt the shipped 128MB artifact budget the residency is ~" + mb(128 * 1048576 * perArtifact) + " of heap.");

patched.disposer();
await unlockStage();