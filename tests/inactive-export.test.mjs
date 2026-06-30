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
  context.sourceTrialEnabled({ __sourceFormat: "trialgpt", __raw: { metadata: { active: false } } }),
  false,
  "TrialGPT metadata.active=false should mark the source row inactive",
);
assert.equal(
  context.sourceTrialEnabled({ __sourceFormat: "spreadsheet", __raw: { status: "inactive" } }),
  false,
  "spreadsheet status=inactive should mark the source row inactive",
);
assert.equal(
  context.sourceTrialEnabled({ __sourceFormat: "orgjson", __raw: { enabled: false } }),
  false,
  "org JSON enabled=false should mark the source row inactive",
);

const raw = {
  __sourceFormat: "trialgpt",
  __raw: {
    _id: "ARCHIVED-001",
    metadata: { active: false },
  },
};

const trial = context.sanitizeTrial({
  trial_id: "ARCHIVED-001",
  enabled: true,
  metadata: {
    brief_title: "Archived trial with criteria",
    drugs: [],
    conditions: ["Condition A"],
    lifecycle_dates: {},
  },
  criteria: [
    {
      criterion_id: "INC-01",
      type: "inclusion",
      original_text_raw: "Age >= 18 years",
      original_text: "Participant must be 18 years of age or older.",
      assertion: "present",
      category: "intake_notes",
      priority_level: 1,
      status: "active",
      routing: { primary_docs: ["intake_notes"], fallback_docs: [] },
      evaluation_type: "boolean",
    },
  ],
});

const archived = context.applySourceFields(trial, raw);
assert.equal(archived.enabled, false, "source inactive flag should disable the trial");
assert.equal(archived.criteria.length, 1, "inactive trials should keep processed criteria");

const exported = context.toV1Envelope([archived]);
assert.equal(exported.trial_count, 1);
assert.equal(exported.trials[0].enabled, false, "exported inactive trial should be disabled");
assert.equal(exported.trials[0].criteria.length, 1, "exported inactive trial should include criteria");
assert.equal(exported.trials[0].criteria[0].enabled, true, "criterion status should remain independent of trial matching switch");

console.log("Inactive export checks passed.");
