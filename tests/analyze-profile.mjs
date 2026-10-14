import { readFileSync, readdirSync } from "node:fs";
const dir = process.argv[2] ?? ".prof";
const file = readdirSync(dir).filter((f) => f.endsWith(".cpuprofile")).pop();
const profile = JSON.parse(readFileSync(dir + "/" + file, "utf8"));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
let total = 0;
const interval = 200; // microseconds per sample
for (const node of profile.nodes) {
  const hits = node.hitCount ?? 0;
  if (hits === 0) continue;
  const cf = node.callFrame;
  const key = (cf.functionName || "(anonymous)") + "  @ " + (cf.url || "").split(/[\\/]/).pop() + ":" + (cf.lineNumber + 1);
  self.set(key, (self.get(key) ?? 0) + hits);
  total += hits;
}
const rows = [...self].sort((a, b) => b[1] - a[1]).slice(0, 18);
console.log("total samples: " + total + "  (~" + ((total * interval) / 1000).toFixed(0) + " ms profiled)");
console.log("\ntop self-time:");
for (const [k, v] of rows) {
  const ms = (v * interval) / 1000;
  console.log("  " + ms.toFixed(1).padStart(8) + " ms  " + ((v / total) * 100).toFixed(1).padStart(5) + "%  " + k);
}