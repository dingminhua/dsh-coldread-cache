/**
 * Does anyone mutate the artifact during a torn-tail read?
 *
 * The gate's section 3 compares a pristine read against a patched read of the same damaged file.
 * It failed once in eight runs with exactly one differing event, and neither the isolated
 * 12-round reproduction nor any later run reproduced it. Before treating that as a plugin defect,
 * rule out the simplest explanation: that one of the two reads CHANGES the file, so the second
 * read is not looking at the same bytes as the first.
 *
 * This hashes the artifact around every step of section 3's exact sequence.
 *
 * Run: node --expose-gc --max-old-space-size=12288 tests/probe-torn-mutation.mjs
 */
import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  cleanStage, listSessions, makeBackend, makePatchedBackend, nextClosedTurn,
  prefixEndingAtClosedTurn, release, stage, STAGE, unlockStage,
} from "./gate/harness.mjs";

await cleanStage();
const { scanZstdFrames } = await import("../lib/pristine.js");

let failures = 0;
const check = (ok, label, detail) => {
  if (ok) console.log("  ok   " + label);
  else { failures += 1; console.log("  FAIL " + label + (detail === undefined ? "" : " :: " + detail)); }
};

const corpus = await listSessions();
let big;
let staged;
for (const candidate of corpus) {
  const attempt = await stage(candidate.id);
  const probe = makeBackend(STAGE + "\\sessions");
  try {
    await probe.backend.readStoredLog(attempt.path, candidate.id, undefined);
    big = candidate;
    staged = attempt;
    break;
  } catch { /* unreadable artifacts are a different section */ }
}
check(big !== undefined, "found a readable corpus member");

const full = await readFile(staged.path);
const frames = scanZstdFrames(full).frames;
const cut = await prefixEndingAtClosedTurn(staged.path);
const tornBytes = Buffer.concat([cut.bytes, full.subarray(frames[cut.cut].start, frames[cut.cut].start + 9)]);

const digest = async () => {
  const bytes = await readFile(staged.path);
  const info = await stat(staged.path, { bigint: true });
  return { sha: createHash("sha256").update(bytes).digest("hex").slice(0, 16), size: bytes.length, mtime: String(info.mtimeNs) };
};

const root = STAGE + "\\sessions";
const pristine = makeBackend(root);
const patched = makePatchedBackend(root, {});

// Section 3's exact sequence, hashing at every step.
await writeFile(staged.path, cut.bytes);
await patched.backend.readStoredLog(staged.path, big.id, undefined);
const afterResidency = await digest();

const prefixLog = await pristine.backend.readStoredLog(staged.path, big.id, undefined);
const afterPrefixRead = await digest();
const appended = nextClosedTurn(prefixLog);
await patched.backend.persistBatch(prefixLog.meta, appended, true, prefixLog.inheritedEventCount);
const afterAppend = await digest();
release(prefixLog);

await writeFile(staged.path, tornBytes);
const atTornWrite = await digest();

const expected = await pristine.backend.readStoredLog(staged.path, big.id, undefined);
const afterPristineRead = await digest();
const actual = await patched.backend.readStoredLog(staged.path, big.id, undefined);
const afterPatchedRead = await digest();

console.log("");
console.log("  file state through section 3's sequence");
console.log("    after residency      " + JSON.stringify(afterResidency));
console.log("    after prefix read    " + JSON.stringify(afterPrefixRead));
console.log("    after append         " + JSON.stringify(afterAppend));
console.log("    at torn write        " + JSON.stringify(atTornWrite));
console.log("    after pristine read  " + JSON.stringify(afterPristineRead));
console.log("    after patched read   " + JSON.stringify(afterPatchedRead));
console.log("");

const key = (d) => d.sha + ":" + d.size;
check(key(atTornWrite) === key(afterPristineRead),
  "the PRISTINE read did not change the artifact",
  key(atTornWrite) + " -> " + key(afterPristineRead));
check(key(afterPristineRead) === key(afterPatchedRead),
  "the PATCHED read did not change the artifact",
  key(afterPristineRead) + " -> " + key(afterPatchedRead));
check(key(atTornWrite) === key(afterPatchedRead),
  "both backends read the same bytes (no mutation between the two reads)",
  key(atTornWrite) + " vs " + key(afterPatchedRead));

// The two answers, compared exactly and as sets, on bytes proven identical.
const same = JSON.stringify(expected.events) === JSON.stringify(actual.events);
check(same, "on identical bytes the two answers are byte-identical in order AND content",
  "pristine " + expected.events.length + " events, patched " + actual.events.length);
check(expected.tornTruncateTo === actual.tornTruncateTo,
  "both agree on where the tail would be truncated",
  String(expected.tornTruncateTo) + " vs " + String(actual.tornTruncateTo));
check(JSON.stringify(expected.recoveredTail) === JSON.stringify(actual.recoveredTail),
  "both agree on the recovered tail",
  (expected.recoveredTail?.length ?? 0) + " vs " + (actual.recoveredTail?.length ?? 0));

// Repeatability: a second pristine read of the SAME bytes must give the same answer, and so
// must a second patched read. If a read is not repeatable, the difference is not about which
// backend ran.
const pristineAgain = await pristine.backend.readStoredLog(staged.path, big.id, undefined);
check(JSON.stringify(pristineAgain.events) === JSON.stringify(expected.events),
  "the pristine read is repeatable on identical bytes",
  pristineAgain.events.length + " vs " + expected.events.length);
const patchedAgain = await patched.backend.readStoredLog(staged.path, big.id, undefined);
check(JSON.stringify(patchedAgain.events) === JSON.stringify(expected.events),
  "the patched read is repeatable on identical bytes",
  patchedAgain.events.length + " vs " + expected.events.length);

release(expected, actual, pristineAgain, patchedAgain);
pristine.disposer?.();
patched.disposer();
await unlockStage();
console.log("");
console.log("PROBE_MUTATION_" + (failures === 0 ? "ok" : "FAIL"));
process.exit(failures === 0 ? 0 : 1);
