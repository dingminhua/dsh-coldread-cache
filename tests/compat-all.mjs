/**
 * Run the compatibility suite against every installed DSH tree on this machine.
 *
 * The plugin patches a released backend and imports seven released packages, so
 * "compatible" has to mean "works against a tree I did not develop on". Rather than
 * hardcode one path, this discovers every @deepseek-ai tree that contains the jsonl
 * backend and runs tests/compat.mjs against each. A new DSH install is covered
 * automatically; a tree whose shape moved fails loudly instead of in a user's host.
 *
 * Trees are found from DSH_TREES (semicolon-separated) or, by default, by scanning
 * the standard DSH dependency roots for a dsh-session-persistence-jsonl package.
 *
 * Run: node tests/compat-all.mjs
 */
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

/** Every @deepseek-ai directory that holds the jsonl backend, deduplicated. */
async function findTrees() {
  if (process.env.DSH_TREES) return process.env.DSH_TREES.split(";").filter(Boolean);

  const roots = [
    process.env.APPDATA ? join(process.env.APPDATA, "dsh-tauri", "dependencies") : undefined,
    process.env.APPDATA ? join(process.env.APPDATA, "dsh-tauri-nightly", "dependencies") : undefined,
    process.env.APPDATA ? join(process.env.APPDATA, "dsh-desktop", "harness", "profiles") : undefined,
  ].filter((p) => p !== undefined && existsSync(p));

  const found = new Set();
  for (const root of roots) {
    // A dependency root holds one tree per install; a tree may be nested one level
    // deeper (dsh-<version>-<build>/node_modules), so walk two levels.
    const level1 = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of level1) {
      if (!entry.isDirectory()) continue;
      const candidates = [
        join(root, entry.name, "node_modules", "@deepseek-ai"),
        join(root, entry.name, "node_modules"),
      ];
      for (const candidate of candidates) {
        const backend = join(candidate, "dsh-session-persistence-jsonl", "lib", "index.js");
        if (existsSync(backend)) found.add(candidate);
      }
    }
  }
  return [...found].sort();
}

const trees = await findTrees();
if (trees.length === 0) {
  console.log("no DSH trees found; set DSH_TREES to a semicolon-separated list of @deepseek-ai paths");
  process.exit(2);
}

console.log("found " + trees.length + " installed tree(s)\n");
let failed = 0;
const results = [];
for (const tree of trees) {
  // A distinct stage root per tree, so two runs can never share fixtures.
  const stage = join(repo, ".stage-compat-" + String(results.length));
  const run = spawnSync(
    process.execPath,
    // --import loads the remapping hook, and COMPAT_TREE tells it which tree to map
    // onto. Without both, the plugin's own @deepseek-ai imports resolve through this
    // repository's node_modules junction and the run tests a MIX of two trees.
    [
      // --import takes a module specifier, and on Windows a bare drive path is not a
      // valid ESM URL ("Received protocol 'd:'"). It must be a file:// URL.
      "--import",
      pathToFileURL(join(here, "compat-loader.mjs")).href,
      "--expose-gc",
      "--max-old-space-size=12288",
      join(here, "compat.mjs"),
      tree,
      stage,
    ],
    { cwd: repo, encoding: "utf8", env: { ...process.env, COMPAT_TREE: tree } },
  );
  const output = (run.stdout ?? "") + (run.stderr ?? "");
  const verdict = /COMPAT_(GREEN|RED)[^\n]*/.exec(output);
  results.push({ tree, code: run.status, verdict: verdict?.[0] ?? "(no verdict)" });
  if (run.status !== 0) {
    failed += 1;
    // Print the whole log for a failure: the reason matters more than the summary.
    console.log(output.trim());
    console.log("");
  }
}

console.log("trees tested:");
for (const r of results) {
  console.log("  exit=" + String(r.code).padEnd(3) + r.verdict.padEnd(58) + r.tree);
}
console.log("");
console.log("COMPAT_ALL_" + (failed === 0 ? "GREEN" : "RED") + " trees=" + trees.length + " failed=" + failed);
process.exit(failed === 0 ? 0 : 1);
