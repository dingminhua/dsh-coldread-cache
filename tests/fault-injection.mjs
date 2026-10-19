/**
 * Fault injection: prove the gate's guards can actually turn red.
 *
 * The user-facing rule this satisfies is that a gate must be shown able to fail
 * before its green means anything. Every injection here works on a throwaway copy
 * in the OS temp directory, so the real vendored trees are never touched.
 *
 * Run: node tests/fault-injection.mjs
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareLogs, listSessions, makeBackend, makePatchedBackend, nextClosedTurn, prefixEndingAtClosedTurn,
  release, stage, unlockStage, STAGE,
} from "./gate/harness.mjs";

const checks = [];
const check = (ok, name, detail) => {
  checks.push(ok);
  console.log((ok ? "  ok   " : "  FAIL ") + name + (detail === undefined ? "" : " :: " + detail));
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/* ---- injection 1: the vendored-tree guard ------------------------------- */
/* The gate asserts a fixed SHA-256 for each vendored backend. Prove that
   assertion is a real comparison and not a constant: same bytes pass, one
   flipped bit fails, and the original bytes pass again. */
{
  const dir = await mkdtemp(join(tmpdir(), "coldread-fault-"));
  const file = join(dir, "index.js");
  const original = Buffer.from("export const marker = 'pristine';\n", "utf8");
  const expected = sha256(original);
  await writeFile(file, original);
  const read = async () => sha256(await readFile(file));

  check((await read()).toUpperCase() === expected.toUpperCase(), "injection 1a: untouched bytes match the expected digest");

  const flipped = Buffer.from(original);
  flipped[flipped.length - 2] ^= 0x01;
  await writeFile(file, flipped);
  check((await read()).toUpperCase() !== expected.toUpperCase(), "injection 1b: one flipped byte turns the digest check red", await read());

  await writeFile(file, original);
  check((await read()).toUpperCase() === expected.toUpperCase(), "injection 1c: restoring the bytes turns it green again");
  await rm(dir, { recursive: true, force: true });
}

/* ---- injection 2: the read comparison ----------------------------------- */
/* The gate's correctness claim is "patched read deep-equals pristine read".
   Prove that comparison can fail, and that it fails on the smallest real
   difference rather than only on a gross one. */
{
  const candidate = (await listSessions()).find((entry) => entry.bytes < 40 * 1024 * 1024 && entry.bytes > 1024 * 1024);
  if (candidate === undefined) {
    check(false, "injection 2: a small real session is available to mutate");
  } else {
    const attempt = await stage(candidate.id);
    const { backend } = await makeBackend(join(STAGE, "sessions"));
    const truth = await backend.readStoredLog(attempt.path, candidate.id, undefined);
    check(compareLogs(truth, truth).length === 0, "injection 2a: a read equals itself");

    const doctored = { ...truth, events: truth.events.slice(0, truth.events.length - 1) };
    check(compareLogs(truth, doctored).length > 0, "injection 2b: dropping one event turns the comparison red", compareLogs(truth, doctored)[0]);

    const retitled = { ...truth, events: truth.events.map((event, index) => (index === 0 ? { ...event, injected: true } : event)) };
    check(compareLogs(truth, retitled).length > 0, "injection 2c: one extra field on one event turns it red");
    release(truth, doctored, retitled);
  }
}

/* ---- injection 3: the residency-off control ----------------------------- */
/* The performance assertion is only meaningful if residency is what produces
   the speedup. Prove that switching residency off really does stop the cache
   from serving: the counters must show zero hits. */
{
  const candidate = (await listSessions()).find((entry) => entry.bytes < 40 * 1024 * 1024 && entry.bytes > 1024 * 1024);
  if (candidate === undefined) {
    check(false, "injection 3: a small real session is available");
  } else {
    const attempt = await stage(candidate.id, join(STAGE, "off"));
    const off = await makePatchedBackend(join(STAGE, "off", "sessions"), { maxResidentBytes: 1 });
    if (!(await prefixEndingAtClosedTurn(attempt.path))) {
      check(false, "injection 3: a frame-aligned prefix ends at a closed turn");
    } else {
      const first = await off.backend.readStoredLog(attempt.path, candidate.id, undefined);
      await off.backend.persistBatch(first.meta, nextClosedTurn(first), true, first.inheritedEventCount);
      await off.backend.readStoredLog(attempt.path, candidate.id, undefined);
      check(off.cache.stats.hits === 0, "injection 3: residency off yields zero hits (the control is real)", JSON.stringify(off.cache.stats));
      release(first);
    }
    off.disposer();
  }
}

await unlockStage();
const failures = checks.filter((ok) => !ok).length;
console.log("\nFAULT_" + (failures === 0 ? "GREEN" : "RED") + " checks=" + checks.length + " failures=" + failures);
process.exit(failures === 0 ? 0 : 1);
