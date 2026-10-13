/**
 * Resolve every @deepseek-ai import onto a chosen DSH tree.
 *
 * tests/compat.mjs loads the tree under test explicitly, but the plugin's own static
 * imports resolve relative to lib/index.js, i.e. through this repository's
 * node_modules junction. That makes the test a MIX: a chosen tree's backend driven by
 * another tree's validation modules. The gap is invisible when both trees are
 * identical, which is exactly when it would be least likely to be noticed.
 *
 * This hook rewrites each @deepseek-ai/<pkg> specifier to the same package inside
 * COMPAT_TREE, so a run under it exercises one tree end to end. Package entry points
 * are read from the package's own manifest rather than assumed, because layouts differ
 * (schemastery's ESM entry is lib/index.mjs, not lib/index.js).
 *
 * Loaded with: node --import ./tests/compat-loader.mjs ...
 */
import { registerHooks } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TREE = process.env.COMPAT_TREE;
if (TREE) {
  /** The ESM entry point of one package inside the chosen tree. */
  function entryOf(pkg) {
    const dir = join(TREE, pkg);
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(manifest, "utf8"));
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined) {
        // Prefer an ESM entry: the plugin is an ES module and imports these as ESM.
        const candidates = [];
        const dot = parsed.exports?.["."];
        if (typeof dot === "string") candidates.push(dot);
        else if (dot !== undefined) {
          for (const key of ["import", "module", "default", "require"]) {
            if (typeof dot[key] === "string") candidates.push(dot[key]);
          }
        }
        if (typeof parsed.module === "string") candidates.push(parsed.module);
        if (typeof parsed.main === "string") candidates.push(parsed.main);
        for (const candidate of candidates) {
          const full = join(dir, candidate);
          if (existsSync(full)) return full;
        }
      }
    }
    // Fall back to the layouts these packages actually ship.
    for (const candidate of ["lib/index.mjs", "lib/index.js", "lib/index.cjs"]) {
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
    }
    return undefined;
  }

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@deepseek-ai" || specifier.startsWith("@deepseek-ai/")) {
        const pkg = specifier.slice("@deepseek-ai".length).replace(/^\//, "");
        if (pkg.length > 0) {
          const entry = entryOf(pkg);
          if (entry !== undefined) return { url: pathToFileURL(entry).href, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
  });
}
