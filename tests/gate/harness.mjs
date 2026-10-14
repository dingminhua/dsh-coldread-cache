/**
 * Gate harness: drive the real vendored session backend and a plugin-patched
 * backend over the same private session copies, and compare.
 *
 * Nothing here touches a live host's artifacts: every file is a private copy
 * under .stage, and the real backend is instantiated directly.
 * @module dsh-coldread-cache/gate/harness
 */
import { mkdir, open, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as cordis from "@deepseek-ai/cordis";
import * as jsonlModule from "@deepseek-ai/dsh-session-persistence-jsonl";

const Cordis = cordis.default ?? cordis;
const JsonlSessionPersistence = jsonlModule.default ?? jsonlModule.JsonlSessionPersistence;
import { applyToService } from "../../lib/index.js";

// Where the real sessions live. DSH_HOME is what the host itself uses, so the
// default follows it rather than naming one machine's disk. Missing it is an
// error, not a reason to guess.
export const SESSIONS = process.env.DSH_SESSIONS ?? (process.env.DSH_HOME ? process.env.DSH_HOME + "\\sessions" : "");
// The stage root is overridable so two test processes can never share fixtures:
// each one writes and truncates artifacts, and a shared root makes one run
// corrupt the other's sessions (measured: the gate saw a live host's append).
// Each entry script gets its own default root: they write and truncate real
// fixtures, so sharing one root lets a concurrent run corrupt the other's
// artifact (measured: the gate saw a live host's append, and a perf run lost its
// staged copy mid-loop). GATE_STAGE still overrides both.
const ENTRY = process.argv[1] ?? "";
const ROLE = /perf-ab\.mjs$/.test(ENTRY) ? "perf" : "gate";
export const STAGE = process.env.GATE_STAGE ?? join(process.cwd(), ROLE === "perf" ? ".stage-perf" : ".stage");
export const ORIGIN = STAGE + "\\origin";

let failures = 0;
let checks = 0;

export function check(ok, label, detail) {
  checks += 1;
  if (ok) {
    console.log("  ok   " + label);
  } else {
    failures += 1;
    console.log("  FAIL " + label + (detail === undefined ? "" : " :: " + detail));
  }
  return ok;
}

export function section(title) {
  console.log("\n== " + title);
}

export function summary() {
  console.log("\nGATE_" + (failures === 0 ? "GREEN" : "RED") + " checks=" + checks + " failures=" + failures);
  return failures === 0;
}

/** A context with the logging surface the backend expects. */
export function makeContext() {
  const ctx = new Cordis.Context();
  const lines = [];
  ctx.logger = {
    debug: () => {},
    info: (message) => lines.push("info " + message),
    warn: (message) => lines.push("warn " + message),
    error: (message) => lines.push("error " + message),
  };
  return { ctx, lines };
}

/** One pristine backend instance over a root. */
export function makeBackend(root) {
  const { ctx, lines } = makeContext();
  const backend = new JsonlSessionPersistence(ctx, { root, compression: "zstd" });
  return { ctx, backend, lines };
}

/**
 * A backend instance with the plugin attached.
 *
 * `existing` lets a caller patch an instance it already holds, which is how the
 * restore check proves that unmounting leaves the instance exactly as it was.
 */
export function makePatchedBackend(root, config = {}, existing) {
  const { ctx, lines } = makeContext();
  const backend = existing ?? new JsonlSessionPersistence(ctx, { root, compression: "zstd" });
  const service = { [Symbol.for("cordis.original")]: backend };
  const disposer = applyToService(ctx, service, config);
  if (disposer === undefined) throw new Error("harness: the plugin did not attach");
  const state = backend[Symbol.for("dsh.coldread-cache.ownership")];
  return { ctx, backend, disposer, state, lines, cache: state?.cache };
}

/**
 * Copy one real session's artifact under a staging root.
 *
 * The origin root exists because the backend's identity assertion binds an
 * artifact to the path derived from its own header, so two compared copies must
 * live under different roots.
 */
export async function stage(sessionId, root = STAGE) {
  const match = await findSession(sessionId);
  if (match === undefined) throw new Error("harness: no session " + sessionId);
  const rel = relative(SESSIONS, match.path);
  const target = join(root, "sessions", rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(match.path));
  return { path: target, id: sessionId, bytes: match.bytes, source: match.path, rel };
}

/** Locate one session artifact by id, with its size. */
export async function findSession(sessionId) {
  for (const project of await readdir(SESSIONS)) {
    const dir = join(SESSIONS, project, sessionId);
    const path = join(dir, "session.v4.jsonl.zstd");
    const info = await stat(path).catch(() => undefined);
    if (info !== undefined) return { project, path, bytes: Number(info.size) };
  }
  return undefined;
}

/** The largest staged-able sessions, biggest first, excluding unreadable ones. */
export async function listSessions() {
  const out = [];
  for (const project of await readdir(SESSIONS)) {
    const entries = await readdir(join(SESSIONS, project), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(SESSIONS, project, entry.name, "session.v4.jsonl.zstd");
      const info = await stat(path).catch(() => undefined);
      if (info !== undefined) out.push({ id: entry.name, project, path, bytes: Number(info.size) });
    }
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}

/**
 * Take the stage root exclusively.
 *
 * The stage is shared mutable state: every entry script wipes and rewrites
 * tens-of-megabyte fixtures there. Two concurrent runs do not merely race, they
 * corrupt each other — measured twice (a perf run lost its staged copy mid-loop
 * with ENOENT, and a gate read another run's half-written artifact and reported
 * "second read still equals pristine ... revision ... != ...").
 *
 * A lock whose owner is gone is broken immediately, so a killed run cannot wedge
 * the suite; only a lock held by a live process is honoured, and that one is
 * reported instead of waited on.
 */
export async function cleanStage() {
  const lock = join(STAGE, ".lock");
  await mkdir(STAGE, { recursive: true });
  // Exclusive create, so two runs starting at the same instant cannot both win.
  let held = false;
  try {
    const handle = await open(lock, "wx");
    await handle.writeFile(String(process.pid) + " " + new Date().toISOString());
    await handle.close();
    held = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if (!held) {
    const owner = Number((await readFile(lock, "utf8").catch(() => "")).trim().split(/\s+/)[0]);
    const alive = Number.isInteger(owner) && owner > 0 && isAlive(owner);
    if (alive) {
      const stale = await stat(lock).catch(() => undefined);
      throw new Error(
        "another run owns the stage root " + STAGE + " (pid " + owner + ", lock is " +
          Math.round((Date.now() - (stale?.mtimeMs ?? Date.now())) / 1000) + "s old). " +
          "Run them one at a time, or point GATE_STAGE at a private directory.",
      );
    }
    // The owner is gone: its fixtures are abandoned, and waiting out an age
    // timeout would only waste the next run's time.
    console.log("  note  breaking an abandoned stage lock" + (owner > 0 ? " (pid " + owner + " is gone)" : ""));
    await writeFile(lock, String(process.pid) + " " + new Date().toISOString());
  }
  await rm(join(STAGE, "sessions"), { recursive: true, force: true });
  await rm(join(STAGE, "origin"), { recursive: true, force: true });
  await rm(join(STAGE, "control"), { recursive: true, force: true });
  await mkdir(join(STAGE, "sessions"), { recursive: true });
  await mkdir(join(ORIGIN, "sessions"), { recursive: true });
}

/**
 * Whether a pid is still running.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. EPERM means the process exists but belongs to someone else, which
 * still counts as alive.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Release the stage lock. Entry scripts call this on their way out. */
export async function unlockStage() {
  await rm(join(STAGE, ".lock"), { force: true });
}

/** Hand memory back between sections: these fixtures are tens of megabytes. */
export function release(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (value.backend !== undefined) value.backend.coldLogMemo?.clear?.();
  }
  globalThis.gc?.();
}

/**
 * The first object in an event graph that is NOT frozen, as a path, or undefined.
 *
 * The extension path only freezes the events an append adds, and trusts that the
 * resident ones were frozen when they first arrived. That trust is the entire
 * basis of the optimization (deep-freezing the whole merged list cost 191 ms per
 * turn on a 60k-event log, and it grows with the session), so the gate verifies it
 * against real output instead of assuming it. A violation is reported as a path so
 * a failure says WHERE the graph is open, not just that it is.
 */
export function unfrozenIn(value, path = "$") {
  const pending = [[value, path]];
  const seen = new Set();
  while (pending.length > 0) {
    const [current, where] = pending.pop();
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (!Object.isFrozen(current)) return where;
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) pending.push([current[index], where + "[" + index + "]"]);
    } else {
      for (const key of Object.keys(current)) pending.push([current[key], where + "." + key]);
    }
  }
  return undefined;
}

