/**
 * Multi-version compatibility: run the plugin against a DIFFERENT installed DSH.
 *
 * The plugin statically imports seven @deepseek-ai packages and patches five methods
 * on the jsonl backend. Two DSH installs exist on this machine (0.2.0-rc.2 and
 * 0.2.1-alpha.2), and the plugin resolves its imports through whatever tree the host
 * provides -- so "compatible" has to mean "works against that tree", not "works
 * against the one I developed on".
 *
 * This harness points module resolution at a chosen tree, attaches the plugin to that
 * tree's real backend, and drives a real append-then-read cycle over a real artifact.
 * A version whose backend shape moved fails here rather than in a user's host.
 *
 * Usage: node tests/compat.mjs <path-to-@deepseek-ai> [stageRoot]
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readFile, writeFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const TREE = process.argv[2];
if (!TREE) {
  console.log("usage: node tests/compat.mjs <path-to-@deepseek-ai> [stageRoot]");
  process.exit(2);
}

// Resolve every dependency through the chosen tree, so this is a real test of that
// install and not of the one this repository happens to be linked against.
const require_ = createRequire(join(TREE, "noop.js"));
const resolveIn = (spec) => require_.resolve(spec);
const load = async (spec) => import(pathToFileURL(resolveIn(spec)).href);

const cordisModule = await load("@deepseek-ai/cordis");
const Cordis = cordisModule.default ?? cordisModule;
const jsonlModule = await load("@deepseek-ai/dsh-session-persistence-jsonl");
const JsonlSessionPersistence = jsonlModule.default ?? jsonlModule.JsonlSessionPersistence;
const plugin = await import("../lib/index.js");

const SESSIONS = process.env.DSH_SESSIONS ?? (process.env.DSH_HOME ? process.env.DSH_HOME + "\\sessions" : "");
const STAGE = process.argv[3] ?? join(process.cwd(), ".stage-compat");
const ROOT = STAGE + "\\sessions";

let failures = 0;
let checks = 0;
function check(ok, label, detail) {
  checks += 1;
  if (ok) console.log("  ok   " + label);
  else { failures += 1; console.log("  FAIL " + label + (detail === undefined ? "" : " :: " + detail)); }
  return ok;
}

console.log("== the tree under test: " + TREE);
for (const spec of [
  "@deepseek-ai/dsh-session-persistence-jsonl",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-session-format-v3-to-v4",
  "@deepseek-ai/dsh-session-persistence",
  "@deepseek-ai/dsh-session-format-catalog",
  "@deepseek-ai/dsh-session-format",
  "@deepseek-ai/schemastery",
]) {
  // Walk up from the resolved entry point to the nearest package.json. Matching a
  // path pattern instead was wrong for any package whose main is not lib/index.js
  // (schemastery's is lib/index.cjs), and it reported the module's SOURCE as its
  // version rather than failing visibly.
  let dir = dirname(resolveIn(spec));
  let pkg;
  for (let depth = 0; depth < 4 && pkg === undefined; depth += 1) {
    const candidate = join(dir, "package.json");
    const text = await readFile(candidate, "utf8").catch(() => undefined);
    if (text !== undefined) {
      const parsed = JSON.parse(text);
      if (typeof parsed.version === "string") pkg = parsed;
    }
    dir = dirname(dir);
  }
  console.log("   " + spec.replace("@deepseek-ai/", "").padEnd(34) + (pkg?.version ?? "?"));
}

// 1. every export the plugin imports must exist in THIS tree.
{
  const session = await load("@deepseek-ai/dsh-session");
  const persistence = await load("@deepseek-ai/dsh-session-persistence");
  const v34 = await load("@deepseek-ai/dsh-session-format-v3-to-v4");
  const catalog = await load("@deepseek-ai/dsh-session-format-catalog");
  const format = await load("@deepseek-ai/dsh-session-format");
  const needed = [
    [session, ["KNOWN_SESSION_EVENT_TYPES", "SESSION_FORMAT_VERSION"]],
    [persistence, ["assertStoredId", "validateStoredEvents", "SessionPersistenceRevision", "SessionFormatUnsupportedError"]],
    [v34, ["assertReleasedV4Relationships", "assertV4RowAdmission"]],
    [catalog, ["sessionFormatCatalog"]],
    [format, ["SessionFormatUnsupportedMigrationError"]],
  ];
  for (const [module, names] of needed) {
    const missing = names.filter((n) => module[n] === undefined);
    check(missing.length === 0, "every import the plugin needs exists in this tree", missing.join(", "));
  }
  check(session.KNOWN_SESSION_EVENT_TYPES instanceof Set, "KNOWN_SESSION_EVENT_TYPES is a Set");
}

// 2. the backend must expose all five patch points as functions.
{
  const missing = ["readStoredLog", "decodeStoredLog", "persistBatch", "persistHeader", "truncateTornTail"]
    .filter((k) => typeof JsonlSessionPersistence.prototype[k] !== "function");
  check(missing.length === 0, "all five patch points are functions on the backend prototype", missing.join(", "));
}

// 3. attach the plugin to THIS tree's backend and drive a real cycle.
{
  const ctx = new Cordis.Context();
  const logs = [];
  ctx.logger = { debug: () => {}, info: () => {}, warn: (m) => logs.push("warn " + m), error: (m) => logs.push("error " + m) };

  // Build the fixture WITH the tree under test rather than reusing a real artifact.
  // A session written by a newer harness can be refused outright by an older one --
  // the 0.2.0 tree rejects "working-directory/change" as an unknown non-ignorable
  // event type -- and that data incompatibility would mask the plugin behaviour this
  // test exists to check. Creating the log through the same tree keeps the vocabulary
  // native, so a failure here means the PLUGIN is incompatible, not the corpus.
  await rm(STAGE, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  // Cordis allows only ONE sessionPersistence service per context ("has been registered
  // at <root>"), so the fixture builder gets its own child context and is disposed
  // before the plugin's backend is constructed on the parent.
  const seedCtx = new Cordis.Context();
  seedCtx.logger = ctx.logger;
  const seed = new JsonlSessionPersistence(seedCtx, { root: ROOT, compression: "zstd" });
  // create() takes a full session header, not a project descriptor. The two trees
  // agree on the required shape here (id, createdAt as a non-negative safe integer,
  // isSeeded), which is why building it explicitly works on both.
  const id = "session-" + randomUUID();
  // The header needs the tree's OWN format version: encodeCurrentHeader validates it,
  // and hardcoding a number here would silently break on a tree that moved. Read it
  // from the tree under test so the fixture is always native to that tree.
  const sessionModule = await load("@deepseek-ai/dsh-session");
  const created = await seed.create({
    version: sessionModule.SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    isSeeded: false,
    cwd: process.cwd(),
  });
  console.log("   fixture session created by this tree: " + String(created.id ?? id).slice(0, 24));
  const sessionId = created.id ?? id;

  // A few turns so there is a real resident parse to extend. create() already returns
  // an OWNED write handle -- calling open() again throws SessionAlreadyOwnedError --
  // so the seed turns go through that handle and it is closed before the plugin's
  // backend opens the session for itself.
  {
    const handle = created;
    for (let turn = 1; turn <= 3; turn += 1) {
      let seq = turn * 4 - 4;
      const at = Date.now();
      const row = (type, data) => ({ type, seq: seq++, time: at, data });
      await handle.append([
        row("turn/start", { turn }),
        row("step/start", { turn, step: 1 }),
        row("step/end", { turn, step: 1 }),
        row("turn/end", { turn, reason: { kind: "completed" } }),
      ]);
    }
    await handle.close();
  }
  // Release the fixture context before the plugin's backend registers its own
  // sessionPersistence service on the parent context.
  await seedCtx.stop?.();

  const backend = new JsonlSessionPersistence(ctx, { root: ROOT, compression: "zstd" });
  const service = { [Symbol.for("cordis.original")]: backend };
  const disposer = plugin.applyToService(ctx, service, {});
  check(disposer !== undefined, "the plugin attaches to this tree's backend");
  const state = backend[Symbol.for("dsh.coldread-cache.ownership")];
  check(state !== undefined, "the plugin installed an ownership record");
  const installed = state?.status?.installed ?? [];
  check(installed.length === 5, "all five hooks installed, not a partial patch", installed.join(","));

  const cache = state.cache;
  const writer = await backend.open(sessionId, "write");
  let read = await writer.read();
  const before = { ...cache.stats };
  check(read.events.length > 0, "a real read returns events through the patched path");

  const turn = read.events.reduce((max, e) => (e.type === "turn/start" && Number.isFinite(e.data?.turn) ? Math.max(max, e.data.turn) : max), 0) + 1;
  let seq = read.events.length;
  const at = Date.now();
  const row = (type, data) => ({ type, seq: seq++, time: at, data });
  await writer.append([
    row("turn/start", { turn }),
    row("step/start", { turn, step: 1 }),
    row("step/end", { turn, step: 1 }),
    row("turn/end", { turn, reason: { kind: "completed" } }),
  ]);
  read = await writer.read();
  const after = { ...cache.stats };
  check(after.extensions > before.extensions, "the append was served by extending the resident parse", "ext " + before.extensions + " -> " + after.extensions);
  check(after.coldParses === before.coldParses, "no cold parse was needed for the extension", "cold " + before.coldParses + " -> " + after.coldParses);
  // The backend returns a fresh slice() per read, so the ARRAY is never frozen. What
  // the plugin guarantees is that every element is a shared, deep-frozen resident
  // object -- that is what stops one consumer mutating state another reader will see.
  // (Asserting the array itself was the first version of this check and it failed on
  // both trees, which is how the mistake was caught.)
  check(read.events.length > 0 && read.events.every((event) => Object.isFrozen(event)),
    "every returned event is a frozen shared object");
  check(!Object.isFrozen(read.events), "the returned array is a fresh slice, not the resident list");
  const entry = cache.get(sessionId);
  check(entry !== undefined && !Object.isFrozen(entry.reader), "the resident decoder stays unfrozen so it can grow");

  await writer.close();
  disposer();
  await rm(STAGE, { recursive: true, force: true });
}

console.log("");
console.log("COMPAT_" + (failures === 0 ? "GREEN" : "RED") + " checks=" + checks + " failures=" + failures);
process.exit(failures === 0 ? 0 : 1);
