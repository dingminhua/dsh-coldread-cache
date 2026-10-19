/**
 * Can the per-extension validation cover only the appended events?
 *
 * The stage breakdown measured assertReleasedV4Relationships at ~50 ms of a 63 ms
 * extension on a 55k-event session, because it walks every event. Whether that is
 * optimizable turns on whether the walk is SEGMENTABLE: the released validator ends in
 * a sequential lifecycle state machine (turn/step/tool ownership), so an event's
 * acceptance can depend on earlier events. If validation cannot resume from a
 * checkpoint, the full walk is required for correctness and the cost is a floor.
 *
 * The first version of this probe called the validator on a tail slice OUTSIDE a try
 * and the process died with "tool/ptc-dispatch is outside an open turn". That exception
 * IS the answer, so this version captures it as evidence instead of crashing on it.
 *
 * Run: node --expose-gc tests/probe-validator-segments.mjs
 */
import { performance } from "node:perf_hooks";
import { assertReleasedV4Relationships } from "@deepseek-ai/dsh-session-format-v3-to-v4";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import { cleanStage, listSessions, makePatchedBackend, release, stage, STAGE, unlockStage } from "./gate/harness.mjs";
import { join } from "node:path";

await cleanStage();
const all = await listSessions();
const big = all.find((e) => e.bytes > 8 * 1048576 && e.bytes < 60 * 1048576);
if (big === undefined) { console.log("PROBE_FAIL no fixture"); process.exit(2); }
const staged = await stage(big.id);

const { backend, cache, disposer } = await makePatchedBackend(join(STAGE, "sessions"), {});
const log = await backend.readStoredLog(staged.path, big.id, undefined);
const entry = cache.get(big.id);
const events = entry.events;
console.log("fixture: " + Math.round(staged.bytes / 1048576) + " MB, events: " + events.length);

const artifact = { header: entry.meta, inheritedEventCount: entry.inheritedEventCount, events };
const R = 8;

/** Run the validator, returning either undefined or the refusal message. */
function attempt(candidate) {
  try {
    assertReleasedV4Relationships(candidate, KNOWN_SESSION_EVENT_TYPES);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Shape 1: the full walk, which is what the plugin does today. It must be accepted.
let fullMs = 0;
const fullRefusal = attempt(artifact);
{
  const t0 = performance.now();
  for (let i = 0; i < R; i += 1) assertReleasedV4Relationships(artifact, KNOWN_SESSION_EVENT_TYPES);
  fullMs = (performance.now() - t0) / R;
}

// Shape 2: only the tail, as if a checkpoint existed. Timed with the same R so the
// comparison is like for like even though it refuses.
const TAIL = 4;
const tailEvents = events.slice(-TAIL);
let tailMs = 0;
{
  const t0 = performance.now();
  for (let i = 0; i < R; i += 1) attempt({ header: entry.meta, inheritedEventCount: 0, events: tailEvents });
  tailMs = (performance.now() - t0) / R;
}

console.log("");
console.log("  full walk over all " + events.length + " events   " + fullMs.toFixed(1) + " ms   accepted=" + (fullRefusal === undefined));
console.log("  walk over only the last " + TAIL + " events     " + tailMs.toFixed(2) + " ms");
console.log("    tail-only refusal: " + (tailRefusalFor(tailEvents) ?? "accepted"));

// The decisive evidence: a tail slice cannot be validated in isolation, because the
// state machine that judges it lives in the events that came before.
function tailRefusalFor(candidateEvents) {
  return attempt({ header: entry.meta, inheritedEventCount: 0, events: candidateEvents });
}
const tailRefusal = tailRefusalFor(tailEvents);

// A segment starting right after a turn/end must also be refused, for the same reason.
const turnEnd = events.findIndex((e) => e.type === "turn/end");
const afterClose = events.slice(turnEnd + 1, turnEnd + 5);
const afterCloseRefusal = attempt({ header: entry.meta, inheritedEventCount: 0, events: afterClose });
console.log("  a segment after turn/end                    " + (afterCloseRefusal ?? "accepted"));

console.log("");
const segmentable = tailRefusal === undefined && afterCloseRefusal === undefined;
console.log("  the tail can be validated on its own: " + segmentable);
console.log(segmentable
  ? "  => the walk IS segmentable; a checkpoint would be worth building"
  : "  => the walk is NOT segmentable: acceptance depends on earlier events, so the");
if (!segmentable) {
  console.log("     full O(n) walk is required for correctness and 50 ms is a floor, not waste.");
  console.log("     The released package does not export the Relationships state machine, so a");
  console.log("     checkpoint would mean reimplementing released validation logic -- a");
  console.log("     correctness risk that this plugin deliberately does not take.");
}

release(log);
disposer();
await unlockStage();

const ok = !segmentable && fullRefusal === undefined && fullMs > tailMs * 10;
console.log("");
console.log(ok
  ? "PROBE_SEGMENTS ok"
  : "PROBE_SEGMENTS FAIL -- re-examine before optimizing");
process.exit(ok ? 0 : 1);
