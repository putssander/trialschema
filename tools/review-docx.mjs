#!/usr/bin/env node
// Human-readable review document of a TrialSchema export: an overview, then one section per trial with its sources,
// the original criteria text, the current setup and what changed. Generated from the JSON, never edited by hand;
// archive it next to the export with the same fingerprint.
//
//   npm install            (once, for the docx library; the app itself has no dependencies)
//   node tools/review-docx.mjs export.json [--previous older.json] [--sources registry.json] [--review findings.json]
//        [--out trialschema_<fingerprint>.docx]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { AlignmentType, BorderStyle, Document, Footer, HeadingLevel, Packer, PageNumber, Paragraph,
  ShadingType, Table, TableCell, TableRow, TextRun, WidthType } from "docx";

const FONT = "Calibri", INK2 = "4B5563", BLUE = "1D5FA8", W = 9638;
const t = (text, o = {}) => new TextRun({ text: String(text ?? ""), font: FONT, ...o });
const p = (runs, o = {}) => new Paragraph({ children: Array.isArray(runs) ? runs : [t(runs)], spacing: { after: 80 }, ...o });
const h1 = (x) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [t(x)] });
const h2 = (x) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [t(x)] });
const border = { style: BorderStyle.SINGLE, size: 4, color: "C9D1DB" };
function table(widths, header, rows) {
  const cell = (c, w, head) => new TableCell({ width: { size: w, type: WidthType.DXA },
    borders: { top: border, bottom: border, left: border, right: border },
    shading: head ? { fill: "E6EEF8", type: ShadingType.CLEAR, color: "auto" } : undefined,
    margins: { top: 50, bottom: 50, left: 80, right: 80 },
    children: String(c ?? "").split("\n").map((line) => new Paragraph({ children: [t(line, { bold: head, size: 17 })] })) });
  return new Table({ width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: widths,
    rows: [new TableRow({ tableHeader: true, children: header.map((h, i) => cell(h, widths[i], true)) }),
      ...rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, widths[i], false)) }))] });
}

export function describe(c) {
  const k = c.constraint || {};
  const q = (x) => (x ? `${x.value ?? ""} ${x.unit ?? ""}`.trim() : "");
  let how = k.kind === "comparison" ? `${k.operator} ${q(k.quantity)}` : k.kind === "range" ? `${q(k.low)} – ${q(k.high)}` : k.kind || "text";
  const m = c.extensions?.["org.maastrials.method"];
  if (m) how += ` · ${typeof m === "string" ? m : m.method || JSON.stringify(m)}`;
  const tm = c.timing ? (c.timing.scope === "lookback" ? `within ${c.timing.lookback?.value ?? ""} ${c.timing.lookback?.unit ?? ""}` : c.timing.scope) : "";
  return { how, timing: tm, where: [...(c.routing?.primary || [])].join(", ") + (c.routing?.fallback?.length ? ` / ${c.routing.fallback.join(", ")}` : "") };
}

const FIELDS = ["kind", "enabled", "rank", "clarified_text", "constraint", "assertion", "timing", "routing", "guidance"];
export function diffTrial(prev, cur) {
  if (!prev) return ["new trial in this version"];
  const out = [];
  const pc = Object.fromEntries((prev.criteria || []).map((c) => [c.id, c]));
  const cc = Object.fromEntries((cur.criteria || []).map((c) => [c.id, c]));
  for (const id of Object.keys(cc)) {
    if (!pc[id]) { out.push(`${id}: added`); continue; }
    const changed = FIELDS.filter((f) => JSON.stringify(pc[id][f] ?? null) !== JSON.stringify(cc[id][f] ?? null));
    if (changed.length) out.push(`${id}: ${changed.join(", ")} changed`);
  }
  for (const id of Object.keys(pc)) if (!cc[id]) out.push(`${id}: removed`);
  if (JSON.stringify(prev.care_path_ids) !== JSON.stringify(cur.care_path_ids)) out.push(`care paths: ${(prev.care_path_ids || []).join(", ")} → ${(cur.care_path_ids || []).join(", ")}`);
  return out.length ? out : ["no changes"];
}

