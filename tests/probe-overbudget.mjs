import { cleanStage, listSessions, makePatchedBackend, release, stage, STAGE, unlockStage } from "./gate/harness.mjs";
await cleanStage();
const all = await listSessions();
const big = all.find((e) => e.bytes > 4 * 1048576 && e.bytes < 40 * 1048576);
if (big === undefined) { console.log("PROBE_FAIL"); process.exit(2); }
const staged = await stage(big.id);
// A budget far below one session: this is the state the live host was in when its
// counters showed zero extensions, and the status document must make it obvious.
const { backend, cache, disposer } = makePatchedBackend(STAGE + "\\sessions", { maxResidentBytes: 1024 * 1024 });
const log = await backend.readStoredLog(staged.path, big.id, undefined);
console.log("resident bytes: " + cache.bytes + "  maxBytes: " + cache.maxBytes);
console.log("overBudget:     " + (cache.bytes > cache.maxBytes) + "   (must be true)");
console.log("entries:        " + cache.size + "   (must stay 1: the last entry is never evicted)");
const ok = cache.bytes > cache.maxBytes && cache.size === 1;
release(log);
disposer();
await unlockStage();
console.log(ok ? "OVERBUDGET ok" : "OVERBUDGET FAIL");
process.exit(ok ? 0 : 1);