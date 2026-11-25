// Registry lookup in the app: NCT ids straight from ClinicalTrials.gov, other queries through Copilot (web search on),
// Copilot's criteria replaced by the verbatim CT.gov record when it names an NCT id. Graph and CT.gov are mocked.
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = new Map();
const plain = (x) => JSON.parse(JSON.stringify(x));
const calls = [];
const ctgov = (nct, acronym, facility) => ({
  protocolSection: {
    identificationModule: { nctId: nct, acronym, officialTitle: `${acronym} official title` },
    statusModule: { overallStatus: "RECRUITING", startDateStruct: { date: "2024-01" } },
    conditionsModule: { conditions: ["Prostate cancer"] },
    eligibilityModule: { eligibilityCriteria: "Inclusion Criteria:\n\n* Age >= 18\n\nExclusion Criteria:\n\n* Prior pelvic RT" },
    contactsLocationsModule: { locations: [{ facility, city: "Maastricht", country: "Netherlands" }] },
  },
});
const copilotAnswer = { results: [
  { query: "FLUID", found: true, trial_id: "FLUID", trial: "FLUID trial", registry_ids: ["NL-OMON12345"], source_id: "NL-OMON12345",
    source_url: "https://onderzoekmetmensen.nl/en/trial/12345", own_site: true, inclusion: "HPV-positive oropharynx", exclusion: "", notes: "" },
  { query: "PERYTON", found: true, trial_id: "PERYTON", registry_ids: ["NCT04642027", "NL-OMON99999"], source_id: "NL-OMON99999",
    source_url: "https://onderzoekmetmensen.nl/en/trial/99999", inclusion: "paraphrased by copilot", exclusion: "", own_site: null },
  { query: "NOPE", found: false, notes: "no registry record" },
] };

async function fakeFetch(url, opts = {}) {
  calls.push({ url: String(url), body: opts.body });
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  const m = String(url).match(/clinicaltrials\.gov\/api\/v2\/studies\/(NCT\d+)/);
  if (m) return json(ctgov(m[1], m[1] === "NCT04642027" ? "PERYTON" : "OTHER", m[1] === "NCT04642027" ? "Maastro Clinic" : "Maastricht UMC+"));
  if (/\/copilot\/conversations$/.test(url)) return json({ id: "conv-1" });
  if (/\/copilot\/conversations\/conv-1\/chat$/.test(url)) return json({ messages: [{ text: JSON.stringify(copilotAnswer) }] });
  throw new Error(`unexpected fetch ${url}`);
}

const context = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams,
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
  document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } },
  window: {}, Blob: class {}, File: class {}, Intl, atob, btoa,
  fetch: fakeFetch,
};
vm.createContext(context);
vm.runInContext(readFileSync(join(root, "app.js"), "utf8"), context);
context.loadSiteNames();                     // nothing saved yet: the default
assert.deepEqual(plain(vm.runInContext("state.siteNames", context)), ["Maastro"]);
context.setSiteNames("Maastro; Maastro"); // as typed in the Registries panel

// Query parsing: ids split, names kept whole.
assert.deepEqual(plain(context.parseRegistryQueries("NCT04642027 NCT05350722, PRECODE MRI; NL-OMON52643")),
  ["NCT04642027", "NCT05350722", "PRECODE MRI", "NL-OMON52643"]);

// Without a Microsoft sign-in, names cannot be looked up; NCT ids still work.
assert.equal(context.msConfig().clientId, "", "no client id configured in tests");
const direct = await context.registryLookup(["NCT05350722"]);
assert.equal(direct.rows[0].verified, true);
assert.equal(direct.rows[0].own_site, false, "another centre in the same city does not count");
await assert.rejects(context.registryLookup(["FLUID"]), /cannot be read from the browser/);

// Signed in (session in sessionStorage) with Copilot selected.
store.set("trialschema.ms.session", JSON.stringify({ access_token: "tok", expires_at: Date.now() + 3600e3, username: "user@example.org" }));
vm.runInContext(`state.llmProvider = "copilot";`, context);
assert.equal(context.hasLLMCredentials(), true, "a sign-in session counts as Copilot credentials");

calls.length = 0;
const { rows, notes } = await context.registryLookup(["FLUID", "PERYTON", "NOPE"]);
const chat = calls.find((c) => /\/chat$/.test(c.url));
assert.equal(JSON.parse(chat.body).contextualResources.webContext.isWebEnabled, true, "registry lookup turns web search on");
assert.equal(rows.length, 2);

const fluid = rows.find((r) => r.trial_id === "FLUID");
assert.equal(fluid.verified, false, "Copilot-only criteria are unverified");
assert.equal(fluid.retrieved_by, "copilot-web");
assert.equal(fluid.source, "nl");

const peryton = rows.find((r) => r.trial_id === "PERYTON");
assert.equal(peryton.verified, true, "NCT id found: criteria from CT.gov");
assert.equal(peryton.inclusion, "* Age >= 18", "verbatim CT.gov text replaces Copilot's");
assert.equal(peryton.source_id, "NCT04642027");
assert.deepEqual(plain(peryton.registry_ids), ["NL-OMON99999"]);
assert.equal(peryton.own_site, true, "own site listed on CT.gov");
assert.match(context.buildRegistryLookupPrompt(["X"]).system, /own_site: true when one of these is a listed participating site: Maastro/);
assert.equal(context.ownSite(["Maastro Clinic"], []), null, "no site names: no own-site check");
assert.ok(notes.some((n) => n.startsWith("NOPE: not found")));
assert.ok(notes.some((n) => /FLUID: criteria from Copilot/.test(n)));

// Rows are detected as registry rows and become identifiers + provenance on the processed trial.
assert.equal(context.detectFormat("registry-lookup.json", peryton), "registry");
assert.match(context.buildUserPrompt({ __raw: peryton, __sourceFormat: "registry" }), /Public trial-registry record/);
const trial = context.applySourceFields(context.sanitizeTrial({ trial_id: "PERYTON", criteria: [] }), { __raw: peryton, __sourceFormat: "registry" });
assert.deepEqual(plain(trial.identifiers.map((i) => i.value)), ["NCT04642027", "NL-OMON99999"]);
assert.equal(trial.foreign_extensions["org.trialschema.source"].verified, true);

// Trial extraction itself stays web-off.
assert.equal(plain(context.copilotChatPayload("x")).contextualResources.webContext.isWebEnabled, false);

// Site names travel with the export and come back on import.
const exported = plain(context.toV1Envelope([], null));
assert.deepEqual(exported.extensions["org.trialschema.workspace"].site_names, ["Maastro"]);
context.setSiteNames("", { save: false });
context.fromV1Envelope(exported);
assert.deepEqual(plain(vm.runInContext("state.siteNames", context)), ["Maastro"]);

console.log("Registry lookup checks passed.");
