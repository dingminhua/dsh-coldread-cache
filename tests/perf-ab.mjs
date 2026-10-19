/**
 * Real-machine read cost: the plugin's fast path versus a pristine backend.
 *
 * The comparison that matters is not "read the same file twice": the backend
 * already memoizes one artifact, so a repeat read is fast either way. The lag a
 * long session produces comes from reading an artifact that just grew, which is
 * what a host does on every turn. So each round appends a real batch through the
 * backend's own write path and then times the read that follows.
 *
 * The control half runs the identical loop against a patched backend whose
 * residency is switched off. If the assertion could not fail, that control would
 * show the same speedup; it must not.
 */
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  cleanStage, listSessions, makeBackend, makePatchedBackend, nextClosedTurn, prefixEndingAtClosedTurn,
  release, STAGE, stage, unlockStage,
} from "./gate/harness.mjs";
import { join } from "node:path";

const ROUNDS = Number(process.env.PERF_ROUNDS ?? 5);
const TARGET_BYTES = Number(process.env.PERF_TARGET_BYTES ?? 50 * 1024 * 1024);
const say = (line) => console.log(line);

const checks = [];
const check = (ok, name, detail) => {
  checks.push({ ok, name });
  console.log((ok ? "  ok   " : "  FAIL ") + name + (detail === undefined ? "" : " :: " + detail));
};

await cleanStage();
let chosen;
for (const candidate of await listSessions()) {
  if (candidate.bytes < TARGET_BYTES * 0.6 || candidate.bytes > TARGET_BYTES * 2.2) continue;
  const attempt = await stage(candidate.id);
  const probe = await makeBackend(join(STAGE, "sessions"));
  try {
    const log = await probe.backend.readStoredLog(attempt.path, candidate.id, undefined);
    if (log.events.length > 500) {
      chosen = { candidate, attempt, events: log.events.length, path: attempt.path };
      release(log);
      break;
    }
  } catch {
    /* unreadable artifacts are not this test's business */
  }
}
if (chosen === undefined) {
  say("PERF_RED no suitable artifact found");
  process.exit(1);
}
say("FIXTURE " + chosen.candidate.id + " " + chosen.candidate.bytes + " B " + chosen.events + " events, " + ROUNDS + " append+read rounds");

/**
 * Cut a staged copy back to a prefix whose last turn is closed.
 *
 * A batch may only continue a log whose last turn is closed, so a live session
 * captured mid-turn cannot take an append at all. The prefix is also smaller,
 * which keeps the rounds fast without changing what they measure.
 */
async function closedTurnPrefix(path, backend, id) {
  const cut = await prefixEndingAtClosedTurn(path);
  if (cut === undefined) return false;
  await writeFile(path, cut.bytes);
  backend.coldLogMemo.delete(id);
  return true;
}

/**
 * Append one real batch through the backend's own write path and time the read
 * that follows it. The batch is a complete, already-closed turn numbered after
 * the last one the log opened, which is the smallest shape the released
 * lifecycle validator admits.
 */
async function rounds(backend, label, path, id) {
  let log = await backend.readStoredLog(path, id, undefined);
  const times = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    // Each round appends one complete, already-closed turn numbered after the
    // last one this log closed, which is the smallest batch the released
    // lifecycle validator accepts whatever the session ended with.
    const rows = nextClosedTurn(log);
    await backend.persistBatch(log.meta, rows, true, log.inheritedEventCount);
    const start = performance.now();
    const read = await backend.readStoredLog(path, id, undefined);
    const ms = performance.now() - start;
    times.push(ms);
    say("TIME " + label + " round " + round + " " + ms.toFixed(1) + " ms (" + read.events.length + " events)");
    release(log);
    log = read;
  }
  release(log);
  return times;
}

/* ---- patched: residency extends the resident parse ---------------------- */
const patchedPath = chosen.path;
const patched = await makePatchedBackend(join(STAGE, "sessions"));
if (!(await closedTurnPrefix(patchedPath, patched.backend, chosen.candidate.id))) {
  say("PERF_RED no frame-aligned prefix ends at a closed turn");
  process.exit(1);
}
const patchedTimes = await rounds(patched.backend, "patched", patchedPath, chosen.candidate.id);
say("PATCHED_STATS " + JSON.stringify(patched.cache.stats));
patched.disposer();

/* ---- control: identical loop, residency switched off -------------------- */
const controlStaged = await stage(chosen.candidate.id, join(STAGE, "control"));
const control = await makePatchedBackend(join(STAGE, "control", "sessions"), { maxResidentBytes: 1 });
await closedTurnPrefix(controlStaged.path, control.backend, chosen.candidate.id);
const controlTimes = await rounds(control.backend, "control", controlStaged.path, chosen.candidate.id);
say("CONTROL_STATS " + JSON.stringify(control.cache.stats));
control.disposer();

/* ---- pristine: the unpatched class the running host uses ---------------- */
const pristineStaged = await stage(chosen.candidate.id, join(STAGE, "pristine"));
const pristine = await makeBackend(join(STAGE, "pristine", "sessions"));
await closedTurnPrefix(pristineStaged.path, pristine.backend, chosen.candidate.id);
const pristineTimes = await rounds(pristine.backend, "pristine", pristineStaged.path, chosen.candidate.id);

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const best = (values) => Math.min(...values);
const patchedMedian = median(patchedTimes);
const controlMedian = median(controlTimes);
const pristineMedian = median(pristineTimes);
say("MEDIAN patched=" + patchedMedian.toFixed(1) + " control=" + controlMedian.toFixed(1) + " pristine=" + pristineMedian.toFixed(1) + " ms");

check(patchedMedian * 5 < pristineMedian, "a read after an append is 5x cheaper than the pristine backend", patchedMedian.toFixed(1) + " ms vs " + pristineMedian.toFixed(1) + " ms");
check(patchedMedian * 5 < controlMedian, "a read after an append is 5x cheaper than the residency-free control", patchedMedian.toFixed(1) + " ms vs " + controlMedian.toFixed(1) + " ms");
check(controlMedian * 5 >= pristineMedian, "the control does NOT show the speedup (the assertion can fail)", controlMedian.toFixed(1) + " ms vs " + pristineMedian.toFixed(1) + " ms");
check(best(patchedTimes) * 5 < best(pristineTimes), "the best case shows it too", best(patchedTimes).toFixed(1) + " ms vs " + best(pristineTimes).toFixed(1) + " ms");
const failures = checks.filter((entry) => !entry.ok).length;
await unlockStage();
console.log("\nPERF_" + (failures === 0 ? "GREEN" : "RED") + " checks=" + checks.length + " failures=" + failures);
process.exit(failures === 0 ? 0 : 1);
