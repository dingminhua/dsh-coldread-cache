/**
 * Diagnostic: does the plugin's install mechanism (own-property override through
 * the cordis traceable service proxy) actually reach the internal backend
 * instance? Run: node tests/probe-install.mjs <PKG_DIR> <SESSION_ROOT>
 */
import { pathToFileURL } from "node:url";
import * as cordis from "@deepseek-ai/cordis";

// Defaults point at the real vendored backend and the real session root, so the
// probe runs standalone as well as with explicit arguments. Without them the
// "test" script fails on a missing argument, which says nothing about the plugin.
// Resolve the backend through Node's own resolver, so the probe works in any
// tree that has the package installed instead of naming one machine's path.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let VENDOR;
try {
  VENDOR = require.resolve("@deepseek-ai/dsh-session-persistence-jsonl");
} catch {
  VENDOR = process.env.DSH_VENDOR ?? "";
}
const pkg = process.argv[2] ?? VENDOR;
const root = process.argv[3] ?? (process.env.DSH_HOME ? process.env.DSH_HOME + "\\sessions" : "");
if (root === "") { console.log("PROBE_FAIL set DSH_HOME (or pass the session root)"); process.exit(2); }
const ctx = new cordis.Context();
ctx.logger = { info() {}, warn() {}, error() {}, debug() {} };
const P = (await import(pathToFileURL(pkg).href)).default;
const inst = new P(ctx, { root });

console.log("P.provide =", JSON.stringify(P.provide));
console.log("inst.name =", JSON.stringify(inst.name));
console.log("tracker on inst =", JSON.stringify(inst[Symbol.for("cordis.tracker")]));
console.log("reflect props =", JSON.stringify(Object.keys(ctx.reflect.props ?? {})));
for (const n of ["sessionPersistence", "session-persistence-jsonl", inst.name]) {
  let v;
  try { v = ctx.get(n); } catch (e) { v = "THROW:" + e.message; }
  console.log("ctx.get(" + JSON.stringify(n) + ") =", typeof v, v && v.constructor && v.constructor.name,
    "decodeStoredLog=" + typeof v?.decodeStoredLog, "persistBatch=" + typeof v?.persistBatch,
    "readZstdPrefix=" + typeof v?.readZstdPrefix, "present=" + typeof v?.present);
  if (v && typeof v === "object") {
    console.log("   === inst?", v === inst, "| typeof v.revision =", typeof v.revision, "| typeof v.list =", typeof v.list);
  }
}
const svc = ctx.get("sessionPersistence") ?? ctx.get(inst.name);
if (!svc) { console.log("NO SERVICE HANDLE"); process.exit(2); }
// The decisive assertion: does a write through the handle land on the instance?
const sentinel = function sentinel() { return "sentinel"; };
const before = inst.decodeStoredLog;
try {
  svc.decodeStoredLog = sentinel;
  console.log("own prop on inst after write?", Object.hasOwn(inst, "decodeStoredLog"), "inst.decodeStoredLog === sentinel?", inst.decodeStoredLog === sentinel);
  console.log("read back through handle?", svc.decodeStoredLog === sentinel);
} finally {
  delete inst.decodeStoredLog;
}
console.log("restored?", inst.decodeStoredLog === before, Object.hasOwn(inst, "decodeStoredLog"));
console.log("cordis symbols.tracker =", String(cordis.symbols.tracker), "original =", String(cordis.symbols.original));
console.log("svc[original] === inst?", svc[cordis.symbols.original] === inst, "type", typeof svc[cordis.symbols.original]);
