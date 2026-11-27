#!/usr/bin/env node
// Fetch eligibility criteria from public registries into a file the TrialSchema app imports (Upload -> JSON).
//
//   node ingestion/fetch_registries.mjs NCT05350722 NL-OMON52643 2024-510578-25-00 [--lang nl] [--out file.json]
//                                       [--previous <file>|auto] [--papers] [--site "Name A,Name B"]
//
// Sources: ClinicalTrials.gov API v2 (NCT…), the Dutch register onderzoekmetmensen.nl (NL-OMON…), EU CTIS (yyyy-nnnnnn-nn-nn).
// The Dutch register and CTIS do not allow browser requests (CORS), hence this script instead of the app.
// Output: one row per trial with the app's import columns (trial_id, trial, inclusion, exclusion, active, condition,
// start_date, completion_date) plus source, source_url, status, sites_nl (Dutch sites where the registry lists them) and
// own_site (true / false / null = no sites listed or no site names; --site "A,B", default Maastro, --site "" = no check). --papers adds protocol_publications from Europe PMC.
// Raw responses go to ingestion/ignore/registry-raw/<date>/. --previous lists what changed ("auto" = the newest earlier
// registry-*.json next to the output). Requests are spaced 1 s apart.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UA = "TrialSchema-registry-fetch/1.0";
const ACTIVE_CTGOV = new Set(["RECRUITING", "NOT_YET_RECRUITING", "ENROLLING_BY_INVITATION", "ACTIVE_NOT_RECRUITING"]);

export function kind(id) {
  if (/^NCT\d{8}$/i.test(id)) return "ctgov";
  if (/^NL-?OMON\d+$/i.test(id)) return "nl";
  if (/^\d{4}-\d{6}-\d{2}-\d{2}$/.test(id)) return "ctis";
  return null;
}

