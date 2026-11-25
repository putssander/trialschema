// Other tools' extensions, registry identifiers, criterion provenance and concept codes survive import -> export.
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const context = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } },
  window: {}, Blob: class {}, File: class {},
  fetch() { throw new Error("fetch is disabled in tests"); },
};
vm.createContext(context);
vm.runInContext(readFileSync(join(root, "app.js"), "utf8"), context);

const source = {
  format: "trialschema", format_version: "1.1", generated_at: "2026-11-16T00:00:00Z",
  generator: { name: "other-tool", version: "1" },
  trial_count: 1,
  extensions: { "org.example.curation": { log: [{ reason: "added PSMA window" }] } },
  trials: [{
    id: "EX-1", kind: "trial", enabled: true, title: "Example",
    identifiers: [{ system: "https://clinicaltrials.gov", value: "NCT04642027" }],
    extensions: { "org.example.source": { url: "https://clinicaltrials.gov/study/NCT04642027" } },
    criteria: [{
      id: "INC-01", kind: "inclusion", enabled: true, rank: 1,
      source_text: "Creatinine clearance >= 50 ml/min", clarified_text: null,
      concept: { domain: "observation", code: { system: "http://loinc.org", code: "2164-2" }, text: "Creatinine clearance" },
      assertion: "present",
      constraint: { kind: "comparison", operator: ">=", quantity: { value: 50, unit: "mL/min" } },
      routing: { primary: ["lab_results"], fallback: [] },
      provenance: { extracted_at: "2026-11-09T10:00:00Z", extracted_by: "curation-tool" },
      extensions: { "org.example.eval": { method: "structured" } },
    }, ...[2, 3, 4, 5, 6].map((n) => ({
      id: `INC-0${n}`, kind: "inclusion", enabled: true, rank: n, source_text: `Rule ${n}`, clarified_text: null,
      concept: { domain: "condition" }, assertion: "present", constraint: { kind: "text", description: `Rule ${n}` },
      routing: { primary: ["intake-notes"], fallback: [] },
    })), {
      id: "EXC-01", kind: "exclusion", enabled: true, rank: 7,
      source_text: "Prior breast cancer", clarified_text: "Prior breast carcinoma or DCIS (a separate, earlier episode).",
      concept: { domain: "condition", text: "Prior breast cancer" }, assertion: "present",
      constraint: { kind: "text", description: "Prior breast carcinoma or DCIS." },
      routing: { primary: ["referral-letters"], fallback: ["treatment-history"] },
      guidance: "A recurrence of the current cancer does not count.",
    }, {
      id: "EXC-02", kind: "exclusion", enabled: true, rank: 8, source_text: "Pregnancy", clarified_text: null,
      concept: { domain: "condition" }, assertion: "present", constraint: { kind: "text", description: "Pregnancy" },
      routing: { primary: [], fallback: [] }, guidance: "Only current pregnancy.",
    }],
  }],
};

const env = context.fromV1Envelope(JSON.parse(JSON.stringify(source)));
const plain = (x) => JSON.parse(JSON.stringify(x));
const out = plain(context.toV1Envelope(env.trials, env.workspace));
const t = out.trials[0], c = t.criteria[0];

assert.deepEqual(out.extensions["org.example.curation"], source.extensions["org.example.curation"], "envelope extension kept");
assert.deepEqual(t.extensions["org.example.source"], source.trials[0].extensions["org.example.source"], "trial extension kept");
assert.deepEqual(t.identifiers, source.trials[0].identifiers, "identifiers kept");
assert.deepEqual(c.extensions["org.example.eval"], { method: "structured" }, "criterion extension kept");
assert.equal(c.provenance.extracted_by, "curation-tool", "imported provenance kept");
assert.deepEqual(c.concept.code, { system: "http://loinc.org", code: "2164-2" }, "coded concept kept with its system");

const exc1 = t.criteria.find((x) => x.id === "EXC-01");
assert.equal(exc1.rank, 7, "ranks above 5 keep their order");
assert.deepEqual(exc1.routing, { primary: ["referral-letters"], fallback: ["treatment-history"] }, "guidance does not add the Other route");
assert.deepEqual(exc1.constraint, source.trials[0].criteria[6].constraint, "unedited text constraint kept");
assert.deepEqual(exc1.concept, source.trials[0].criteria[6].concept, "concept domain and text kept");
assert.deepEqual(t.criteria.find((x) => x.id === "EXC-02").routing, { primary: [], fallback: [] }, "empty routing stays empty");

// Concept codes in the forms models write; unknown systems become text so the Coding stays schema-valid.
assert.deepEqual(plain(context.tsv1ParseCode("loinc.org:2160-0")), { system: "http://loinc.org", code: "2160-0" });
assert.deepEqual(plain(context.tsv1ParseCode("LOINC:2160-0")), { system: "http://loinc.org", code: "2160-0" });
assert.deepEqual(plain(context.tsv1ParseCode("http://snomed.info/sct|254837009")), { system: "http://snomed.info/sct", code: "254837009" });
assert.deepEqual(plain(context.tsv1ParseCode("2160-0")), { text: "2160-0" });

// Registry rows become identifiers plus a source extension.
const trial = context.sanitizeTrial({ trial_id: "PERYTON", criteria: [] });
context.applyRegistrySource(trial, {
  source: "nl", source_id: "NL-OMON52643", source_url: "https://onderzoekmetmensen.nl/en/trial/52643",
  registry_ids: ["NCT04642027"], own_site: true, retrieved_by: "registry",
});
assert.deepEqual(plain(trial.identifiers.map(i => i.value)), ["NL-OMON52643", "NCT04642027"]);
assert.equal(trial.foreign_extensions["org.trialschema.source"].own_site, true);
assert.equal(context.tsv1Trial(trial).extensions["org.trialschema.source"].source_id, "NL-OMON52643");

console.log("Extension round-trip checks passed.");
