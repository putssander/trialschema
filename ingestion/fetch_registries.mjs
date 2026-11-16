#!/usr/bin/env node
// Fetch eligibility criteria from public registries into a file the TrialSchema app imports (Upload -> JSON).
//
//   node ingestion/fetch_registries.mjs NCT05350722 NL-OMON52643 2024-510578-25-00 [--lang nl] [--out file.json]
//
// Sources: ClinicalTrials.gov API v2 (NCT…), the Dutch register onderzoekmetmensen.nl (NL-OMON…), EU CTIS (yyyy-nnnnnn-nn-nn).
// The Dutch register and CTIS do not allow browser requests (CORS), hence this script instead of the app.
// Output: one row per trial with the app's import columns (trial_id, trial, inclusion, exclusion, active, condition,
// start_date, completion_date) plus source and source_url. Raw responses go to ingestion/ignore/registry-raw/<date>/.
// Pass --previous <earlier output> to list what changed. Requests are spaced 1 s apart.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

export function parseCtgov(j) {
  const p = j.protocolSection || {};
  const text = p.eligibilityModule?.eligibilityCriteria || "";
  const m = text.split(/exclusion criteria:?/i);
  const status = p.statusModule?.overallStatus || "";
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
  };
}

export function parseNl(html) {
  const section = (name) => {
    const i = html.search(new RegExp(`<h3>\\s*${name}\\s*</h3>`, "i"));
    if (i < 0) return "";
    const rest = html.slice(i).replace(/^<h3>[^<]*<\/h3>/i, "");
    const end = rest.search(/<h3>|<\/section>/i);
    return decode(end < 0 ? rest : rest.slice(0, end));
  };
  const title = decode((html.match(/<title>([^<]*)<\/title>/i) || [, ""])[1]).split(" | ")[0];
  return { trial_id: (title.match(/\(([A-Za-z0-9-]{2,20})\)\s*$/) || [, ""])[1], trial: title,
           inclusion: section("Inclusion criteria|Inclusiecriteria"), exclusion: section("Exclusion criteria|Exclusiecriteria") };
}

export function parseCtis(j, lang = "en") {
  const app = j.authorizedApplication?.authorizedPartI || {};
  const info = app.trialDetails?.trialInformation || {};
  const list = (items, key) => (items || []).sort((a, b) => (a.number || 0) - (b.number || 0)).map((c) => {
    const nl = (c[`${key}Translations`] || []).map((t) => t.attributeTranslation).find(Boolean);
    return `${c.number}. ${lang === "nl" && nl ? nl : c[key]}`;
  }).join("\n");
  const ident = app.trialDetails?.clinicalTrialIdentifiers || {};
  return { trial_id: ident.shortTitle || j.ctNumber, trial: ident.publicTitle || ident.fullTitle || j.ctNumber,
           inclusion: list(info.eligibilityCriteria?.principalInclusionCriteria, "principalInclusionCriteria"),
           exclusion: list(info.eligibilityCriteria?.principalExclusionCriteria, "principalExclusionCriteria"),
           active: /authori[sz]ed|ongoing/i.test(j.ctStatus || ""), start_date: j.startDateEU || "", status: j.ctStatus || "" };
}

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

export async function fetchOne(id, lang, rawDir) {
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
  if (rawDir) writeFileSync(join(rawDir, `${id}.${k === "nl" ? "html" : "json"}`), body);
  if (!row.inclusion && !row.exclusion) throw new Error(`${id}: no criteria found at ${url}`);
  return { ...row, trial_id: row.trial_id || id, source: k, source_id: id, source_url: url };
}

export function changes(prev, next) {
  const old = Object.fromEntries(prev.map((r) => [r.source_id, r]));
  return next.flatMap((r) => {
    const o = old[r.source_id];
    if (!o) return [`${r.source_id}: new`];
    return ["inclusion", "exclusion", "status", "completion_date"].filter((f) => (o[f] || "") !== (r[f] || "")).map((f) => `${r.source_id}: ${f} changed`);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
  const date = new Date().toISOString().slice(0, 10);
  const here = dirname(fileURLToPath(import.meta.url));
  const lang = opt("--lang", "en");
  const out = opt("--out", join(here, "ignore", `registry-${date}.json`));
  const previous = opt("--previous", "");
  const rawDir = join(here, "ignore", "registry-raw", date);
  if (!args.length) { console.error("usage: node ingestion/fetch_registries.mjs <ids…> [--lang nl] [--out file] [--previous file]"); process.exit(2); }
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(dirname(out), { recursive: true });
  const rows = [], failed = [];
  for (const id of args) {
    try { rows.push(await fetchOne(id, lang, rawDir)); console.log(`ok   ${id}`); }
    catch (e) { failed.push(id); console.log(`FAIL ${e.message}`); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  writeFileSync(out, JSON.stringify(rows, null, 1));
  console.log(`${rows.length} trial(s) -> ${out}${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
  if (previous) console.log(changes(JSON.parse(readFileSync(previous, "utf8")), rows).join("\n") || "no changes");
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