export function sourceOf(trial) {
  const ids = (trial.identifiers || []).map((i) => i.value).filter((v) => /^(NCT\d{8}|NL-?OMON\d+|\d{4}-\d{6}-\d{2}-\d{2})$/i.test(v));
  return ids.length ? ids.join(", ") : "site spreadsheet";
}

export function extractedOf(trial) {
  const pv = trial.provenance || {};
  if (!pv.ai_by && !pv.manually_edited) return "—";
  const model = String(pv.ai_by || "").split(" via ")[0];
  return `${model || "manual"}${pv.ai_at ? `, ${String(pv.ai_at).slice(0, 10)}` : ""}${pv.manually_edited ? ", edited" : ", not reviewed"}`;
}

export function build(cur, { previous, sources, review, fingerprint }) {
  const prevById = Object.fromEntries((previous?.trials || []).map((x) => [x.id, x]));
  const findings = review?.findings || [];
  const regBySource = Object.fromEntries((sources || []).map((r) => [r.source_id, r]));
  const trials = [...(cur.trials || [])].sort((a, b) => a.id.localeCompare(b.id));
  const cps = Object.fromEntries((cur.care_path_catalog || []).map((c) => [c.id, c.label || c.id]));
  const kids = [
    new Paragraph({ spacing: { after: 60 }, children: [t("Trial definitions", { size: 44, bold: true, color: BLUE })] }),
    p([t(`Version ${fingerprint} · format ${cur.format_version} · generated from the JSON export on ${new Date().toISOString().slice(0, 10)}. Do not edit; regenerate.`, { size: 18, color: INK2 })]),
    h1("Overview"),
    table([1650, 1900, 2050, 1838, 800, 600, 800], ["Trial", "Care paths", "Source", "Extracted", "Criteria on", "Active", "Review"],
      trials.map((x) => {
        const n = (x.criteria || []).length, on = (x.criteria || []).filter((c) => c.enabled !== false).length;
        const f = findings.filter((y) => y.trial === x.id);
        return [x.id, (x.care_path_ids || []).map((c) => cps[c] || c).join(", "), sourceOf(x), extractedOf(x), `${on} of ${n}`,
          x.enabled === false ? "no" : "yes", f.length ? `${f.filter((y) => y.severity === "high").length} high, ${f.length} total` : (review ? "none" : "—")];
      })),
    p([t("How the matching uses this: each enabled criterion is checked in rank order in the listed document types; a confident failure stops the trial unless that option is off. Fields used: kind, enabled, rank, clarified text, constraint, assertion, timing, routing, guidance, care paths. Not used for matching: concept, conditions, interventions, identifiers, provenance.", { size: 17, color: INK2 })]),
  ];
  for (const x of trials) {
    const reg = (x.identifiers || []).map((i) => regBySource[i.value]).find(Boolean);
    const note = x.extensions?.["org.maastrials.source"]?.criteria_from;
    kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [t(`${x.id} — ${x.title || ""}`)] }),
      p([t("Source: ", { bold: true }), t(note || sourceOf(x)), t("   Extracted: ", { bold: true }), t(extractedOf(x)),
        ...(typeof x.extensions?.["org.trialschema.source"]?.own_site === "boolean"
          ? [t("   Own site listed: ", { bold: true }), t(x.extensions["org.trialschema.source"].own_site ? "yes" : "no")] : [])]),
      p([t("Care paths: ", { bold: true }), t((x.care_path_ids || []).map((c) => cps[c] || c).join(", ") || "—"),
        t("   Active: ", { bold: true }), t(x.enabled === false ? "no" : "yes")]));
    kids.push(h2("Original criteria"));
    if (reg) {
      kids.push(p([t(`From ${reg.source_url}:`, { size: 17, color: INK2 })]), p([t("Inclusion", { bold: true })]),
        ...reg.inclusion.split("\n").filter(Boolean).map((l) => p([t(l, { size: 18 })], { spacing: { after: 0 } })),
        p([t("Exclusion", { bold: true })], { spacing: { before: 80, after: 40 } }),
        ...reg.exclusion.split("\n").filter(Boolean).map((l) => p([t(l, { size: 18 })], { spacing: { after: 0 } })));
    } else {
      const seen = new Set();
      for (const c of x.criteria || []) if (c.source_text && !seen.has(c.source_text)) {
        seen.add(c.source_text);
        kids.push(p([t(`${c.kind === "exclusion" ? "Excl." : "Incl."} `, { bold: true, size: 18 }), t(c.source_text, { size: 18 })], { spacing: { after: 20 } }));
      }
    }
    kids.push(h2("Current setup"),
      table([450, 800, 3900, 1700, 1000, 1788], ["#", "ID", "Checked as (clarified)", "How", "When", "Where (primary / fallback)"],
        [...(x.criteria || [])].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).map((c) => {
          const d = describe(c);
          return [c.rank ?? "", `${c.id}${c.enabled === false ? " (off)" : ""}\n${c.kind === "exclusion" ? "excl." : "incl."}`,
            c.clarified_text + (c.guidance ? `\nGuidance: ${c.guidance}` : ""), d.how, d.timing, d.where];
        })));
    kids.push(h2(previous ? "What changed since the previous version" : "What changed"),
      ...diffTrial(prevById[x.id], x).map((l) => p([t(`• ${l}`, { size: 18 })], { spacing: { after: 0 } })));
    // Criteria that only Copilot (web search) provided are a review point until compared with the register.
    const src = x.extensions?.["org.trialschema.source"];
    const f = [...(src?.verified === false ? [{ trial: x.id, criterion: "all", severity: "high",
      issue: `Criteria copied by Copilot from ${src.source_url || "the web"}; not yet compared with the register.`,
      suggested_fix: `Fetch with node ingestion/fetch_registries.mjs ${src.source_id || "<id>"} and compare.` }] : []),
      ...findings.filter((y) => y.trial === x.id)];
    if (f.length) kids.push(h2("Open review points"),
      table([900, 900, 4400, 3438], ["Criterion", "Severity", "Issue", "Suggested fix"], f.map((y) => [y.criterion, y.severity, y.issue, y.suggested_fix])));
  }
  return new Document({
    styles: { default: { document: { run: { font: FONT, size: 20 } } }, paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", run: { font: FONT, size: 30, bold: true, color: BLUE }, paragraph: { spacing: { before: 120, after: 120 } } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", run: { font: FONT, size: 22, bold: true }, paragraph: { spacing: { before: 200, after: 80 } } }] },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1000, bottom: 1000, left: 1134, right: 1134 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [
        t(`Trial definitions ${fingerprint} · page `, { size: 16, color: INK2 }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: INK2 })] })] }) },
      children: kids }] });
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : ""; };
  const prevPath = opt("--previous"), srcPath = opt("--sources"), revPath = opt("--review"), outPath = opt("--out");
  if (!args[0]) { console.error("usage: node tools/review-docx.mjs export.json [--previous f] [--sources f] [--review f] [--out f]"); process.exit(2); }
  const raw = readFileSync(args[0]);
  const fingerprint = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  const load = (f) => (f ? JSON.parse(readFileSync(f, "utf8")) : null);
  const doc = build(JSON.parse(raw), { previous: load(prevPath), sources: load(srcPath), review: load(revPath), fingerprint });
  const out = outPath || `trialschema_${fingerprint}.docx`;
  writeFileSync(out, await Packer.toBuffer(doc));
  console.log(`${out} (version ${fingerprint})`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) main();
