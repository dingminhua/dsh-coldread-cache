/**
 * Was the one-off torn-tail failure real, or a key-order artifact of the comparison itself?
 *
 * Section 3 compared the two sides with JSON.stringify on each event. That string is sensitive to
 * the ORDER of an object's keys, and key order is not part of a session event's meaning: the
 * backend's own equality predicate is isDeepStrictEqual, which ignores it. So a stringify-based
 * comparison can report a difference where the backend sees none -- a check that fails for a
 * reason unrelated to what it claims to test.
 *
 * That is consistent with every observation: the failure reported "differ at 1 positions" with
 * matching lengths, status, meta and truncation point; 24 controlled reproductions of the same
 * scenario found the answers identical, repeatable, and with no file mutation between the reads.
 *
 * This proves the mechanism rather than asserting it: it builds two semantically identical event
 * lists that differ only in key order and shows the old comparison red and the deep one green.
 *
 * Run: node tests/probe-key-order.mjs
 */
import { isDeepStrictEqual } from "node:util";
import { compareLogs } from "./gate/harness.mjs";

let failures = 0;
const check = (ok, label, detail) => {
  if (ok) console.log("  ok   " + label);
  else { failures += 1; console.log("  FAIL " + label + (detail === undefined ? "" : " :: " + detail)); }
};

// The same event, written two ways. Every value is identical; only the insertion order of the
// keys differs. A session log's meaning does not depend on this.
const a = { type: "turn/start", turn: 1, step: undefined, at: 1 };
const b = { at: 1, turn: 1, type: "turn/start", step: undefined };

check(!isDeepStrictEqual(a, b) === false, "the backend's own predicate calls these equal",
  "isDeepStrictEqual=" + isDeepStrictEqual(a, b));
check(JSON.stringify(a) !== JSON.stringify(b), "JSON.stringify calls these DIFFERENT",
  JSON.stringify(a) + "  vs  " + JSON.stringify(b));

const log = (events) => ({
  status: "current",
  eventState: "shared-frozen",
  inheritedEventCount: 0,
  tornTruncateTo: 97,
  meta: { id: "s", version: 4, createdAt: 1, isSeeded: false },
  events,
  recoveredTail: [],
});

// The second element must ALSO keep every key, or the difference stops being about order.
// The first version of this dropped keys in a .map() and the deep comparison correctly rejected
// it as a content difference -- which would have made the probe prove the opposite of its claim.
const left = log([a, { type: "turn/end", turn: 1 }]);
const right = log([b, { turn: 1, type: "turn/end" }]);

check(compareLogs(left, right, { revision: false }).length === 0,
  "the deep comparison (what the gate now uses) accepts a key-order difference",
  compareLogs(left, right, { revision: false }).join("; "));

const setDiffs = compareLogs(left, right, { revision: false, order: "set" });
check(setDiffs.length > 0,
  "the old stringify-based set comparison REJECTS the same key-order difference",
  setDiffs.join("; "));

// The positive control the other way: a genuine content difference must still fail BOTH
// comparisons. Without this, "the deep check passes" could just mean it passes everything.
const wrong = log([{ type: "turn/start", turn: 2 }, { type: "turn/end", turn: 1 }]);
check(compareLogs(left, wrong, { revision: false }).length > 0,
  "the deep comparison still catches a real content difference",
  compareLogs(left, wrong, { revision: false }).join("; "));
check(compareLogs(left, wrong, { revision: false, order: "set" }).length > 0,
  "the set comparison still catches a real content difference",
  compareLogs(left, wrong, { revision: false, order: "set" }).join("; "));

console.log("");
console.log("PROBE_KEYORDER_" + (failures === 0 ? "ok" : "FAIL"));
process.exit(failures === 0 ? 0 : 1);
