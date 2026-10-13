import { cleanStage, listSessions, makePatchedBackend, release, stage, STAGE, unlockStage } from "./gate/harness.mjs";
await cleanStage();
const all = await listSessions();
const pick = all.filter((e) => e.bytes > 65536 && e.bytes < 4 * 1048576).slice(0, 3);
const staged = [];
for (const e of pick) staged.push(await stage(e.id));
const { backend, cache, disposer } = makePatchedBackend(STAGE + "\\sessions", {});
const log = await backend.readStoredLog(staged[0].path, pick[0].id, undefined);
console.log("residentIds: " + JSON.stringify(cache.residentIds));
console.log("hotIds:      " + JSON.stringify(cache.hotIds));
console.log("hotCount:    " + cache.hotCount);
// After a write, the id must show up in hotIds.
const writer = await backend.open(pick[0].id, "write");
await writer.close();
cache.noteWrite(pick[0].id);
console.log("after noteWrite -> hotIds: " + JSON.stringify(cache.hotIds));
console.log("resident entry carries the rank: " + JSON.stringify(cache.get(pick[0].id)?.writes));
// Read the fields BEFORE disposing: the disposer uninstalls the plugin and clears
// the cache, so asserting afterwards would test an empty cache rather than the
// document. (The first version of this probe did exactly that and failed.)
const residentIds = cache.residentIds.slice();
const hotIds = cache.hotIds.slice();
const ranked = cache.get(pick[0].id)?.writes;
const maxBytes = cache.maxBytes;
const maxEntries = cache.maxEntries;
const overBudget = cache.bytes > cache.maxBytes;
console.log("budget: maxBytes=" + maxBytes + " maxEntries=" + maxEntries + " overBudget=" + overBudget);
release(log);
disposer();
await unlockStage();
const ok =
  residentIds.length === 1 &&
  residentIds[0] === pick[0].id.slice(0, 12) &&
  hotIds.includes(pick[0].id.slice(0, 12)) &&
  ranked === 1 &&
  maxBytes === 128 * 1024 * 1024 &&
  maxEntries === 8 &&
  overBudget === false;
console.log("asserting: residentIds=" + JSON.stringify(residentIds) + " hotIds=" + JSON.stringify(hotIds) + " writes=" + ranked);
console.log(ok ? "STATUS_FIELDS ok" : "STATUS_FIELDS FAIL");
process.exit(ok ? 0 : 1);