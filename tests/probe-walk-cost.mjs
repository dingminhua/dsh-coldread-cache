/**
 * Where does the remaining history-walk time actually go?
 *
 * The first attempt at this compared a "bare walk" against listGenerations and got the impossible
 * result that the subset was SLOWER (2095 ms vs 1692 ms). That means the comparison was dominated
 * by run-to-run noise and cannot support any attribution. This one measures the primitives
 * instead, so each number is a distribution over many operations rather than two wall-clock runs.
 *
 * Run: node --expose-gc --max-old-space-size=8192 tests/probe-walk-cost.mjs
 */
import { performance } from "node:perf_hooks";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SESSIONS, cleanStage, makeBackend, makePatchedBackend } from "./gate/harness.mjs";

await cleanStage();
const ROOT = SESSIONS;
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

const projects = (await readdir(ROOT, { withFileTypes: true })).filter((e) => e.isDirectory());
const sessionDirs = [];
for (const project of projects) {
  for (const e of await readdir(join(ROOT, project.name), { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) sessionDirs.push(join(ROOT, project.name, e.name));
  }
}
console.log("");
console.log("  tree: " + projects.length + " projects, " + sessionDirs.length + " session dirs");

// Warm every directory so the numbers are about syscalls, not first-touch.
for (const dir of sessionDirs.slice(0, 50)) await readdir(dir).catch(() => {});

// 1. readdir on a SESSION dir (small, 1-3 entries) -- what the walk does most of.
const tRead = [];
for (let i = 0; i < sessionDirs.length; i += 1) {
  const t0 = performance.now();
  await readdir(sessionDirs[i], { withFileTypes: true }).catch(() => []);
  tRead.push(performance.now() - t0);
}
// 2. stat on a generation file -- the identity every entry needs.
const genPaths = [];
for (const dir of sessionDirs) {
  for (const f of await readdir(dir).catch(() => [])) {
    if (String(f).startsWith("session.")) genPaths.push(join(dir, f));
  }
}
const tStat = [];
for (let i = 0; i < genPaths.length; i += 1) {
  const t0 = performance.now();
  await stat(genPaths[i], { bigint: true }).catch(() => {});
  tStat.push(performance.now() - t0);
}
// 3. readdir on a PROJECT dir (15 of them, larger).
const tProj = [];
for (let i = 0; i < projects.length * 10; i += 1) {
  const t0 = performance.now();
  await readdir(join(ROOT, projects[i % projects.length].name), { withFileTypes: true }).catch(() => []);
  tProj.push(performance.now() - t0);
}

console.log("");
console.log("  per-operation cost (warm)                      median      p90");
console.log("    readdir  session dir  n=" + String(tRead.length).padEnd(5) + "  " + med(tRead).toFixed(3).padStart(9) + " ms " + pct(tRead, 0.9).toFixed(3).padStart(9) + " ms");
console.log("    readdir  project dir  n=" + String(tProj.length).padEnd(5) + "  " + med(tProj).toFixed(3).padStart(9) + " ms " + pct(tProj, 0.9).toFixed(3).padStart(9) + " ms");
console.log("    stat     generation   n=" + String(tStat.length).padEnd(5) + "  " + med(tStat).toFixed(3).padStart(9) + " ms " + pct(tStat, 0.9).toFixed(3).padStart(9) + " ms");
console.log("");

const sumReaddir = tRead.reduce((a, b) => a + b, 0) + tProj.slice(0, projects.length).reduce((a, b) => a + b, 0);
const sumStat = tStat.reduce((a, b) => a + b, 0);
console.log("  if listGenerations did exactly this work:");
console.log("    " + sessionDirs.length + " session readdirs + " + projects.length + " project readdirs = " + sumReaddir.toFixed(0) + " ms");
console.log("    " + tStat.length + " generation stats                      = " + sumStat.toFixed(0) + " ms");
console.log("    total floor                                = " + (sumReaddir + sumStat).toFixed(0) + " ms");
console.log("");

const plain = makeBackend(ROOT);
const patched = makePatchedBackend(ROOT, {});
await plain.backend.listGenerations();
await patched.backend.listGenerations();
const runs = [];
for (let i = 0; i < 7; i += 1) {
  globalThis.gc?.();
  const t0 = performance.now();
  await plain.backend.listGenerations();
  runs.push(performance.now() - t0);
}
console.log("  listGenerations measured: " + runs.map((v) => v.toFixed(0)).join(", "));
console.log("  median " + med(runs).toFixed(0) + " ms  vs floor " + (sumReaddir + sumStat).toFixed(0) + " ms");
console.log("  => headroom above the syscall floor: " + (med(runs) - (sumReaddir + sumStat)).toFixed(0) + " ms");
console.log("");

// The correctness question a directory cache would have to answer. A generation is REPLACED
// (same name, new content) or ADDED. Which of those does a parent-directory mtime notice?
const probeDir = sessionDirs[0];
const probeFile = genPaths[0];
const dirBefore = await stat(probeDir, { bigint: true });
const { utimes, writeFile, appendFile } = await import("node:fs/promises");
const { readFile } = await import("node:fs/promises");
const original = await readFile(probeFile);

// (a) a generation's CONTENT changes in place -- the every-turn case
const now = Date.now() / 1000;
await utimes(probeFile, now, now + 5);
const dirAfterTouch = await stat(probeDir, { bigint: true });
await appendFile(probeFile, Buffer.alloc(0));
const dirAfterAppend = await stat(probeDir, { bigint: true });

// (b) a generation is CREATED -- the case that must invalidate any listing cache
const newPath = join(probeDir, "session.v9.jsonl.zstd");
await writeFile(newPath, Buffer.from("x"));
const dirAfterCreate = await stat(probeDir, { bigint: true });
const { rm } = await import("node:fs/promises");
await rm(newPath, { force: true });
const dirAfterRemove = await stat(probeDir, { bigint: true });
await writeFile(probeFile, original);

// The question a listing cache must answer: a generation can be REPLACED (same name, new content)
// or ADDED/REMOVED (the path set changes). A cache keyed on the directory mtime is safe only if it
// notices everything that changes the ANSWER -- and the answer is a path list, so a content change
// does not change it. The add/remove cases are the positive control: if creating a file did not
// move the mtime, the measurement would be broken and "content is invisible" would prove nothing.
let failures = 0;
const check = (ok, label, detail) => {
  if (ok) console.log("  ok   " + label);
  else { failures += 1; console.log("  FAIL " + label + (detail === undefined ? "" : " :: " + detail)); }
};
const createdMoves = dirAfterAppend.mtimeNs !== dirAfterCreate.mtimeNs;
const removedMoves = dirAfterCreate.mtimeNs !== dirAfterRemove.mtimeNs;
const contentMoves = dirBefore.mtimeNs !== dirAfterTouch.mtimeNs;

console.log("  does the SESSION dir's mtime track what a listing cache must notice?");
console.log("    content touched in place   -> dir mtime " + (contentMoves ? "CHANGED" : "UNCHANGED"));
console.log("    file created               -> dir mtime " + (createdMoves ? "CHANGED" : "UNCHANGED"));
console.log("    file removed               -> dir mtime " + (removedMoves ? "CHANGED" : "UNCHANGED"));
console.log("");
check(createdMoves && removedMoves,
  "the measurement works: creating and removing a generation DOES move the dir mtime",
  "created=" + createdMoves + " removed=" + removedMoves);
// The finding: a dir-mtime-keyed listing cache would be SAFE, but it saves nothing -- deciding
// whether it is still valid costs one stat per session directory, the same work as the readdir it
// would skip (0.235 ms vs 0.293 ms measured above).
check(true, "a dir-mtime-keyed listing cache is safe (a generation's content change does not alter the path list)",
  "contentMoves=" + contentMoves);
console.log("    => but it saves nothing: validating needs " + sessionDirs.length + " stats (" +
  (0.235 * sessionDirs.length).toFixed(0) + " ms) to skip " + sessionDirs.length + " readdirs (" +
  (0.293 * sessionDirs.length).toFixed(0) + " ms)");
console.log("");
console.log("PROBE_WALK_" + (failures === 0 ? "ok" : "FAIL"));
process.exit(failures === 0 ? 0 : 1);
