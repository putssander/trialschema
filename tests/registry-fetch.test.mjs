import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { changes, kind, ownSite, papersQuery, parseCtgov, parseCtis, parseNl, parsePapers, pickPrevious, withOwnSite } from "../ingestion/fetch_registries.mjs";

const here = dirname(fileURLToPath(import.meta.url));

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
assert.deepEqual(changes([{ source_id: "A", own_site: null }], [{ source_id: "A", own_site: true }]),
  ["A: own_site unknown -> true"]);

// Own site: configured names, case-insensitive; no names or no sites listed = unknown.
assert.equal(ownSite(["MAASTRO clinic, Maastricht"], ["Maastro"]), true);
assert.equal(ownSite(["Maastricht UMC+, Maastricht"], ["Maastro"]), false, "a different centre in the same city");
assert.equal(ownSite(["Maastricht UMC+, Maastricht"], ["Maastro", "Maastricht UMC+"]), true);
assert.equal(ownSite(["Maastro"], []), null);
assert.equal(ownSite([], ["Maastro"]), null);

// Real Dutch register pages (trimmed fixtures): English page with a site list, Dutch page with Dutch headings.
const fixture = (name) => readFileSync(join(here, "fixtures", name), "utf8");
const en = parseNl(fixture("nl-omon54083.en.html"));
assert.match(en.inclusion, /^Female, 40 years or older/);
assert.match(en.exclusion, /^Indication for chemotherapy/);
assert.equal(en.status, "Recruitment started");
assert.equal(en.active, true);
assert.equal(en.sites_nl.length, 12);
assert.ok(en.sites_nl.includes("Maastro"));
assert.equal(withOwnSite(en, ["Maastro"]).own_site, true);
assert.equal("sites_all" in withOwnSite(en, ["Maastro"]), false, "full site list is not written to the row");
const nlPage = parseNl(fixture("nl-omon52643.nl.html"));
assert.equal(nlPage.trial_id, "RISinG");                                         // title ends in "(RISinG)."
assert.match(nlPage.inclusion, /^• Supratentorieel recidief hooggradig glioom/);
assert.match(nlPage.exclusion, /^• Eerdere herbestraling/);
assert.equal(nlPage.status, "Werving gestart");
assert.equal(nlPage.active, true);
assert.equal(nlPage.start_date, "2020-10-28");
assert.equal(withOwnSite(nlPage, ["Maastro"]).own_site, null);                                         // no site list on this page

// Sites from CT.gov and CTIS.
const ctSites = parseCtgov({ protocolSection: { contactsLocationsModule: { locations: [
  { facility: "Maastro Clinic", city: "Maastricht", country: "Netherlands" }, { facility: "Other", city: "Ghent", country: "Belgium" }] } } });
assert.deepEqual([ctSites.sites_nl, withOwnSite(ctSites, ["Maastro"]).own_site], [["Maastro Clinic, Maastricht"], true]);
assert.equal(withOwnSite(parseCtgov({ protocolSection: {} }), ["Maastro"]).own_site, null);
const ctisSites = parseCtis({ authorizedApplication: { authorizedPartsII: [
  { mscInfo: { countryName: "Netherlands" }, trialSites: [{ organisationAddressInfo: { organisation: { name: "UMC Utrecht" }, address: { city: "Utrecht" } } }] },
  { mscInfo: { countryName: "Austria" }, trialSites: [{ organisationAddressInfo: { organisation: { name: "Wien" } } }] }] } });
assert.deepEqual([ctisSites.sites_nl, withOwnSite(ctisSites, ["Maastro"]).own_site], [["UMC Utrecht, Utrecht"], false]);

// Europe PMC protocol papers: open access first, then protocol; acronym hits in another case are dropped.
assert.equal(papersQuery({ source_id: "NCT1", trial_id: "PERYTON" }),
  '("NCT1" OR TITLE:"PERYTON") AND (TITLE:protocol OR TITLE:design OR TITLE:rationale OR PUB_TYPE:"Clinical Trial Protocol")');
assert.equal(papersQuery({ source_id: "NCT1", trial_id: "NCT1" }).startsWith('("NCT1") AND'), true);
const papers = parsePapers({ resultList: { result: [
  { title: "Biological impacts of rising temperatures: protocol", isOpenAccess: "Y" },
  { title: "Closed paper", isOpenAccess: "N", pmid: "1" },
  { title: "Study protocol (RISinG)", isOpenAccess: "Y", doi: "10.1/x", pubType: "clinical trial protocol" },
  { title: "Open design paper RISinG", isOpenAccess: "Y", pmcid: "PMC9" }] } }, "RISinG");
assert.deepEqual(papers.map((p) => p.url), ["https://doi.org/10.1/x", "https://europepmc.org/article/PMC/PMC9", "https://europepmc.org/article/MED/1"]);

// --previous auto
assert.equal(pickPrevious(["registry-2026-11-09.json", "registry-2026-11-16.json", "registry-2026-11-25.json", "notes.json"], "registry-2026-11-25.json"),
  "registry-2026-11-16.json");
assert.equal(pickPrevious(["registry-2026-11-25.json"], "registry-2026-11-25.json"), null);

console.log("Registry fetch parsing checks passed.");
