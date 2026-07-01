import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = readFileSync(join(root, "app.js"), "utf8");

const context = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  localStorage: { getItem() { return null; }, setItem() {} },
  document: {
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  },
  window: {},
  Blob: class {},
  File: class {},
  fetch() { throw new Error("fetch is disabled while loading app.js"); },
};

vm.createContext(context);
vm.runInContext(src, context);

assert.equal(
  context.carePathAliasKey("Hoofd/Hals"),
  context.carePathAliasKey("hoofd hals"),
  "care-path alias matching should ignore punctuation variants",
);

assert.ok(
  JSON.parse(vm.runInContext(`state.carePaths = []; JSON.stringify(tsv1CarePathCatalog())`, context))
    .some(cp => cp.id === "cross_care_path"),
  "the cross-care-path option should always be available in exports",
);

assert.equal(
  JSON.parse(vm.runInContext(`
state.carePaths = [];
mergeDetectedCarePaths([
  { id: "cross_domain", label: "Cross Domain", aliases: ["Zorglijn overstijgend"] }
], { sourceHints: ["Zorglijn overstijgend"], pruneStale: true });
JSON.stringify(state.carePaths);
`, context))[0].id,
  "cross_care_path",
  "LLM variants for cross-domain studies should canonicalize to cross_care_path",
);

const merged = JSON.parse(vm.runInContext(`
state.carePaths = [
  { id: "old_unused", label: "Old Unused", aliases: ["Old unused"], _normalized: true },
  { id: "mamma", label: "Mamma", aliases: ["Mamma"], _normalized: true },
  { id: "head_neck_old", label: "Hoofd Hals", aliases: ["Hoofd/Hals"], _normalized: true }
];
state.results = [];
state.resultsById = {};
state.existingExport = null;
mergeDetectedCarePaths([
  { id: "breast_cancer", label: "Breast Cancer", aliases: ["Mamma"] },
  { id: "head_and_neck", label: "Head and Neck", aliases: ["Hoofd Hals"] },
  { id: "head_neck", label: "Head/Neck", aliases: ["Hoofd/Hals"] },
  { id: "cross_care_path", label: "Cross-Care Path", aliases: ["Zorglijn overstijgend"] }
], { sourceHints: ["Mamma", "Hoofd/Hals", "Zorglijn overstijgend"], pruneStale: true });
JSON.stringify(state.carePaths);
`, context));

assert.deepEqual(
  merged.map(cp => cp.id).sort(),
  ["breast_cancer", "cross_care_path", "head_and_neck"],
  "LLM-detected care paths should merge duplicates and prune stale unused entries",
);
assert.ok(
  merged.find(cp => cp.id === "breast_cancer").aliases.some(a => context.carePathAliasKey(a) === "mamma"),
  "old source-language ids should survive as aliases after an English rename",
);
assert.ok(
  merged.find(cp => cp.id === "head_and_neck").aliases.includes("head_neck_old"),
  "old ids should remain resolvable after source-driven auto-merge",
);
assert.deepEqual(
  JSON.parse(vm.runInContext(`JSON.stringify(normalizeCarePathIds(["mamma", "head_neck_old"]))`, context)),
  ["breast_cancer", "head_and_neck"],
  "old ids should normalize to the merged English care-path ids",
);
assert.equal(
  merged.find(cp => cp.id === "cross_care_path").label,
  "Cross-Care Path",
  "cross-care-path source buckets should remain one broad normalized bucket",
);

console.log("Care-path normalization checks passed.");
