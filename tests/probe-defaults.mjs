import { Config, DEFAULTS, name } from "../lib/index.js";

// The schema default and the install-path fallback must agree, because a caller
// that passes no config gets the fallback while the schema documents the default.
// They drifted once (128 MB documented, 32 MB used) and this is the check that
// would have caught it.
const parsed = Config({});
const keys = ["enabled", "maxEntries", "maxResidentBytes", "statusFile"];
let ok = true;
for (const key of keys) {
  const same = parsed[key] === DEFAULTS[key];
  console.log((same ? "ok   " : "FAIL ") + key + ": schema=" + parsed[key] + " defaults=" + DEFAULTS[key]);
  if (!same) ok = false;
}
console.log("name: " + name);
console.log("defaults are frozen: " + Object.isFrozen(DEFAULTS));
if (!Object.isFrozen(DEFAULTS)) ok = false;
console.log(ok ? "DEFAULTS_AGREE ok" : "DEFAULTS_AGREE FAIL");
process.exit(ok ? 0 : 1);