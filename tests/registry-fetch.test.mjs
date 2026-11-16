import assert from "node:assert/strict";
import { changes, kind, parseCtgov, parseCtis, parseNl } from "../ingestion/fetch_registries.mjs";

assert.equal(kind("NCT05350722"), "ctgov");
assert.equal(kind("NL-OMON52643"), "nl");
assert.equal(kind("2024-510578-25-00"), "ctis");
assert.equal(kind("foo"), null);

const ct = parseCtgov({ protocolSection: {
  identificationModule: { nctId: "NCT00000001", acronym: "DEMO", officialTitle: "A demo trial" },
  statusModule: { overallStatus: "RECRUITING", startDateStruct: { date: "2025-01" } },
  conditionsModule: { conditions: ["Breast cancer"] },
  eligibilityModule: { eligibilityCriteria: "Inclusion Criteria:\n\n* Age 18 or older\n\nExclusion Criteria:\n\n* Pregnancy" } } });
assert.deepEqual([ct.trial_id, ct.active, ct.inclusion, ct.exclusion, ct.condition], ["DEMO", true, "* Age 18 or older", "* Pregnancy", "Breast cancer"]);

const nl = parseNl(`<title>A demo study (DEMO-NL) | Research with human participants</title>
  <div class="field-group"><h3>Inclusion criteria</h3><div><p>• Age &gt;= 18<br>• WHO 0&ndash;1</p></div></div>
  <div class="field-group"><h3>Exclusion criteria</h3><div><p>• Prior radiotherapy</p></div></div><h3>Design</h3>`);
assert.equal(nl.trial_id, "DEMO-NL");
assert.equal(nl.inclusion, "• Age >= 18\n• WHO 0–1");
assert.equal(nl.exclusion, "• Prior radiotherapy");

const ctisJson = { ctNumber: "2024-000001-01-00", ctStatus: "Authorised", authorizedApplication: { authorizedPartI: { trialDetails: {
  clinicalTrialIdentifiers: { shortTitle: "DEMO-EU", publicTitle: "Demo EU trial" },
  trialInformation: { eligibilityCriteria: {
    principalInclusionCriteria: [{ number: 2, principalInclusionCriteria: "Second" },
      { number: 1, principalInclusionCriteria: "First", principalInclusionCriteriaTranslations: [{ attributeTranslation: "Eerste" }] }],
    principalExclusionCriteria: [{ number: 1, principalExclusionCriteria: "None" }] } } } } } };
assert.equal(parseCtis(ctisJson).inclusion, "1. First\n2. Second");
assert.equal(parseCtis(ctisJson, "nl").inclusion, "1. Eerste\n2. Second");          // translation where available
assert.equal(parseCtis(ctisJson).active, true);

assert.deepEqual(changes([{ source_id: "A", inclusion: "x" }], [{ source_id: "A", inclusion: "y" }, { source_id: "B" }]),
  ["A: inclusion changed", "B: new"]);

console.log("Registry fetch parsing checks passed.");