export async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Compare two stored logs the way the plugin promises they are comparable. */
export function compareLogs(a, b, options = {}) {
  const diffs = [];
  if (a === undefined || b === undefined) {
    diffs.push("one side is undefined");
    return diffs;
  }
  const keys = ["status", "eventState", "inheritedEventCount", "tornTruncateTo"];
  if (options.revision !== false) keys.push("revision");
  for (const key of keys) {
    if (a[key] !== b[key]) diffs.push(key + ": " + String(a[key]) + " != " + String(b[key]));
  }
  if (JSON.stringify(a.meta) !== JSON.stringify(b.meta)) diffs.push("meta differs");
  if (a.events.length !== b.events.length) diffs.push("events: " + a.events.length + " != " + b.events.length);
  if (options.order === "set") {
    // A torn artifact leaves recovery latitude, so the two sides may legitimately
    // stop at different points; this says whether they recovered the same set.
    const left = a.events.map((event) => JSON.stringify(event)).sort();
    const right = b.events.map((event) => JSON.stringify(event)).sort();
    // "differ at N positions" alone cannot be acted on: it does not say whether a whole event
    // is missing, one event was recovered twice, or a single field came out different. Report
    // the multiset difference and the first differing pair, so a red run is diagnosable.
    const counts = new Map();
    for (const event of left) counts.set(event, (counts.get(event) ?? 0) + 1);
    for (const event of right) counts.set(event, (counts.get(event) ?? 0) - 1);
    const onlyLeft = [...counts].filter(([, n]) => n > 0).map(([event, n]) => n + "x " + event.slice(0, 120));
    const onlyRight = [...counts].filter(([, n]) => n < 0).map(([event, n]) => -n + "x " + event.slice(0, 120));
    // A multiset difference IS the answer. An earlier version also compared the sorted arrays
    // element-wise and pushed a diff unconditionally -- but equal multisets make the sorted
    // arrays equal by construction, so that branch could only ever report "no difference" as a
    // failure. It turned a passing comparison red.
    if (onlyLeft.length > 0) {
      diffs.push("only in pristine (" + onlyLeft.length + "): " + onlyLeft.slice(0, 2).join(" | "));
    }
    if (onlyRight.length > 0) {
      diffs.push("only in patched (" + onlyRight.length + "): " + onlyRight.slice(0, 2).join(" | "));
    }
    return diffs;
  }
  // Deep equality, not a JSON round trip: these logs hold tens of thousands of
  // events and building both sides' JSON per comparison dominated the gate's
  // runtime (measured: a whole run wall-clock of over ten minutes, nearly all of
  // it in this loop). isDeepStrictEqual is the same predicate the backend uses.
  const count = Math.min(a.events.length, b.events.length);
  for (let index = 0; index < count; index += 1) {
    if (!isDeepStrictEqual(a.events[index], b.events[index])) {
      diffs.push("event " + index + " differs");
      if (diffs.length > 6) break;
    }
  }
  const tail = Math.min(a.recoveredTail?.length ?? 0, b.recoveredTail?.length ?? 0);
  if ((a.recoveredTail?.length ?? 0) !== (b.recoveredTail?.length ?? 0)) diffs.push("recoveredTail length differs");
  for (let index = 0; index < tail; index += 1) {
    if (!isDeepStrictEqual(a.recoveredTail[index], b.recoveredTail[index])) {
      diffs.push("recoveredTail " + index + " differs");
      break;
    }
  }
  return diffs;
}

