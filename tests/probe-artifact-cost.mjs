/**
 * Does entry.reader.artifact() already run the full released validation?
 *
 * The stage breakdown put 57 of 63 ms per extension inside
 * assertReleasedV4Relationships. The plugin calls that explicitly after
 * entry.reader.artifact(), but artifact() is restore.finish(), and the released
 * restore path ends in restoreReleasedV4Artifact -- which itself calls
 * assertReleasedV4Relationships. If both walk, the plugin pays twice for the same
 * full pass, on the one path a host takes every turn.
 *
 * Run: node --expose-gc tests/probe-artifact-cost.mjs
 */
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { assertReleasedV4Relationships } from "@deepseek-ai/dsh-session-format-v3-to-v4";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import {
  cleanStage, listSessions, makePatchedBackend, nextClosedTurn, prefixEndingAtClosedTurn, release, stage,
  STAGE, unlockStage,
} from "./gate/harness.mjs";

await cleanStage();
const all = await listSessions();
let fixture;
for (const candidate of all) {
  if (candidate.bytes > 60 * 1048576 || candidate.bytes < 8 * 1048576) continue;
  const copy = await stage(candidate.id);
  const closed = await prefixEndingAtClosedTurn(copy.path);
  if (closed === undefined) continue;
  await writeFile(copy.path, closed.bytes);
  fixture = copy;
  break;
}
if (fixture === undefined) { console.log("PROBE_FAIL no fixture"); process.exit(2); }

const { backend, cache, disposer } = makePatchedBackend(STAGE + "\\sessions", {});
const writer = await backend.open(fixture.id, "write");
let read = await writer.read();
const entry = cache.get(fixture.id);
console.log("fixture: " + Math.round(fixture.bytes / 1048576) + " MB, events: " + read.events.length);

const R = 8;
let artifactMs = 0;
let validatorMs = 0;

entry.reader.artifact();
{
  const t0 = performance.now();
  for (let i = 0; i < R; i += 1) entry.reader.artifact();
  artifactMs = (performance.now() - t0) / R;
}
{
  const art = { header: entry.meta, inheritedEventCount: entry.inheritedEventCount, events: entry.events };
  assertReleasedV4Relationships(art, KNOWN_SESSION_EVENT_TYPES);
  const t0 = performance.now();
  for (let i = 0; i < R; i += 1) assertReleasedV4Relationships(art, KNOWN_SESSION_EVENT_TYPES);
  validatorMs = (performance.now() - t0) / R;
}

console.log("");
console.log("  entry.reader.artifact()                   " + artifactMs.toFixed(1) + " ms");
console.log("  assertReleasedV4Relationships (explicit)  " + validatorMs.toFixed(1) + " ms");
const redundant = artifactMs > validatorMs * 0.5;
console.log("");
console.log("  artifact() already pays for the full walk: " + redundant);
console.log(redundant
  ? "  => the explicit call is redundant, ~" + validatorMs.toFixed(0) + " ms per extension"
  : "  => the explicit call is the only validation; artifact() is cheap");

await writer.close();
release(read);
disposer();
await unlockStage();
console.log("");
console.log("PROBE_ARTIFACT ok");
