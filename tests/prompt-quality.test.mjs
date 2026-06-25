import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const app = readFileSync(join(root, "app.js"), "utf8");
const schema = readFileSync(join(root, "docs/schemas/trialschema.v1.schema.json"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const compactApp = app.replace(/\s+/g, " ");
const compactSchema = schema.replace(/\s+/g, " ");
const compactReadme = readme.replace(/\s+/g, " ");

function includesText(haystack, needle) {
  return haystack.replace(/\s+/g, " ").includes(needle.replace(/\s+/g, " "));
}

// Samples transcribed from active rows in
// ingestion/ignore/trials_merged_template_columns.xlsx. These are the prompt
// cases most likely to affect downstream matching quality.
const activeTrialSamples = [
  {
    source: "Leeftijd >18 jaar",
    mustContain: [
      "strictly greater than 18 years",
      "exactly 18 years old does not satisfy",
      `operator ">"`,
      `unit:"years"`,
    ],
  },
  {
    source: "Leeftijd groter of gelijk aan 18 jaar",
    mustContain: [
      "18 years of age or older",
      `operator ">="`,
      "18 years old DOES satisfy",
    ],
  },
  {
    source: "Karnofsky Performance Score 70 of hoger",
    mustContain: [
      `metric "Karnofsky Performance Score"`,
      `operator ">="`,
      "value 70",
    ],
  },
  {
    source: "WHO performance status kleiner of gelijk aan 2",
    mustContain: [
      `metric "WHO performance status"`,
      `operator "<="`,
      "value 2",
    ],
  },
  {
    source: "PSA bij inclusie kleiner dan 1,0 mg/L",
    mustContain: [
      "PSA at",
      "strictly less than 1.0 mg/L",
      `operator "<"`,
      `unit "mg/L"`,
    ],
  },
  {
    source: "Leeftijd tussen 18 en 80 jaar",
    mustContain: [
      `operator "between"`,
      "upper_value 80",
      "do not state inclusive/exclusive",
    ],
  },
  {
    source: "PSMA scan beschikbaar en niet ouder dan 60 dagen",
    mustContain: [
      "PSMA scan performed no more than 60 days",
      `operator "<="`,
      `unit "days"`,
    ],
  },
  {
    source: "Geen metastasen of positieve klieren op PSMA scan",
    mustContain: [
      `assertion "absent"`,
      "metastases/positive nodes",
      "negated inclusion criterion",
    ],
  },
  {
    source: "Zwangerschap",
    mustContain: [
      `assertion "present" for pregnancy`,
      "listed under exclusion",
    ],
  },
];

for (const sample of activeTrialSamples) {
  assert.ok(includesText(app, sample.source), `prompt should include active-trial sample: ${sample.source}`);
  for (const text of sample.mustContain) {
    assert.ok(includesText(app, text), `sample ${sample.source} should require prompt text: ${text}`);
  }
}

assert.ok(
  compactApp.includes("original_text_raw: the verbatim source bullet/line"),
  "extractor prompt should distinguish verbatim source text from agent-ready text",
);
assert.ok(
  compactApp.includes('"original_text_raw": "string (verbatim source criterion line/bullet when available)"'),
  "extractor output shape should allow original_text_raw",
);
assert.ok(
  compactApp.includes('"assertion": "present"'),
  "extractor output shape should include schema assertion",
);
assert.match(
  app,
  /original_text_raw:\s*typeof c\.original_text_raw === "string" \? c\.original_text_raw : ""/,
  "sanitizer should preserve original_text_raw for TrialSchema export",
);
assert.match(
  app,
  /assertion:\s*\["present", "absent", "unknown"\]\.includes\(c\.assertion\) \? c\.assertion : "present"/,
  "sanitizer and exporter should preserve schema assertion polarity",
);
assert.ok(
  compactApp.includes("Structured target to preserve"),
  "clarification prompt should include the structured target",
);
assert.ok(
  compactApp.includes("Preserve quantitative operator strictness exactly"),
  "clarification prompt should preserve threshold strictness",
);
assert.ok(
  compactApp.includes("https://graph.microsoft.com/beta/copilot/conversations"),
  "app should support Microsoft 365 Copilot Chat API token mode",
);
assert.ok(
  compactApp.includes("contextualResources: { webContext: { isWebEnabled: false } }"),
  "Copilot token mode should disable web grounding for TrialSchema prompts",
);
assert.ok(
  compactApp.includes("function buildCriterionClarifyPrompt"),
  "clarification prompt should be reusable by API and manual copy flows",
);
assert.ok(
  compactApp.includes("data-clarify-copy"),
  "criterion rewrite panel should expose a manual prompt copy action",
);
assert.ok(
  compactApp.includes("normalizeCriterionRewriteText"),
  "manual criterion rewrite should accept pasted JSON responses",
);
assert.ok(
  app.includes("bindCopilotTokenHelpModal"),
  "app should expose Copilot token guidance for testing users",
);
assert.ok(
  compactReadme.includes("Microsoft 365 Copilot Token Testing"),
  "README should explain how to test Copilot token mode",
);

assert.ok(compactSchema.includes('"source_text"'), "schema should expose source_text");
assert.ok(compactSchema.includes('"clarified_text"'), "schema should expose clarified_text");
assert.ok(
  compactSchema.includes("Consumers SHOULD prefer `clarified_text ?? source_text`"),
  "schema should tell consumers to prefer clarified_text when present",
);
assert.ok(
  compactSchema.includes("Verbatim original criterion text in the source language"),
  "schema should preserve raw source-language criterion text",
);
assert.ok(
  compactSchema.includes("typically in English"),
  "schema should describe clarified_text as the agent-facing English rewrite",
);
assert.ok(
  compactSchema.includes("retaining source_text for audit, debugging, and reprocessing"),
  "schema should keep raw source text valuable for audit and recovery",
);
assert.ok(
  compactSchema.includes("what to check") && compactSchema.includes("where to look") && compactSchema.includes("how to evaluate"),
  "schema should communicate the core agent matching contract",
);
assert.ok(
  compactSchema.includes("A normalized care path in the export-level enum"),
  "schema should describe care paths as care paths, not only generic buckets",
);
assert.ok(
  compactReadme.includes("What to check") && compactReadme.includes("Where to look") && compactReadme.includes("How to evaluate"),
  "README should explain the schema goals for matching agents",
);

console.log("Prompt quality checks passed.");