/**
 * Build one syntactically complete, already-closed turn.
 *
 * The released lifecycle validator is strict and does not accept cloning: turn
 * numbers must be `1, 2, 3 ...` with no gaps (`turn/start does not open the
 * expected turn`), a turn may not open while one is open, a step may only close
 * when no tool call is unresolved, and a turn may only close once its step is.
 * A real session captured mid-turn ends with an unresolved tool call, so an
 * appended batch must not try to close that turn. This builds a fresh, empty
 * turn numbered after the last one the log closed, which is the smallest legal
 * continuation and the shape a real host writes when a turn begins.
 *
 * @param log - a stored log whose events are not modified.
 * @returns the closed turn's rows, ready to hand to `persistBatch`.
 */
export function nextClosedTurn(log) {
  const events = log.events;
  // The validator numbers turns from 1 with no gaps, so the next legal turn is
  // one past the highest number the log opened -- which is not the same as the
  // number of turns it closed, because a log may end mid-turn.
  const turn = events.reduce((max, event) => (event.type === "turn/start" && Number.isFinite(event.data?.turn) ? Math.max(max, event.data.turn) : max), 0) + 1;
  let seq = events.length;
  const at = Date.now();
  const row = (type, data) => ({ type, seq: seq++, time: at, data });
  return [
    row("turn/start", { turn }),
    row("step/start", { turn, step: 1 }),
    row("step/end", { turn, step: 1 }),
    row("turn/end", { turn, reason: { kind: "completed" } }),
  ];
}

