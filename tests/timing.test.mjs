import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const context = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage: { getItem() { return null; }, setItem() {} },
  document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } },
  window: {}, Blob: class {}, File: class {},
  fetch() { throw new Error("Network disabled in timing tests"); },
};
vm.createContext(context);
vm.runInContext(readFileSync(new URL("../app.js", import.meta.url), "utf8"), context);
const plain = value => JSON.parse(JSON.stringify(value));
const windowTiming = { scope: "window", lookback: { value: 5, unit: "years", code: "a" }, description: "in de afgelopen 5 jaar" };
const criterion = (id, extra = {}) => context.sanitizeCriterion({ criterion_id: id, original_text: "Prior chemotherapy", original_text_raw: "Eerdere chemotherapie", category: "treatment_history", ...extra }, 0);

for (const timing of [undefined, { scope: "current" }, { scope: "ever", description: "in de voorgeschiedenis" }, windowTiming]) {
  assert.deepEqual(plain({ timing: context.validateTiming(timing) }), plain({ timing }));
}
for (const timing of [null, {}, [], { scope: "past" }, { scope: "ever", lookback: {} }, { scope: "current", lookback: null }, { scope: "window" },
  { scope: "ever", anchor: "screening" }, { scope: "ever", description: 5 },
  ...[0, -1, "5", Infinity, NaN].map(value => ({ ...windowTiming, lookback: { ...windowTiming.lookback, value } })),
  { ...windowTiming, lookback: { value: 5, unit: "years", code: "d" } },
  { ...windowTiming, lookback: { value: 5 } },
  { ...windowTiming, lookback: { ...windowTiming.lookback, system: "unknown" } },
]) assert.throws(() => context.validateTiming(timing), /Invalid timing/);

const trial = context.sanitizeTrial({ trial_id: "TIMING-001", criteria: [
  criterion("INC-01", { timing: windowTiming, evaluation_type: "quantitative", structured_target: { metric: "Creatinine clearance", operator: ">=", value: 50, unit: "mL/min" } }),
  criterion("INC-02", { timing: { scope: "ever" }, assertion: "absent" }),
  criterion("INC-03", { timing: { scope: "current" } }),
  criterion("INC-04", { assertion: "unknown" }),
] });
const envelope = context.toV1Envelope([trial]);
assert.equal(envelope.format_version, "1.1");
assert.equal(envelope.trials[0].criteria[0].constraint.quantity.value, 50, "timing must not replace the clinical threshold");
assert.equal(envelope.trials[0].criteria[1].assertion, "absent");
assert.equal(envelope.trials[0].criteria[3].assertion, "unknown");
assert.ok(!("timing" in envelope.trials[0].criteria[3]));
const imported = context.fromV1Envelope(plain(envelope)).trials[0];
assert.deepEqual(plain(imported.criteria.map(c => c.timing)), plain(trial.criteria.map(c => c.timing)));
const legacy = plain(envelope);
legacy.format_version = "1.0";
legacy.trials[0].criteria.forEach(c => delete c.timing);
assert.ok(context.fromV1Envelope(legacy).trials[0].criteria.every(c => c.timing === undefined));

const existing = criterion("EXISTING", { timing: { scope: "current" } });
const cleared = criterion("CLEARED");
const edited = criterion("EDITED");
const missing = criterion("MISSING");
const removed = criterion("REMOVED");
const work = { trial_id: "WORK", criteria: [existing, cleared, edited, missing, removed] };
let snapshot = context.timingSuggestionSnapshot(work);
assert.ok(!snapshot.some(s => s.id === "EXISTING"));
context.setCriterionTiming(work, cleared, undefined);
edited.original_text = "A manual rewrite";
work.criteria = work.criteria.filter(c => c !== removed);
const response = { criteria: snapshot.map(s => ({ criterion_id: s.id, timing: windowTiming })) };
assert.equal(context.applyTimingSuggestions(work, snapshot, response), 1, "only the untouched missing criterion should get timing");
assert.deepEqual(plain(existing.timing), { scope: "current" });
assert.equal(cleared.timing, undefined);
assert.equal(edited.timing, undefined);
assert.deepEqual(plain(missing.timing), windowTiming);
assert.equal(context.applyTimingSuggestions(work, snapshot, response), 0, "repeated suggestions must not overwrite values");
const restored = context.fromV1Envelope(plain(context.toV1Envelope([context.sanitizeTrial(work)]))).trials[0];
assert.equal(restored.criteria.find(c => c.criterion_id === "CLEARED").timing_reviewed, true);
assert.ok(!context.timingSuggestionSnapshot(restored).some(s => s.id === "CLEARED"));
context.setCriterionTiming(work, existing, { scope: "ever" });
assert.deepEqual(plain(existing.timing), { scope: "ever" });
assert.throws(() => context.setCriterionTiming(work, existing, { scope: "window" }), /Invalid timing/);
assert.deepEqual(plain(existing.timing), { scope: "ever" }, "invalid manual changes must be atomic");

const clean = { criteria: [criterion("A"), criterion("B")] };
snapshot = context.timingSuggestionSnapshot(clean);
assert.throws(() => context.applyTimingSuggestions(clean, snapshot, { criteria: [{ criterion_id: "A", timing: windowTiming }, { criterion_id: "B", timing: { scope: "window" } }] }), /Invalid timing/);
assert.equal(clean.criteria[0].timing, undefined, "invalid batch must be atomic");
for (const suggestions of [[{ criterion_id: "UNKNOWN", timing: windowTiming }], [{ criterion_id: "A", timing: windowTiming }, { criterion_id: "A", timing: windowTiming }]]) {
  assert.throws(() => context.applyTimingSuggestions(clean, snapshot, { criteria: suggestions }));
}
const prompt = context.buildTimingSuggestionPrompt(snapshot);
for (const cue of ["in de voorgeschiedenis", "in de afgelopen 5 jaar", "niet ouder dan 60 dagen", "momenteel", "minimum washouts", "Missing timing means unspecified", "not merely a document date"]) {
  assert.ok(prompt.system.includes(cue), `Suggestion prompt should explain ${cue}`);
  assert.ok(context.buildSystemPrompt().includes(cue), `Extraction prompt should explain ${cue}`);
}
assert.ok(context.buildCriterionClarifyPrompt(trial, trial.criteria[0], "").user.includes(JSON.stringify(windowTiming)));

if (process.argv.includes("--fixture")) console.log(JSON.stringify(envelope));
else console.log("Timing validation, round-trip, prompt, and suggestion checks passed.");
