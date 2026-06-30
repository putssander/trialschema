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

const pendingRaw = {
  trial_id: "PENDING-001",
  trial: "Pending raw study",
  active: "false",
  inclusion: "Age >= 18 years",
  exclusion: "Pregnancy",
};

const processed = context.sanitizeTrial({
  trial_id: "PROCESSED-001",
  enabled: false,
  metadata: {
    brief_title: "Processed inactive study",
    drugs: [],
    conditions: ["Condition A"],
    lifecycle_dates: {},
  },
  criteria: [
    {
      criterion_id: "INC-01",
      type: "inclusion",
      original_text: "Participant must be 18 years of age or older.",
      original_text_raw: "Age >= 18 years",
      assertion: "present",
      category: "intake_notes",
      priority_level: 1,
      status: "active",
      routing: { primary_docs: ["intake_notes"], fallback_docs: [] },
      evaluation_type: "boolean",
    },
  ],
});

const envelope = context.toV1Envelope([processed], {
  pending_trials: [
    {
      id: "PENDING-001",
      title: "Pending raw study",
      source_format: "spreadsheet",
      raw: pendingRaw,
      user_enabled: false,
      archived: true,
    },
  ],
  archived_trial_ids: ["PENDING-001", "PROCESSED-001"],
});

assert.equal(envelope.trial_count, 1);
assert.equal(envelope.trials.length, 1, "only processed trials should be agent-facing");
assert.equal(envelope.trials[0].enabled, false, "processed inactive trials stay structured but disabled");
assert.equal(envelope.trials[0].criteria.length, 1, "processed inactive trials keep criteria");

const workspace = envelope.extensions?.["org.trialschema.workspace"];
assert.ok(workspace, "workspace extension should be present");
assert.equal(workspace.pending_trials.length, 1, "pending raw trials should be preserved outside trials[]");
assert.equal(workspace.pending_trials[0].id, "PENDING-001");
assert.equal(workspace.pending_trials[0].user_enabled, false);
assert.equal(workspace.pending_trials[0].archived, true);
assert.equal(JSON.stringify(workspace.archived_trial_ids), JSON.stringify(["PENDING-001", "PROCESSED-001"]));

const imported = context.fromV1Envelope(envelope);
assert.equal(imported.trials.length, 1);
assert.equal(imported.workspace.pending_trials.length, 1);

const rawRows = imported.workspace.pending_trials.map(context.workspacePendingToRaw);
const items = context.classifyRows(rawRows);
assert.equal(items.length, 1);
assert.equal(items[0].result, null, "pending workspace rows should load unprocessed");
assert.equal(items[0].archived, true, "archive state should restore onto the UI item");
assert.equal(items[0].userEnabled, false, "source/user enabled hint should be preserved for later processing");
assert.equal(context.isTrialEnabled(items[0]), false, "unprocessed trials are never active for matching");

console.log("Workspace round-trip checks passed.");
