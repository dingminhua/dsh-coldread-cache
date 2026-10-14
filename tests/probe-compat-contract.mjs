/**
 * The compatibility contract must refuse an incompatible backend, readably.
 *
 * The install path now requires three helper members (`assertStoredIdentity`,
 * `locate`, `memoizeStoredLog`) in addition to the five patch points, so a DSH whose
 * backend moved degrades to the pristine reader with a message instead of throwing from
 * inside a read. A check that has never been seen to fail is not a check, so this pins
 * BOTH directions: the real backend must install, and a backend with a helper removed
 * must be refused without a single patch point being written.
 *
 * The removal is done on the live instance (the plugin resolves the real object through
 * cordis' traceable proxy, so that is what has to be mutated), then undone -- and the
 * last two sections prove the refusal was caused by the removal, not by the second
 * attach being impossible.
 *
 * Run: node tests/probe-compat-contract.mjs
 */
import { makeBackend, makePatchedBackend } from "./gate/harness.mjs";
import { applyToService } from "../lib/index.js";

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log("  ok   " + label);
  else { failures += 1; console.log("  FAIL " + label + (detail === undefined ? "" : " :: " + detail)); }
}

const HOOKS = (await import("../lib/index.js")).HOOKS;
  const HOOK_COUNT = HOOKS.length;
const { ctx, backend } = makeBackend(".");

// 1. The real backend satisfies the contract.
{
  const { state, disposer } = makePatchedBackend(".", {}, backend);
  check(state?.installed?.length === HOOK_COUNT, "the real backend installs every hook", String(state?.installed?.length));
  check(Object.keys(state?.failures ?? {}).length === 0,
    "the real backend produces no contract failure", JSON.stringify(state?.failures));
  disposer();
}

// 2. A backend missing one helper must be REFUSED, and nothing may be patched.
{
  const before = HOOKS.map((k) => backend[k]);
  // These are PROTOTYPE methods, so `delete backend.memoizeStoredLog` is a no-op and
  // the helper still resolves up the chain -- the first version of this probe injected
  // nothing and the check unsurprisingly passed. Shadowing it with a non-function own
  // property is what an API that actually moved looks like.
  Object.defineProperty(backend, "memoizeStoredLog", { value: undefined, configurable: true, writable: true });
  try {
    const service = { [Symbol.for("cordis.original")]: backend };
    const disposer = applyToService(ctx, service, {});
    const state = backend[Symbol.for("dsh.coldread-cache.ownership")];
    check(state?.installed?.length === 0, "a backend missing a helper installs NOTHING", JSON.stringify(state?.installed));
    check(typeof state?.failures?.required === "string" && state.failures.required.includes("memoizeStoredLog"),
      "the refusal names the missing member", JSON.stringify(state?.failures));
    check(HOOKS.every((k, i) => backend[k] === before[i]), "no patch point was written on a refused backend");
    disposer?.();
  } finally {
    delete backend.memoizeStoredLog;
  }
}

// 3. Restoring the helper must make the same instance install again.
{
  const { state, disposer } = makePatchedBackend(".", {}, backend);
  check(state?.installed?.length === HOOK_COUNT, "the same instance installs again once the helper is back",
    JSON.stringify(state?.failures));
  disposer();
}

// 4. And it must be back to pristine.
{
  const leftover = HOOKS.filter((k) => Object.hasOwn(backend, k));
  check(leftover.length === 0, "the instance is pristine afterwards", leftover.join(","));
}

console.log("");
console.log("PROBE_CONTRACT_" + (failures === 0 ? "ok" : "FAIL"));
process.exit(failures === 0 ? 0 : 1);
