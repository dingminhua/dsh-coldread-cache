/**
 * Which part of assertReleasedV4Relationships actually costs the time?
 *
 * The stage breakdown showed that function is ~90% of a per-extension cost of 63 ms on
 * a 55k-event session. It is not one thing: it runs per-event checks over every event
 * (assertV4DeveloperData, assertV4MessageSources, validateDeliveryAccepted) and then a
 * sequential lifecycle state machine that only processes RELATIONSHIP_TYPES events.
 * Those two have completely different incrementalization stories, so the next decision
 * needs the split rather than the total.
 *
 * A sampling profile is used because the per-event helpers are module-local and cannot
 * be called directly, and because self time attributes cost to the function that owns
 * it rather than to the wrapper that calls it.
 *
 * Run: node --expose-gc --cpu-prof --cpu-prof-dir=.prof tests/probe-validator-profile.mjs
 */
import { readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { assertReleasedV4Relationships } from "@deepseek-ai/dsh-session-format-v3-to-v4";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import {
  cleanStage, listSessions, makePatchedBackend, release, stage, STAGE, unlockStage,
} from "./gate/harness.mjs";
import { join } from "node:path";

await cleanStage();
const all = await listSessions();
const big = all.find((e) => e.bytes > 8 * 1048576 && e.bytes < 60 * 1048576);
if (big === undefined) { console.log("PROBE_FAIL no fixture"); process.exit(2); }
const staged = await stage(big.id);

const { backend, cache, disposer } = await makePatchedBackend(join(STAGE, "sessions"), {});
const log = await backend.readStoredLog(staged.path, big.id, undefined);
const entry = cache.get(big.id);
console.log("fixture: " + Math.round(staged.bytes / 1048576) + " MB, events: " + log.events.length);

const artifact = {
  header: entry.meta,
  inheritedEventCount: entry.inheritedEventCount,
  events: entry.events,
};

// Warm up, then time the loop so the profile covers real repeated work.
assertReleasedV4Relationships(artifact, KNOWN_SESSION_EVENT_TYPES);
const ROUNDS = 12;
const t0 = performance.now();
for (let i = 0; i < ROUNDS; i += 1) {
  assertReleasedV4Relationships(artifact, KNOWN_SESSION_EVENT_TYPES);
}
const total = performance.now() - t0;
console.log("validator: " + (total / ROUNDS).toFixed(1) + " ms per call over " + ROUNDS + " rounds\n");

release(log);
disposer();
await unlockStage();
console.log("PROBE_VALIDATOR ok");