/**
/**
 * Byte offset just past the last complete frame that ends a turn.
 *
 * A batch may only continue a log whose last turn is closed, so a fixture cut
 * anywhere else cannot take an append at all (`turn/start does not open the
 * expected turn`). Walking frame prefixes through the backend costs one cold
 * parse per step, which is minutes on a large artifact, so this decodes each
 * frame's own records directly: one frame holds whole records and corresponds to
 * one append batch, and a `turn/end` in that batch closes the turn.
 *
 * @param path - a compressed session log.
 * @returns `{ bytes, cut, frames }` for the shortest prefix that ends a turn.
 */
export async function prefixEndingAtClosedTurn(path) {
  const { scanZstdFrames, decompressZstdFrameSync } = await import("../../lib/pristine.js");
  const full = await readFile(path);
  const frames = scanZstdFrames(full).frames;
  for (let index = frames.length - 1; index >= 1; index -= 1) {
    let text;
    try {
      text = decompressZstdFrameSync(full.subarray(frames[index].start, frames[index].end)).toString("utf8");
    } catch {
      continue;
    }
    if (!text.endsWith("\n")) continue;
    const types = text
      .slice(0, -1)
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line).type;
        } catch {
          return undefined;
        }
      });
    // The prefix must keep at least one frame after the closing one, so that the
    // appended batch is not the only growth the next read has to decode.
    const next = frames[index + 1];
    if (types.includes("turn/end") && next !== undefined) return { bytes: full.subarray(0, next.start), cut: index, frames };
  }
  return undefined;
}

/** Truncate a copy of the artifact mid-frame, to force a torn tail. */
export async function tornCopy(path, keepBytes) {
  const target = path + ".torn";
  await writeFile(target, (await readFile(path)).subarray(0, keepBytes));
  return target;
}

export { truncate, stat, readFile, writeFile, mkdir, rm };
