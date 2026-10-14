/**
 * Is the header cache actually HITTING, and does it stay correct?
 *
 * The stage probe showed listArtifacts drop from 2964 ms to 701 ms, which is consistent with a
 * working cache -- but a cache that silently misses would also be slower, not faster, so the
 * speed alone does not prove the mechanism. This reads the cache's OWN counters, so "it is
 * working" is an observation rather than an inference.
 *
 * It then attacks the two ways a header cache can be wrong:
 *   - a header that CHANGED must not be served from cache (invalidation)
 *   - a header must never be attributed to a DIFFERENT session (identity mix-up)
 *
 * Both attacks are run against a staged COPY, so no real artifact is modified.
 *
 * Run: node --expose-gc --max-old-space-size=12288 tests/probe-header-cache.mjs
 */
import { performance } from "node:perf_hooks";
import { readFile, writeFile, utimes, stat, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { SESSIONS, STAGE, cleanStage, listSessions, makeBackend, makePatchedBackend, release, unlockStage } from "./gate/harness.mjs";

await cleanStage();
const ROOT = SESSIONS;
const all = await listSessions();
console.log("corpus: " + all.length + " artifacts");

let failures = 0;
const check = (ok, label, detail) => {
  if (ok) console.log("  ok   " + label);
  else { failures += 1; console.log("  FAIL " + label + (detail === undefined ? "" : " :: " + detail)); }
};
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

// ---- 1. the counters, read from the plugin's own status document
{
  const { backend, state, disposer } = makePatchedBackend(ROOT, { statusFile: "" });
  await backend.list({});                       // populates
  await backend.list({});                       // must hit
  await backend.list({});                       // must hit
  const ownership = backend[Symbol.for("dsh.coldread-cache.ownership")];
  const headers = ownership?.headers?.toJSON?.();
  console.log("");
  console.log("    header cache counters: " + JSON.stringify(headers ?? "(not exposed)"));
  check(headers !== undefined, "the header cache exposes counters");
  if (headers !== undefined) {
    check(headers.misses > 0, "the first list was a set of misses (it had to read)", String(headers.misses));
    check(headers.hits > 0, "later lists hit the cache", String(headers.hits));
    check(headers.hits > headers.misses, "hits dominate after the first pass",
      headers.hits + " hits / " + headers.misses + " misses");
  }
  disposer();
}

// ---- 2. invalidation, on a staged copy, proved able to fail
{
  // Copy one real artifact into the stage root so nothing real is touched. The backend binds
  // an artifact to the path derived from its own header, so the project directory must be
  // the one the header names -- stage() does exactly that.
  const pick = all.slice().sort((a, b) => b.bytes - a.bytes).find((e) => e.bytes > 4 * 1048576 && e.bytes < 20 * 1048576 && !e.torn);
  const stagedRoot = STAGE + "\\sessions";
  const target = join(stagedRoot, pick.project, pick.id, "session.v4.jsonl.zstd");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(pick.path));

  const { backend, disposer } = makePatchedBackend(stagedRoot, {});
  const first = await backend.list({});
  check(first.length === 1, "the staged corpus lists one session", String(first.length));
  const firstHeader = first[0]?.header;

  const second = await backend.list({});
  check(second.length === 1 && second[0]?.header?.id === firstHeader?.id,
    "a repeated list returns the same session id");

  // Attack: change the file so its identity moves, then require the header to be re-read.
  const before = await stat(target, { bigint: true });
  const now = Date.now() / 1000;
  await utimes(target, now, now + 10);
  const after = await stat(target, { bigint: true });
  check(after.mtimeNs !== before.mtimeNs, "the artifact's identity really changed",
    String(before.mtimeNs) + " -> " + String(after.mtimeNs));

  const third = await backend.list({});
  check(third.length === 1 && third[0]?.header?.id === firstHeader?.id,
    "the changed artifact still reports its OWN header (no cross-session mix-up)",
    JSON.stringify(third.map((s) => s.header?.id)));

  // Attack: corrupt the header frame so the file is unreadable, then require the cache to
  // NOT keep serving the old header. A cache that ignored identity would still answer here.
  await writeFile(target, Buffer.from("not a zstd frame at all"));
  const fourth = await backend.list({});
  check(fourth.length === 0,
    "a corrupted artifact is no longer listed (the cache did not serve the old header)",
    "listed " + fourth.length);
  disposer();
}

await unlockStage();
console.log("");
console.log("PROBE_HEADERS_" + (failures === 0 ? "ok" : "FAIL"));
process.exit(failures === 0 ? 0 : 1);