function decode(html) {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#0?39;/g, "'").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// true when a listed site contains one of the site names (case-insensitive), false when sites are listed but none
// matches, null when the registry lists no sites or no site names are set.
export function ownSite(sites, names) {
  const ns = (names || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
  if (!ns.length || !sites?.length) return null;
  return sites.some((s) => ns.some((n) => String(s).toLowerCase().includes(n)));
}

// Parsers return every listed site (sites_all); the row keeps only the verdict for the configured names.
export function withOwnSite(row, names) {
  const { sites_all, ...rest } = row;
  return { ...rest, own_site: ownSite(sites_all, names) };
}


function isoDmy(s) {
  const m = String(s || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(s || "");
}

export function parseCtgov(j) {
  const p = j.protocolSection || {};
  const text = p.eligibilityModule?.eligibilityCriteria || "";
  const m = text.split(/exclusion criteria:?/i);
  const status = p.statusModule?.overallStatus || "";
  const locations = p.contactsLocationsModule?.locations || [];
  const label = (l) => [l.facility, l.city].filter(Boolean).join(", ");
  return {
    trial_id: p.identificationModule?.acronym || p.identificationModule?.nctId,
    trial: p.identificationModule?.officialTitle || p.identificationModule?.briefTitle || "",
    inclusion: (m[0] || "").replace(/inclusion criteria:?/i, "").trim(),
    exclusion: (m[1] || "").trim(),
    active: ACTIVE_CTGOV.has(status),
    condition: (p.conditionsModule?.conditions || []).join("; "),
    start_date: p.statusModule?.startDateStruct?.date || "",
    completion_date: p.statusModule?.completionDateStruct?.date || "",
    status,
    sites_nl: locations.filter((l) => /netherlands/i.test(l.country || "")).map(label),
    sites_all: locations.map(label),
  };
}

// Dutch register (onderzoekmetmensen.nl, Drupal pages). English and Dutch headings differ:
// "Inclusion criteria" vs "Belangrijkste voorwaarden om deel te mogen nemen (Inclusiecriteria)".
export function parseNl(html) {
  const headings = [...html.matchAll(/<h3>([^<]*)<\/h3>/gi)];
  const section = (re) => {
    const h = headings.find((m) => re.test(decode(m[1])));
    if (!h) return "";
    const rest = html.slice(h.index + h[0].length);
    const end = rest.search(/<h3>|<\/section>/i);
    return decode(end < 0 ? rest : rest.slice(0, end));
  };
  // Inline "Label : value" fields; the label may carry a tooltip button ("i").
  const fields = [...html.matchAll(/<div class="field-label field-group field-label--inline">([\s\S]*?):\s*<\/div>\s*<div>([\s\S]*?)<\/div>/g)]
    .map((m) => [decode(m[1]).split("\n")[0].trim(), decode(m[2])]);
  const field = (re) => (fields.find(([k]) => re.test(k)) || [, ""])[1];
  const sites = html.split(/paragraph--type--par-trial-site/).slice(1)
    .map((chunk) => decode((chunk.match(/<div>([\s\S]*?)<\/div>/) || [, ""])[1])).filter(Boolean);
  const status = field(/^(recruitment status|status)$/i);
  const active = /recruiting|recruitment started|pending|werving gestart|nog niet gestart/i.test(status) ? true
    : /stopped|ended|completed|withdrawn|suspended|gestopt|afgerond|beëindigd|teruggetrokken|opgeschort/i.test(status) ? false : undefined;
  const title = decode((html.match(/<title>([^<]*)<\/title>/i) || [, ""])[1]).split(" | ")[0];
  return { trial_id: (title.match(/\(([A-Za-z0-9-]{2,20})\)\.?\s*$/) || [, ""])[1], trial: title,
           inclusion: section(/^inclusion criteria$|inclusiecriteria/i), exclusion: section(/^exclusion criteria$|exclusiecriteria/i),
           ...(active === undefined ? {} : { active }), status, start_date: isoDmy(field(/^start date|startdatum$/i)),
           sites_nl: sites, sites_all: sites };
}

export function parseCtis(j, lang = "en") {
  const app = j.authorizedApplication?.authorizedPartI || {};
  const info = app.trialDetails?.trialInformation || {};
  const list = (items, key) => (items || []).sort((a, b) => (a.number || 0) - (b.number || 0)).map((c) => {
    const nl = (c[`${key}Translations`] || []).map((t) => t.attributeTranslation).find(Boolean);
    return `${c.number}. ${lang === "nl" && nl ? nl : c[key]}`;
  }).join("\n");
  const ident = app.trialDetails?.clinicalTrialIdentifiers || {};
  // Part II per member state: trial sites with organisation and city (person names are not copied).
  const parts = j.authorizedApplication?.authorizedPartsII || [];
  const site = (s) => [s.organisationAddressInfo?.organisation?.name, s.organisationAddressInfo?.address?.city].filter(Boolean).join(", ");
  const all = parts.flatMap((p) => (p.trialSites || []).map(site));
  return { trial_id: ident.shortTitle || j.ctNumber, trial: ident.publicTitle || ident.fullTitle || j.ctNumber,
           inclusion: list(info.eligibilityCriteria?.principalInclusionCriteria, "principalInclusionCriteria"),
           exclusion: list(info.eligibilityCriteria?.principalExclusionCriteria, "principalExclusionCriteria"),
           active: /authori[sz]ed|ongoing/i.test(j.ctStatus || ""), start_date: j.startDateEU || "", status: j.ctStatus || "",
           sites_nl: parts.filter((p) => /netherlands/i.test(p.mscInfo?.countryName || "")).flatMap((p) => (p.trialSites || []).map(site)),
           sites_all: all };
}

// Europe PMC: protocol papers that name the registry id, or carry the acronym in the title.
export function acronymOf(row) {
  const a = String(row.trial_id || "");
  return a && a !== row.source_id && !/\s/.test(a) && a.length <= 20 ? a : "";
}

export function papersQuery(row) {
  const terms = [`"${row.source_id}"`];
  if (acronymOf(row)) terms.push(`TITLE:"${acronymOf(row)}"`);
  return `(${terms.join(" OR ")}) AND (TITLE:protocol OR TITLE:design OR TITLE:rationale OR PUB_TYPE:"Clinical Trial Protocol")`;
}

// Title search is case-insensitive, so an acronym that is also a word ("RISinG", "FLUID") pulls in unrelated papers:
// a title that contains the acronym only in another case is dropped.
export function parsePapers(j, acronym = "", max = 5) {
  const protocol = (r) => /protocol/i.test(`${r.pubType || ""} ${r.title || ""}`);
  const wrongCase = (t) => acronym && t.toLowerCase().includes(acronym.toLowerCase()) && !t.includes(acronym);
  return (j.resultList?.result || []).filter((r) => !wrongCase(r.title || ""))
    .map((r, i) => ({ r, i, oa: r.isOpenAccess === "Y", p: protocol(r) }))
    .sort((a, b) => (b.oa - a.oa) || (b.p - a.p) || (a.i - b.i))
    .slice(0, max)
    .map(({ r, oa }) => ({ title: r.title || "", doi: r.doi || "", pmid: r.pmid || "", pmcid: r.pmcid || "",
      journal: r.journalTitle || "", year: r.pubYear || "", open_access: oa,
      url: r.doi ? `https://doi.org/${r.doi}` : r.pmcid ? `https://europepmc.org/article/PMC/${r.pmcid}` : `https://europepmc.org/article/MED/${r.pmid || r.id}` }));
}

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

export async function fetchPapers(row) {
  const q = new URLSearchParams({ query: papersQuery(row), format: "json", pageSize: "10", resultType: "lite" });
  return parsePapers(JSON.parse(await get(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${q}`)), acronymOf(row));
}

export async function fetchOne(id, lang, rawDir, siteNames = []) {
  const k = kind(id);
  let url, body, row;
  if (k === "ctgov") {
    url = `https://clinicaltrials.gov/api/v2/studies/${id.toUpperCase()}?format=json`;
    body = await get(url); row = parseCtgov(JSON.parse(body));
  } else if (k === "nl") {
    url = `https://onderzoekmetmensen.nl/${lang === "nl" ? "nl" : "en"}/trial/${id.replace(/\D/g, "")}`;
    body = await get(url); row = parseNl(body);
  } else if (k === "ctis") {
    url = `https://euclinicaltrials.eu/ctis-public-api/retrieve/${id}`;
    body = await get(url); row = parseCtis(JSON.parse(body), lang);
  } else throw new Error(`${id}: unknown identifier (NCT…, NL-OMON…, or a CTIS number)`);
  if (rawDir) writeFileSync(join(rawDir, `${id}${lang === "nl" ? ".nl" : ""}.${k === "nl" ? "html" : "json"}`), body);
  if (!row.inclusion && !row.exclusion) throw new Error(`${id}: no criteria found at ${url}`);
  return { ...withOwnSite(row, siteNames), trial_id: row.trial_id || id, source: k, source_id: id, source_url: url };
}

const TRACKED = ["inclusion", "exclusion", "status", "completion_date", "own_site"];

export function changes(prev, next) {
  const old = Object.fromEntries(prev.map((r) => [r.source_id, r]));
  return next.flatMap((r) => {
    const o = old[r.source_id];
    if (!o) return [`${r.source_id}: new`];
    return TRACKED.filter((f) => String(o[f] ?? "") !== String(r[f] ?? "")).map((f) =>
      f === "own_site" ? `${r.source_id}: own_site ${o[f] ?? "unknown"} -> ${r[f] ?? "unknown"}` : `${r.source_id}: ${f} changed`);
  });
}

// --previous auto: the newest earlier registry-*.json (names sort by date), never the output file itself.
export function pickPrevious(names, outName) {
  return names.filter((n) => /^registry-\d{4}-\d{2}-\d{2}.*\.json$/.test(n) && n !== outName).sort().pop() || null;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? !!args.splice(i, 1) : false; };
  const date = new Date().toISOString().slice(0, 10);
  const here = dirname(fileURLToPath(import.meta.url));
  const lang = opt("--lang", "en");
  const out = opt("--out", join(here, "ignore", `registry-${date}.json`));
  let previous = opt("--previous", "");
  const papers = flag("--papers");
  const siteNames = opt("--site", "Maastro").split(",").map((s) => s.trim()).filter(Boolean);
  const rawDir = join(here, "ignore", "registry-raw", date);
  if (!args.length) { console.error("usage: node ingestion/fetch_registries.mjs <ids…> [--lang nl] [--out file] [--previous file|auto] [--papers] [--site names]"); process.exit(2); }
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(dirname(out), { recursive: true });
  if (previous === "auto") {
    const name = pickPrevious(readdirSync(dirname(out)), basename(out));
    previous = name ? join(dirname(out), name) : "";
    console.log(previous ? `previous: ${previous}` : "previous: none found");
  }
  const rows = [], failed = [];
  for (const id of args) {
    try {
      const row = await fetchOne(id, lang, rawDir, siteNames);
      if (papers) {
        await new Promise((r) => setTimeout(r, 1000));
        try { row.protocol_publications = await fetchPapers(row); } catch (e) { console.log(`     papers: ${e.message}`); }
      }
      rows.push(row);
      console.log(`ok   ${id}  own_site=${row.own_site ?? "unknown"}${papers ? `  papers=${row.protocol_publications?.length ?? "?"}` : ""}`);
    } catch (e) { failed.push(id); console.log(`FAIL ${e.message}`); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  writeFileSync(out, JSON.stringify(rows, null, 1));
  console.log(`${rows.length} trial(s) -> ${out}${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
  if (previous) console.log(changes(JSON.parse(readFileSync(previous, "utf8")), rows).join("\n") || "no changes");
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
