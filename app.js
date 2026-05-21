/* =====================================================================
 * TrialSchema — app.js
 * 100% client-side BYOK pipeline. Transforms raw clinical trial rows
 * into the structured TrialSchema execution model via OpenAI.
 *
 * Sections:
 *   1.  Constants & state
 *   2.  API key handling (localStorage)
 *   3.  /ingestion/ folder discovery + manual file uploads
 *   4.  Source parsers (TrialGPT, Org JSON, Dutch Excel/CSV via SheetJS)
 *   5.  Delta diffing (existing TrialSchema export merge)
 *   6.  OpenAI request (system prompt enforcing all extraction rules)
 *   7.  Throttled queue runner
 *   8.  Rendering: trials list & Clinical Review & Override Workspace
 *   9.  Export & utilities
 * ===================================================================== */


/* =========================== 1. CONSTANTS & STATE =========================== */

// Document hierarchy (Rule 1) — universal clinical document domains.
// IDs are stable internal contract; labels/hints are user-facing and generalized
// across all medical fields (oncology, cardiology, neurology, endocrinology, …).
const DOC_HIERARCHY = [
  { group: "intake_layer",     id: "intake_notes",      label: "Intake Notes",                       short: "Intake", hint: "Demographics, admin rules, general medical history" },
  { group: "intake_layer",     id: "referral_letters",  label: "Referral Letters",                   short: "Refer",  hint: "External clinical history validation" },
  { group: "decision_layer",   id: "mdo_notes",         label: "Multidisciplinary / Specialty Board Notes", short: "MDB",   hint: "MDT/MDO, tumor boards, surgical boards, consensus reviews, therapeutic strategy" },
  { group: "diagnostic_core",  id: "pathology",         label: "Histology / Pathology",              short: "Path",   hint: "Microscopic properties, tissue biomarkers, cellular pathology, biopsies" },
  { group: "diagnostic_core",  id: "imaging_radiology", label: "Imaging / Functional Testing",       short: "Imag",   hint: "Structural lesions, size tracking, radiology, MRI, CT, EKG/ECG, EEG, echo" },
  { group: "diagnostic_core",  id: "treatment_history", label: "Treatment History",                  short: "Tx Hx",  hint: "Prior systemic therapy, prior medication lines, washouts, surgical interventions" },
  { group: "eligibility_layer",id: "molecular_genomic", label: "Advanced / Genomic Labs",            short: "Mol",    hint: "Genetic sequencing, molecular profiling, liquid biopsy" },
  { group: "eligibility_layer",id: "core_lab",          label: "Core Laboratory / Chemistries",      short: "Lab",    hint: "Standard blood/urine, metabolic panels, cell counts (HbA1c, creatinine, potassium…)" },
  { group: "soft_layer",       id: "other",             label: "Other / Soft criterion",             short: "Other",  hint: "Consent, willingness, logistics, study-specific rules — pair with free-text guidance" },
  { group: "fallback",         id: "unknown",           label: "Unknown",                            short: "?",      hint: "Only when document domain cannot be determined" },
];
// IDs included in the doc-routing matrix (every column except "unknown").
const MATRIX_DOCS = DOC_HIERARCHY.filter(d => d.id !== "unknown");
const DOC_BY_ID = Object.fromEntries(DOC_HIERARCHY.map(d => [d.id, d]));

// Canonical set of criterion-category ids accepted from the LLM. Anything
// outside this set is normalised to "other" (the only case where free-text
// guidance is offered to the user). "unknown" is excluded — it's a doc-routing
// fallback, not a meaningful criterion category.
const KNOWN_CATEGORIES = new Set(
  DOC_HIERARCHY.filter(d => d.id !== "unknown").map(d => d.id)
);

// Default candidate filenames inside /ingestion/. Static apps can't list a
// directory, so we probe a manifest file first, then a sensible default list.
// (Folder scanning is disabled by default; templates + manual upload only.)

// Default "three main" primary documents that should be checked on every
// criterion. Two are constant (intake + multi-disciplinary review); the third
// is inferred from the criterion's clinical category. Anything else routed by
// the LLM moves to fallback_docs (optional secondary checks).
const DEFAULT_PRIMARY_BASE = ["intake_notes", "mdo_notes"];

function inferThirdPrimary(criterion) {
  const blob = `${criterion.category||""} ${criterion.original_text||""} ${criterion.structured_target?.metric||""}`.toLowerCase();
  if (/molecul|gene|mutation|biomark|genom|liquid biops|ctdna|sequenc/.test(blob))     return "molecular_genomic";
  if (/lab|blood|urine|chem|wbc|platelet|neutrophil|hb |hemoglob|gfr|creatin|alt|ast|bilirub|pth|sodium|potassium|electrolyte|hba1c|glucose|cholesterol|metabolic|panel/.test(blob)) return "core_lab";
  if (/imag|mri|ct|pet|scan|lesion|tumor size|radiograph|sonograph|ultrasound|echo|ekg|ecg|eeg|x-ray|xray|angiogra|spirometr/.test(blob)) return "imaging_radiology";
  if (/patholog|histolog|tissue|biopsy|specimen|grade|cytolog/.test(blob))             return "pathology";
  if (/prior|previous|treatment|therap|surger|washout|chemo|radiation|line of|medication|prior med/.test(blob)) return "treatment_history";
  // Demographics / consent / general -> already covered by intake_notes; pick
  // referral_letters as a third sensible default.
  return "referral_letters";
}

// Recruitment status normalization targets (Rule 4).
const RECRUITMENT_STATES = [
  "Not yet recruiting",
  "Recruiting",
  "Active, not recruiting",
  "Completed",
];

// Global app state ----------------------------------------------------------
const state = {
  apiKey: "",
  model: "gpt-5.5",
  format: "trialgpt",
  throttleMs: 1500,
  maxTrials: 1000,
  ingestionFiles: [],   // [{ name, path, source: 'folder'|'upload', file?, rows? }]
  newFile: null,        // manually uploaded source
  existingExport: null, // parsed prior trialschema_export.json
  existingById: {},     // map: trial_id -> structured trial (verbatim re-use)
  rawRows: [],          // normalized raw rows (pre-LLM)
  results: [],          // final structured trials (in display order)
  resultsById: {},      // map: trial_id -> structured trial
  running: false,
  abort: false,
  carePaths: [],        // normalized clinical-domain enum [{id, label, aliases[]}]
};


/* =========================== 2. API KEY HANDLING =========================== */

const KEY_STORAGE = "trialschema.openai.key";
const MODEL_STORAGE = "trialschema.openai.model";

// Fetch available GPT models from OpenAI and populate the dropdown.
// Called after API key is saved/loaded. Falls back to a curated list if
// the key is absent or the request fails.
const FALLBACK_MODELS = [
  "gpt-5.5",
  "gpt-5",
  "gpt-4.5",
  "gpt-4.1",
  "gpt-4o",
];

async function loadModels() {
  const sel = document.getElementById("modelSelect");
  const savedModel = state.model;

  // Filter to RECENT, chat-completion-capable models. Exclude non-chat or
  // legacy / specialty endpoints (mini/nano variants, image, audio, search,
  // fine-tunes, embeddings, etc.). Also drop anything older than ~14 months
  // based on the `created` timestamp returned by /v1/models.
  const EXCLUDE = /mini|nano|instruct|whisper|tts|dall-?e|embed|moderat|babbage|davinci|realtime|audio|search|preview|transcribe|image|tools|computer-use|\bft\b/i;
  const RECENCY_CUTOFF_DAYS = 420;
  const cutoffEpoch = Math.floor(Date.now() / 1000) - RECENCY_CUTOFF_DAYS * 86400;

  let models = [];

  if (state.apiKey) {
    try {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { "Authorization": `Bearer ${state.apiKey}` },
      });
      if (res.ok) {
        const json = await res.json();
        models = (json.data || [])
          // Keep chat-style families only (gpt-* and o-series reasoning models).
          .filter(m => /^(gpt-|o\d)/i.test(m.id) && !EXCLUDE.test(m.id))
          // Drop dated snapshots older than the recency cutoff. Models without
          // a `created` field are kept (we can't judge them).
          .filter(m => !m.created || m.created >= cutoffEpoch)
          // Sort newest first by `created`, then by descending version tokens.
          .sort((a, b) => {
            if ((b.created || 0) !== (a.created || 0)) return (b.created || 0) - (a.created || 0);
            const ver = s => s.replace(/[^0-9.]/g, " ").trim().split(/\s+/).map(Number);
            const av = ver(a.id), bv = ver(b.id);
            for (let i = 0; i < Math.max(av.length, bv.length); i++) {
              const d = (bv[i] || 0) - (av[i] || 0);
              if (d !== 0) return d;
            }
            return b.id.localeCompare(a.id);
          })
          .map(m => m.id);
      }
    } catch (_) { /* fall through to fallback */ }
  }

  if (!models.length) models = FALLBACK_MODELS.slice();

  sel.innerHTML = "";
  models.forEach((id, idx) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    if (id === savedModel || (!models.includes(savedModel) && idx === 0)) {
      opt.selected = true;
      state.model = id;
    }
    sel.appendChild(opt);
  });

  // If saved model still present in list, re-select it.
  if (models.includes(savedModel)) sel.value = savedModel;
}

function loadApiKey() {
  state.apiKey = localStorage.getItem(KEY_STORAGE) || "";
  state.model = localStorage.getItem(MODEL_STORAGE) || "gpt-5.5";
  const input = document.getElementById("apiKeyInput");
  const status = document.getElementById("keyStatus");
  if (state.apiKey) {
    input.value = state.apiKey;
    status.textContent = "saved";
    status.className = "text-[11px] text-emerald-600";
  }
  loadModels();
}

function saveApiKey() {
  const v = document.getElementById("apiKeyInput").value.trim();
  state.apiKey = v;
  localStorage.setItem(KEY_STORAGE, v);
  const status = document.getElementById("keyStatus");
  status.textContent = v ? "saved" : "cleared";
  status.className = `text-[11px] ${v ? "text-emerald-600" : "text-slate-500"}`;
  // Refresh model list now that we have (or lost) a key.
  loadModels();
}


/* =================== 3. UPLOADS + FORMAT AUTO-DETECT =================== */

function setFormatBanner(kind, message) {
  const el = document.getElementById("formatBanner");
  if (!el) return;
  el.classList.remove("hidden", "bg-emerald-50", "text-emerald-800", "border-emerald-200",
                                  "bg-amber-50", "text-amber-800", "border-amber-200",
                                  "bg-rose-50", "text-rose-800", "border-rose-200", "border");
  if (!message) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.classList.add("border");
  if (kind === "ok")    el.classList.add("bg-emerald-50", "text-emerald-800", "border-emerald-200");
  if (kind === "warn")  el.classList.add("bg-amber-50",   "text-amber-800",   "border-amber-200");
  if (kind === "error") el.classList.add("bg-rose-50",    "text-rose-800",    "border-rose-200");
  el.innerHTML = message;
}

function setCtgovRunHint(message) {
  const el = document.getElementById("ctgovRunHint");
  if (!el) return;
  if (!message) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = message;
}

// Detect the source format from a sample row + filename.
function detectFormat(filename, sampleRow) {
  const ext = (filename || "").toLowerCase().split(".").pop();
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return "dutch";
  const r = sampleRow || {};
  // ClinicalTrials.gov API v2 study record (or top-level wrapper unwrapped already).
  if (r.protocolSection && (r.protocolSection.identificationModule || r.protocolSection.eligibilityModule)) return "ctgov";
  if ("_id" in r || (r.metadata && ("inclusion_criteria" in r.metadata || "brief_title" in r.metadata))) return "trialgpt";
  if ("trial_id" in r && ("criteria" in r || "care_path" in r)) return "orgjson";
  return "trialgpt";
}

function bindManualUploads() {
  const newIn = document.getElementById("newFileInput");
  newIn.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setCtgovRunHint("");
    state.newFile = f;
    document.getElementById("newFileName").textContent = `${f.name} (${formatBytes(f.size)})`;
    await previewAndDetectFormat(f);
  });

  const exIn = document.getElementById("existingFileInput");
  exIn.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setCtgovRunHint("");
    document.getElementById("existingFileName").textContent = `${f.name} (${formatBytes(f.size)})`;
    try {
      const txt = await f.text();
      const parsed = JSON.parse(txt);
      // Accept both the canonical TrialSchema v1 wire format and bare arrays
      // / earlier internal-shape exports (developer drops). v1 envelopes are
      // converted back to the internal model so the matcher / UI keep working.
      let trials;
      if (parsed && parsed.format === TS_V1.FORMAT) {
        trials = fromV1Envelope(parsed).trials;
      } else {
        trials = Array.isArray(parsed) ? parsed : (parsed.trials || []);
      }
      state.existingExport = { trials };
      state.existingById = {};
      for (const t of trials) {
        if (t && t.trial_id) state.existingById[t.trial_id] = t;
      }
      document.getElementById("existingStats").textContent =
        `Loaded ${trials.length} prior trials — these will be reused verbatim if their IDs reappear.`;
    } catch (err) {
      document.getElementById("existingStats").textContent = `Error parsing JSON: ${err.message}`;
    }
  });

  // CT.gov quick-fetch — power-user shortcut. Pulls one or more studies via the
  // public CT.gov v2 API and stages them as if the user had uploaded a JSON file.
  const ctgovBtn   = document.getElementById("ctgovFetchBtn");
  const ctgovInput = document.getElementById("ctgovNctInput");
  if (ctgovBtn && ctgovInput) {
    const setStatus = (kind, html) => {
      const el = document.getElementById("ctgovFetchStatus");
      if (!el) return;
      el.classList.remove("hidden", "bg-emerald-50", "text-emerald-800", "border", "border-emerald-200",
                                  "bg-amber-50",   "text-amber-800",   "border-amber-200",
                                  "bg-rose-50",    "text-rose-800",    "border-rose-200");
      if (kind === "ok")    el.classList.add("bg-emerald-50", "text-emerald-800", "border", "border-emerald-200");
      if (kind === "warn")  el.classList.add("bg-amber-50",   "text-amber-800",   "border", "border-amber-200");
      if (kind === "error") el.classList.add("bg-rose-50",    "text-rose-800",    "border", "border-rose-200");
      el.innerHTML = html;
    };
    const fillCtgovInput = (value) => {
      ctgovInput.value = value;
      ctgovInput.focus();
      ctgovInput.setSelectionRange(ctgovInput.value.length, ctgovInput.value.length);
      setCtgovRunHint("");
      setStatus("warn", `Example loaded into the field. Click <strong>Load</strong> when ready.`);
    };
    const trigger = async () => {
      const raw = (ctgovInput.value || "").trim();
      if (!raw) { setCtgovRunHint(""); setStatus("warn", "Enter an NCT id, e.g. <code>NCT00995306</code>."); return; }
      const ids = raw.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
      const bad = ids.filter(s => !/^NCT\d{8}$/.test(s));
      if (bad.length) { setCtgovRunHint(""); setStatus("error", `Not valid NCT id(s): <code>${bad.join(", ")}</code>`); return; }
      ctgovBtn.disabled = true;
      const prevLabel = ctgovBtn.textContent;
      ctgovBtn.textContent = "Loading…";
      setCtgovRunHint("");
      setStatus("ok", `Fetching ${ids.length} stud${ids.length === 1 ? "y" : "ies"} from ClinicalTrials.gov…`);
      try {
        const studies = [];
        for (const id of ids) {
          const url = `https://clinicaltrials.gov/api/v2/studies/${id}?format=json`;
          const r = await fetch(url, { headers: { "Accept": "application/json" } });
          if (!r.ok) throw new Error(`${id}: HTTP ${r.status}`);
          const j = await r.json();
          studies.push(j);
        }
        const blob = new Blob([JSON.stringify({ studies }, null, 2)], { type: "application/json" });
        const filename = ids.length === 1 ? `${ids[0]}.json` : `ctgov-${ids.length}-studies.json`;
        const file = new File([blob], filename, { type: "application/json" });
        state.newFile = file;
        document.getElementById("newFileName").textContent = `${file.name} (${formatBytes(file.size)})`;
        await previewAndDetectFormat(file);
        setStatus("ok", `Loaded ${ids.length} stud${ids.length === 1 ? "y" : "ies"} from ClinicalTrials.gov.`);
        setCtgovRunHint(`CT.gov source ready: <strong>${ids.join(", ")}</strong>. Use <strong>Run Structured Extraction</strong> above to convert it into TrialSchema.`);
      } catch (err) {
        setCtgovRunHint("");
        setStatus("error", `Fetch failed: ${err.message}`);
      } finally {
        ctgovBtn.disabled = false;
        ctgovBtn.textContent = prevLabel;
      }
    };
    ctgovBtn.addEventListener("click", trigger);
    ctgovInput.addEventListener("keydown", (e) => { if (e.key === "Enter") trigger(); });
    document.querySelectorAll(".ctgov-example").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.dataset.ncts || btn.dataset.nct || "";
        fillCtgovInput(value);
      });
    });
  }
}

// Read the first row to detect format and surface any obvious problems.
async function previewAndDetectFormat(f) {
  const ext = f.name.toLowerCase().split(".").pop();
  try {
    if (ext === "xlsx" || ext === "xls") {
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
      if (!json.length) { setFormatBanner("warn", "Excel sheet appears empty."); return; }
      state.format = "dutch";
      const headers = Object.keys(json[0]);
      const expected = ["Naam studie", "inclusion_criteria", "exclusion_criteria"];
      const missing = expected.filter(h => !headers.includes(h));
      if (missing.length) {
        setFormatBanner("warn", `Detected <strong>Excel/CSV</strong> with ${json.length} rows, but missing columns: <code>${missing.join(", ")}</code>. Use the template for the expected layout.`);
      } else {
        setFormatBanner("ok", `Detected <strong>Excel</strong> &middot; ${json.length} trial rows.`);
      }
      return;
    }
    if (ext === "csv") {
      const text = await f.text();
      const wb = XLSX.read(text, { type: "string" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
      state.format = "dutch";
      setFormatBanner("ok", `Detected <strong>CSV</strong> &middot; ${json.length} rows.`);
      return;
    }
    if (ext === "jsonl") {
      const text = await f.text();
      const lines = text.split(/\r?\n/).filter(Boolean);
      let sample = null;
      try { sample = JSON.parse(lines[0]); } catch (e) {
        setFormatBanner("error", `Invalid JSONL on line 1: ${e.message}`); return;
      }
      state.format = detectFormat(f.name, sample);
      setFormatBanner("ok", `Detected <strong>${state.format === "trialgpt" ? "TrialGPT JSONL" : state.format === "ctgov" ? "ClinicalTrials.gov v2 JSONL" : "Org-specific JSONL"}</strong> &middot; ${lines.length} rows.`);
      return;
    }
    if (ext === "json") {
      const text = await f.text();
      let parsed;
      try { parsed = JSON.parse(text); }
      catch (e) { setFormatBanner("error", `Invalid JSON: ${e.message}`); return; }
      // Unwrap CT.gov v2 envelopes: { studies: [...] } or { studies: [{ ... }] } or a single study.
      let arr;
      if (Array.isArray(parsed)) arr = parsed;
      else if (Array.isArray(parsed.studies)) arr = parsed.studies;
      else if (parsed.protocolSection) arr = [parsed];
      else arr = parsed.trials || parsed.data || [];
      if (!arr.length) { setFormatBanner("warn", "No trial rows found in JSON."); return; }
      state.format = detectFormat(f.name, arr[0]);
      const label = state.format === "trialgpt" ? "TrialGPT JSON"
                  : state.format === "ctgov"    ? "ClinicalTrials.gov v2 JSON"
                  :                                "Org-specific JSON";
      setFormatBanner("ok", `Detected <strong>${label}</strong> &middot; ${arr.length} rows.`);
      return;
    }
    setFormatBanner("error", `Unsupported file type: .${ext}`);
  } catch (err) {
    setFormatBanner("error", `Could not read file: ${err.message}`);
  }
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024*1024) return (n/1024).toFixed(1) + " KB";
  return (n/1024/1024).toFixed(2) + " MB";
}

/* =========================== TEMPLATES =========================== */

const TEMPLATE_HEADERS = [
  "Naam studie", "Status", "Tumorgroep", "CTC", "Type studie",
  "Indicatie", "inclusion_criteria", "exclusion_criteria",
];
const TEMPLATE_EXAMPLE_ROW = {
  "Naam studie": "EXAMPLE-01 – Replace this row with your trial",
  "Status": "Recruiting",
  "Tumorgroep": "Borstkanker",
  "CTC": "",
  "Type studie": "Interventie",
  "Indicatie": "Locally advanced disease",
  "inclusion_criteria": "Histologically confirmed disease\nAge ≥ 18 years\nECOG 0-2",
  "exclusion_criteria": "Distant metastases\nPregnancy or lactation",
};

function downloadTemplate(kind) {
  if (kind === "xlsx" || kind === "csv") {
    const ws = XLSX.utils.json_to_sheet([TEMPLATE_EXAMPLE_ROW], { header: TEMPLATE_HEADERS });
    if (kind === "xlsx") {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Trials");
      XLSX.writeFile(wb, "trialschema_template.xlsx");
    } else {
      const csv = XLSX.utils.sheet_to_csv(ws);
      triggerDownload(csv, "trialschema_template.csv", "text/csv");
    }
    return;
  }
  if (kind === "jsonl") {
    const example = {
      _id: "NCT00000000",
      title: "EXAMPLE – Replace this row with your trial",
      text: "Summary: Brief summary text here.\nInclusion criteria:\n- Rule A\n- Rule B\nExclusion criteria:\n- Rule C",
      metadata: {
        brief_title: "Example trial",
        phase: "Phase 2",
        drugs: ["DrugX"],
        diseases: ["Disease Y"],
        inclusion_criteria: "Histologically confirmed disease\nAge ≥ 18 years",
        exclusion_criteria: "Pregnancy or lactation",
      },
    };
    triggerDownload(JSON.stringify(example) + "\n", "trialschema_template.jsonl", "application/x-ndjson");
  }
}

function triggerDownload(content, name, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}


/* ============================ 4. SOURCE PARSERS ============================ */

// Read raw rows from the manually uploaded source file.
async function gatherRawRows() {
  const rows = [];
  if (!state.newFile) return rows;
  const f = state.newFile;
  const ext = f.name.toLowerCase().split(".").pop();
  if (ext === "xlsx" || ext === "xls") {
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
    json.forEach(r => rows.push({ __raw: r, __sourceFormat: "dutch" }));
  } else if (ext === "csv") {
    const text = await f.text();
    const wb = XLSX.read(text, { type: "string" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
    json.forEach(r => rows.push({ __raw: r, __sourceFormat: "dutch" }));
  } else {
    const text = await f.text();
    rows.push(...parseTextByExt(f.name, text));
  }
  return rows;
}

function parseTextByExt(name, text) {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "jsonl") {
    return text.split(/\r?\n/).filter(Boolean).map((line, i) => {
      try { return wrapRaw(JSON.parse(line)); }
      catch { return { __raw: { __parseError: `line ${i+1}` }, __sourceFormat: state.format }; }
    });
  }
  if (ext === "json") {
    try {
      const j = JSON.parse(text);
      let arr;
      if (Array.isArray(j)) arr = j;
      else if (Array.isArray(j.studies)) arr = j.studies;
      else if (j.protocolSection) arr = [j];
      else arr = j.trials || j.data || [];
      return arr.map(wrapRaw);
    } catch { return []; }
  }
  if (ext === "csv") {
    const wb = XLSX.read(text, { type: "string" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval: "" })
      .map(r => ({ __raw: r, __sourceFormat: "dutch" }));
  }
  return [];
}

function wrapRaw(obj) {
  return { __raw: obj, __sourceFormat: state.format };
}

// Pull the "best guess" trial id and brief title for display before LLM runs.
function previewIdAndTitle(raw) {
  if (state.format === "dutch") {
    const r = raw.__raw || {};
    return {
      id: r["StudieID"] || r["Study ID"] || r["NCT"] || r["Naam studie"] || cryptoSlug(JSON.stringify(r).slice(0, 80)),
      title: r["Naam studie"] || r["Title"] || "(Dutch trial)",
      meta: [r["Tumorgroep"], r["Indicatie"], r["Status"]].filter(Boolean).join(" • "),
    };
  }
  if (state.format === "ctgov" || raw.__sourceFormat === "ctgov") {
    const ps = raw.__raw?.protocolSection || {};
    const idm = ps.identificationModule || {};
    const sm  = ps.statusModule || {};
    const dm  = ps.designModule || {};
    const cm  = ps.conditionsModule || {};
    return {
      id: idm.nctId || cryptoSlug(JSON.stringify(raw.__raw).slice(0, 80)),
      title: idm.briefTitle || idm.officialTitle || "(CT.gov trial)",
      meta: [
        (dm.phases || [])[0],
        (cm.conditions || [])[0],
        sm.overallStatus,
      ].filter(Boolean).join(" • "),
    };
  }
  const r = raw.__raw || {};
  const m = r.metadata || {};
  return {
    id: r._id || r.trial_id || r.NCTId || cryptoSlug(JSON.stringify(r).slice(0, 80)),
    title: r.title || m.brief_title || "(Untitled trial)",
    meta: [m.phase, (m.diseases_list || m.diseases || []).join?.(", "), m.enrollment].filter(Boolean).join(" • "),
  };
}

function cryptoSlug(s) {
  let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return "TS-" + Math.abs(h).toString(36).toUpperCase();
}


/* ============================== 5. DELTA DIFF ============================== */

// Decide for each raw row whether to reuse existing trial verbatim or call LLM.
function classifyRows(rawRows) {
  return rawRows.map((row, i) => {
    const { id, title, meta } = previewIdAndTitle(row);
    const reused = state.existingById[id];
    return {
      idx: i,
      preview: { id, title, meta },
      raw: row,
      status: reused ? "reused" : "pending",
      result: reused || null,
      error: null,
    };
  });
}


/* ============================ 6. OPENAI REQUEST ============================ */

const SYSTEM_PROMPT = `You are TrialSchema-Extractor, a clinical-trial structuring engine.
You receive ONE raw clinical trial row — from ANY field of medicine (oncology,
cardiology, neurology, endocrinology, infectious disease, rare disease, …) —
and return a SINGLE JSON object that strictly matches the TrialSchema execution
model. You must obey ALL of the following rules:

RULE 1 — CATEGORY-SPECIFIC DOCUMENT ROUTING (universal medical domains).
Map each criterion to clinically appropriate document domains. Never produce blind
checklists. Use only these document IDs from the hierarchy:
  intake_layer:       "intake_notes", "referral_letters"
  decision_layer:     "mdo_notes"           (multidisciplinary / specialty board notes)
  diagnostic_core:    "pathology", "imaging_radiology", "treatment_history"
  eligibility_layer:  "molecular_genomic", "core_lab"
  fallback:           "unknown"
Routing guidance (apply across ALL medical fields):
  - intake_notes        → administrative rules, demographics (age, sex/gender), general medical history.
  - referral_letters    → external clinical history validation from another provider.
  - mdo_notes           → high-level multidisciplinary team decisions, consensus reviews, overall therapeutic strategy
                          (MDO / MDT, tumor boards, surgical boards, heart team, transplant board, neuro board, …).
  - pathology           → microscopic properties, tissue biomarkers, cellular pathology, biopsies, histology, cytology.
  - imaging_radiology   → structural lesions, size tracking, radiology (X-ray, CT, MRI, PET, US) AND functional testing
                          (EKG/ECG, EEG, echocardiography, spirometry, angiography). Despite the "radiology" id,
                          this domain covers any imaging or functional diagnostic modality.
  - treatment_history   → historical systemic therapies, prior medication lines, washouts, surgical interventions.
  - molecular_genomic   → genetic sequencing, molecular profiling, liquid biopsy, gene mutations.
  - core_lab            → standard blood/urine, metabolic panels, cell counts (HbA1c, creatinine, potassium,
                          LFTs, GFR, lipids, INR, glucose, electrolytes, …).
  - unknown             → fallback ONLY when document domain cannot be determined.
Populate routing.primary_docs with at least 3 best-fit IDs (these are the
required-checked routes) and routing.fallback_docs with 0-3 optional secondaries.
A lab criterion must NEVER route to imaging_radiology, and vice versa.

RULE 2 — CRITERIA EXPLICIT ENRICHMENT (DOWNSTREAM AI OPTIMIZATION).
For any criterion containing a numeric/quantitative comparison (e.g. "HbA1c >= 7.0 %",
"LVEF < 40 %", "intact-PTH <= 240 pg/mL", "age > 15 years", "GFR >= 50 ml/min",
"WBC >= 3.0", "ECOG 0-2", "systolic BP >= 140 mmHg"), set:
  evaluation_type: "quantitative"
  structured_target: { metric, standard_code, operator, value, unit }
where:
  - metric: the exact parameter name as written (e.g. "HbA1c", "LVEF", "intact-PTH", "age", "GFR", "ECOG").
  - standard_code: BEST-EFFORT ontology code, prefixed by terminology, e.g.
                     LOINC:4548-4   (HbA1c), LOINC:2160-0 (creatinine), LOINC:2164-2 (creatinine clearance),
                     LOINC:30525-0  (age),   LOINC:8480-6  (systolic BP), LOINC:33747-0 (Karnofsky),
                     SNOMED:271649006 (systolic BP), SNOMED:254837009 (breast cancer),
                     RXNORM:1601480 (palbociclib), HGNC:3430 (ERBB2/HER2),
                     ICD10:C50.9 (breast cancer NOS).
                   Set "" when not confident. End users do NOT verify these codes by hand;
                   the downstream matcher treats them as hints, not contracts.
  - operator: one of  "<", "<=", ">", ">=", "=", "!=", "between".
  - value: numeric. For "between" use the lower bound and add upper_value.
  - unit: explicit unit string aligned to UCUM where possible (e.g. "%", "pg/mL",
                   "years", "mL/min", "mmHg", "mg/dL"). Use "" when unitless.
For purely categorical / boolean criteria (consent, pregnancy, prior radiotherapy yes/no,
NYHA class assignment, presence-of-condition flags), set evaluation_type: "boolean" and
OMIT structured_target (or set it to null).
The downstream matching agent must be able to execute mathematical evaluation
WITHOUT re-reading the original_text.

RULE 3 — CROSS-LINGUAL TRANSLATION & STANDARDIZATION.
If the input is Dutch (e.g. "Tumorgroep: Borstkanker", "Indicatie: Gemetastaseerd",
"Status: Werving") or any other non-English language, interpret it natively but translate
ALL output strings (criteria text, diseases, phase, status, descriptions) cleanly into
English. Preserve clinical precision.

RULE 4 — OPERATIONAL STATUS & ISO DATE NORMALIZATION.
metadata.recruitment_status MUST be exactly one of:
  "Not yet recruiting", "Recruiting", "Active, not recruiting", "Completed".
All lifecycle dates must be "YYYY-MM-DD" strings (or "" if unknown).

RULE 5 — CRITERION CATEGORY (CLOSED VOCABULARY).
The "category" field on every criterion MUST be exactly ONE of these lower-case tokens:
  "intake_notes", "referral_letters", "mdo_notes", "pathology",
  "imaging_radiology", "treatment_history", "molecular_genomic",
  "core_lab", "other"
Pick the SAME id as the criterion's primary document domain. Use "other" ONLY when the
criterion truly does not fit any domain (e.g. consent, willingness, contraception
requirements, study-logistics rules). Demographics (age, gender, weight, BMI),
ICD-10 diagnoses, and admin rules ALWAYS go in "intake_notes" — never "other".
Standard chemistries (CBC, LFTs, GFR, electrolytes) ALWAYS go in "core_lab".

RULE 6 — DAG FUNNEL PRIORITY (CHEAPEST → MOST COMPLEX).
Set "priority_level" so the downstream pipeline can short-circuit on the cheapest
deterministic checks first. Use this funnel order:
  1 — Structured EHR knock-outs (NO LLM needed downstream): demographics, gender,
        ICD-10 diagnosis flags, structured lab values. Categories: "intake_notes",
        "core_lab", "referral_letters".
  2 — High-yield unstructured tier (single-doc LLM extraction): biomarkers,
        staging, histology, molecular profile, organ-specific imaging findings.
        Categories: "pathology", "molecular_genomic", "imaging_radiology".
  3 — Complex timeline / cross-document tier: prior therapies, washout windows,
        line-of-therapy ordering, multidisciplinary decisions. Categories:
        "treatment_history", "mdo_notes".
  4 — "other" / soft criteria (consent, willingness, logistics).
  5 — Reserved for unranked or trivially redundant items.
The numeric priority MUST equal the tier number above; do not invent values.

OUTPUT SHAPE — return EXACTLY this JSON structure (no extra keys, no commentary):
{
  "trial_id": "string",
  "metadata": {
    "brief_title": "string",
    "phase": "string",
    "drugs": ["string"],
    "diseases": ["string"],
    "enrollment_target": 0,
    "recruitment_status": "Recruiting",
    "lifecycle_dates": {
      "start_date": "YYYY-MM-DD",
      "primary_completion_date": "YYYY-MM-DD",
      "actual_close_date": "YYYY-MM-DD"
    }
  },
  "care_path": {
    "phases": [
      { "phase_name": "string", "description": "string", "duration": "string", "key_activities": ["string"] }
    ]
  },
  "criteria": [
    {
      "criterion_id": "INC-01",
      "type": "inclusion",
      "original_text": "string",
      "category": "intake_notes | referral_letters | mdo_notes | pathology | imaging_radiology | treatment_history | molecular_genomic | core_lab | other",
      "priority_level": 1,
      "status": "active",
      "routing": { "primary_docs": ["intake_notes"], "fallback_docs": [] },
      "evaluation_type": "boolean",
      "structured_target": {
        "metric": "string (e.g., HbA1c or age)",
        "standard_code": "string (Optional: LOINC, SNOMED-CT, or ICD-10 code; \"\" if unsure)",
        "operator": "string (one of <, <=, >, >=, =, !=, between)",
        "value": 0,
        "unit": "string (e.g., % or years)"
      }
    }
  ]
}
Use "INC-01"... for inclusion criteria and "EXC-01"... for exclusion.
status defaults to "active". priority_level is the DAG funnel tier (Rule 6): 1 = structured
EHR knock-out, 2 = unstructured high-yield, 3 = timeline / cross-doc, 4 = other / soft, 5 = unranked.
care_path is OPTIONAL. Emit it ONLY when the trial implies a recognised standard clinical pathway
(e.g. oncology / radiation-oncology, structured chronic-disease management like heart-failure or
diabetes pathways, transplant pathways). When you do emit one, populate at least one phase. When the
trial does not map to a clear pathway (early-phase healthy-volunteer studies, single-encounter
device studies, etc.), set care_path to null and move on.
Return ONLY the JSON object — no markdown fences, no explanations.`;

// Build the per-trial user prompt depending on the source format.
function buildUserPrompt(raw) {
  const sf = raw.__sourceFormat;
  if (sf === "dutch") {
    return [
      "SOURCE FORMAT: Dutch Excel/CSV row. Translate output to English.",
      "Raw row:",
      "```json",
      JSON.stringify(raw.__raw, null, 2),
      "```",
    ].join("\n");
  }
  if (sf === "ctgov") {
    return buildCtgovPrompt(raw.__raw);
  }
  if (sf === "orgjson") {
    return [
      "SOURCE FORMAT: Org-specific JSON record. Map fields conservatively.",
      "Raw record:",
      "```json",
      JSON.stringify(raw.__raw, null, 2),
      "```",
    ].join("\n");
  }
  // Default: TrialGPT
  return [
    "SOURCE FORMAT: TrialGPT row.",
    "Use _id as trial_id. Parse the `text` field's Inclusion/Exclusion sections plus",
    "`metadata.inclusion_criteria` / `metadata.exclusion_criteria` when present.",
    "Raw record:",
    "```json",
    JSON.stringify(raw.__raw, null, 2),
    "```",
  ].join("\n");
}

// ----- CT.gov v2 helpers -----------------------------------------------------
// Map CT.gov phase enum (e.g. "PHASE3", "EARLY_PHASE1") to TrialSchema phase strings.
const CTGOV_PHASE_MAP = {
  "EARLY_PHASE1": "Early Phase 1",
  "PHASE1":      "Phase 1",
  "PHASE1_2":    "Phase 1/Phase 2",
  "PHASE2":      "Phase 2",
  "PHASE2_3":    "Phase 2/Phase 3",
  "PHASE3":      "Phase 3",
  "PHASE4":      "Phase 4",
  "NA":          "N/A",
};
// Map CT.gov overallStatus to TrialSchema lifecycle status (RULE 4 enum).
const CTGOV_STATUS_MAP = {
  "NOT_YET_RECRUITING":     "not_yet_recruiting",
  "RECRUITING":             "recruiting",
  "ENROLLING_BY_INVITATION":"recruiting",
  "ACTIVE_NOT_RECRUITING":  "active_not_recruiting",
  "COMPLETED":              "completed",
  "SUSPENDED":              "suspended",
  "TERMINATED":             "terminated",
  "WITHDRAWN":              "withdrawn",
  "UNKNOWN":                "unknown",
};

function buildCtgovPrompt(study) {
  const ps  = study?.protocolSection || {};
  const idm = ps.identificationModule || {};
  const sm  = ps.statusModule || {};
  const dm  = ps.designModule || {};
  const cm  = ps.conditionsModule || {};
  const aim = ps.armsInterventionsModule || {};
  const elm = ps.eligibilityModule || {};
  const spm = ps.sponsorCollaboratorsModule || {};

  const phaseRaw = (dm.phases || [])[0];
  const phase    = phaseRaw ? (CTGOV_PHASE_MAP[phaseRaw] || phaseRaw) : "";
  const status   = CTGOV_STATUS_MAP[sm.overallStatus] || "unknown";

  const interventions = (aim.interventions || []).map(iv => ({
    type: (iv.type || "").toLowerCase(), // drug | device | procedure | behavioral | ...
    name: iv.name,
  }));

  const preExtracted = {
    trial_id: idm.nctId || "",
    metadata: {
      brief_title:        idm.briefTitle || "",
      official_title:     idm.officialTitle || "",
      phase,
      diseases:           cm.conditions || [],
      drugs:              interventions.filter(i => i.type === "drug").map(i => i.name),
      interventions,
      enrollment_target:  dm.enrollmentInfo?.count ?? null,
      sponsor:            spm.leadSponsor?.name || "",
      lifecycle: {
        status,
        start_date:               sm.startDateStruct?.date || "",
        primary_completion_date:  sm.primaryCompletionDateStruct?.date || "",
        completion_date:          sm.completionDateStruct?.date || "",
      },
      eligibility_demographics: {
        sex:               elm.sex || "ALL",
        minimum_age:       elm.minimumAge || "",
        maximum_age:       elm.maximumAge || "",
        healthy_volunteers: elm.healthyVolunteers === true,
      },
    },
  };

  const eligibilityText = elm.eligibilityCriteria || "";

  return [
    "SOURCE FORMAT: ClinicalTrials.gov API v2 study record.",
    "",
    "DETERMINISTIC PRE-EXTRACTION (already done from `protocolSection`).",
    "Use these values verbatim for trial_id and metadata. DO NOT rewrite, translate, or re-derive them.",
    "Your job is to produce the structured `criteria` array (and `care_path`) by parsing the eligibility text.",
    "",
    "Pre-extracted fields:",
    "```json",
    JSON.stringify(preExtracted, null, 2),
    "```",
    "",
    "Free-text eligibility criteria (parse Inclusion/Exclusion sections; emit one Criterion per bullet):",
    "```",
    eligibilityText,
    "```",
    "",
    "Additionally encode the demographic constraints from `eligibility_demographics` as inclusion criteria:",
    "  - `minimum_age` / `maximum_age` → a single `demographics`/Age criterion with a range/comparison constraint.",
    "  - `sex` (when not \"ALL\") → a `demographics`/Sex criterion.",
    "  - `healthy_volunteers === false` → do NOT add a separate criterion; this is implicit.",
  ].join("\n");
}
// ----- /CT.gov v2 helpers ----------------------------------------------------

async function callOpenAI(raw) {
  if (!state.apiKey) throw new Error("Missing OpenAI API key. Save it in the header.");
  const body = {
    model: state.model,
    // dangerouslyAllowBrowser is an SDK-level flag; the raw fetch endpoint accepts
    // browser calls directly. We add it as a header hint for clarity.
    // Note: temperature is intentionally omitted — several newer OpenAI models
    // (gpt-5.x and reasoning variants) only accept the default value.
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(raw) },
    ],
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${state.apiKey}`,
      "X-DangerouslyAllowBrowser": "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errTxt = await res.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${res.status}: ${errTxt.slice(0, 240)}`);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || "{}";
  let parsed;
  try { parsed = JSON.parse(content); }
  catch (e) { throw new Error("Model did not return valid JSON: " + e.message); }
  return sanitizeTrial(parsed);
}

// Normalize/repair LLM output so the rest of the app can rely on shape.
function sanitizeTrial(t) {
  if (!t || typeof t !== "object") t = {};
  t.trial_id = String(t.trial_id || cryptoSlug(JSON.stringify(t).slice(0, 64)));
  t.metadata = t.metadata || {};
  const m = t.metadata;
  m.brief_title = String(m.brief_title || "");
  m.phase = String(m.phase || "");
  m.drugs = Array.isArray(m.drugs) ? m.drugs.map(String) : [];
  m.diseases = Array.isArray(m.diseases) ? m.diseases.map(String) : [];
  m.enrollment_target = Number.isFinite(+m.enrollment_target) ? +m.enrollment_target : 0;
  m.recruitment_status = RECRUITMENT_STATES.includes(m.recruitment_status)
    ? m.recruitment_status : "Recruiting";
  m.lifecycle_dates = m.lifecycle_dates || {};
  ["start_date", "primary_completion_date", "actual_close_date"].forEach(k => {
    m.lifecycle_dates[k] = isoDate(m.lifecycle_dates[k]);
  });

  t.care_path = t.care_path || { phases: [] };
  if (!Array.isArray(t.care_path.phases)) t.care_path.phases = [];
  t.care_path.phases = t.care_path.phases.map(p => ({
    phase_name: String(p?.phase_name || ""),
    description: String(p?.description || ""),
    duration: String(p?.duration || ""),
    key_activities: Array.isArray(p?.key_activities) ? p.key_activities.map(String) : [],
  }));

  if (!Array.isArray(t.criteria)) t.criteria = [];
  t.criteria = t.criteria.map((c, i) => sanitizeCriterion(c, i));
  // DAG funnel order: cheapest deterministic checks first. Sort by the LLM's
  // initial tier hint, then put inclusions before exclusions.
  t.criteria.sort((a, b) => {
    if (a.priority_level !== b.priority_level) return a.priority_level - b.priority_level;
    if (a.type !== b.type) return a.type === "inclusion" ? -1 : 1;
    return 0;
  });
  // Renumber priority_level as a simple 1..N rank so it always matches the
  // visible list position (drag-reorder updates it in lock-step).
  t.criteria.forEach((c, i) => { c.priority_level = i + 1; });
  // Care-path enum assignment (id from state.carePaths). Defaults to "" —
  // will be auto-assigned later by alias matching against diseases / title.
  t.care_path_id = typeof t.care_path_id === "string" ? t.care_path_id : "";
  // Trial-level active flag. Inactive trials are still exported but flagged so
  // the downstream matcher can skip them. Defaults to true.
  t.active = (t.active === false) ? false : true;
  return t;
}

function sanitizeCriterion(c, i) {
  c = c || {};
  const type = c.type === "exclusion" ? "exclusion" : "inclusion";
  const prefix = type === "exclusion" ? "EXC" : "INC";
  // Closed category vocabulary: doc-hierarchy ids (excluding "unknown") + "other".
  const rawCat = String(c.category || "").toLowerCase().trim();
  const category = KNOWN_CATEGORIES.has(rawCat) ? rawCat : "other";
  // Priority is the initial DAG funnel tier (1–5) coming from the LLM. We
  // store it temporarily; sanitizeTrial then re-numbers all criteria as
  // sequential 1..N ranks based on their post-sort position in the list.
  let prio = Number.isFinite(+c.priority_level) ? Math.round(+c.priority_level) : 3;
  if (prio < 1) prio = 1; else if (prio > 5) prio = 5;
  const out = {
    criterion_id: String(c.criterion_id || `${prefix}-${String(i+1).padStart(2,"0")}`),
    type,
    original_text: String(c.original_text || ""),
    category,
    priority_level: prio,
    status: c.status === "inactive" ? "inactive" : "active",
    routing: {
      primary_docs:  Array.isArray(c.routing?.primary_docs)  ? c.routing.primary_docs.filter(d => DOC_BY_ID[d])  : [],
      fallback_docs: Array.isArray(c.routing?.fallback_docs) ? c.routing.fallback_docs.filter(d => DOC_BY_ID[d]) : [],
    },
    evaluation_type: c.evaluation_type === "quantitative" ? "quantitative" : "boolean",
    structured_target: null,
    guidance: typeof c.guidance === "string" ? c.guidance : "",
    // "Other" matrix-cell checkbox: opt-in flag enabling the free-text
    // guidance for criteria whose category is "other". Defaults on when the
    // criterion already carries guidance text, off otherwise.
    other_active: typeof c.other_active === "boolean"
      ? c.other_active
      : !!(typeof c.guidance === "string" && c.guidance.trim()),
  };
  if (out.evaluation_type === "quantitative" && c.structured_target && typeof c.structured_target === "object") {
    const st = c.structured_target;
    out.structured_target = {
      metric: String(st.metric || ""),
      standard_code: String(st.standard_code || ""),
      operator: ["<","<=",">",">=","=","!=","between"].includes(st.operator) ? st.operator : "=",
      value: Number.isFinite(+st.value) ? +st.value : 0,
      unit: String(st.unit || ""),
    };
    if (st.upper_value !== undefined) out.structured_target.upper_value = +st.upper_value;
  }

  // Default-three-primary-docs rule: every criterion ships with a sensible
  // base trio of checked primary documents (intake notes, MDO notes, and a
  // third doc inferred from the criterion's category). Anything the LLM
  // routed beyond that becomes optional fallback.
  const llmPrimary = out.routing.primary_docs.slice();
  const llmFallback = out.routing.fallback_docs.slice();
  const inferred = inferThirdPrimary(out);
  const primarySet = new Set([...DEFAULT_PRIMARY_BASE, inferred, ...llmPrimary]);
  // When the criterion is itself an "other / soft" rule (consent, willingness,
  // logistics…) auto-mark the Other chip as primary so the free-text guidance
  // textarea is surfaced. Same for legacy data that carried `other_active` or
  // existing guidance text.
  const isOther = out.category === "other"
    || c.other_active === true
    || (typeof c.guidance === "string" && c.guidance.trim() !== "");
  if (isOther) primarySet.add("other");
  // "unknown" should never be in the primary trio if we have anything else.
  primarySet.delete("unknown");
  out.routing.primary_docs = Array.from(primarySet).filter(d => DOC_BY_ID[d]);
  // Fallbacks = LLM-suggested + LLM-primary that didn't make the trio,
  // de-duped against primaries.
  const fbSet = new Set([...llmFallback, ...llmPrimary.filter(d => !primarySet.has(d))]);
  out.routing.primary_docs.forEach(d => fbSet.delete(d));
  out.routing.fallback_docs = Array.from(fbSet).filter(d => DOC_BY_ID[d]);
  return out;
}

function isoDate(s) {
  if (!s) return "";
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return "";
}


/* ============================ 7. QUEUE RUNNER ============================ */

async function runQueue() {
  if (state.running) return;
  state.abort = false;

  // 1. Gather raw rows
  setProgress(0, "Reading raw rows...");
  let rawRows = [];
  try { rawRows = await gatherRawRows(); }
  catch (e) { setProgress(0, `Read error: ${e.message}`); return; }

  if (!rawRows.length) {
    setProgress(0, "No rows found. Upload a trial source file in the sidebar.");
    return;
  }

  // Stamp the per-row sourceFormat from the dropdown if not set by parser
  rawRows.forEach(r => { if (!r.__sourceFormat) r.__sourceFormat = state.format; });

  // 2. Cap by maxTrials and classify (delta-diff against existing export)
  rawRows = rawRows.slice(0, state.maxTrials);
  const items = classifyRows(rawRows);
  state.results = items.map(it => it.result);
  state.resultsById = {};
  items.forEach(it => { if (it.result) state.resultsById[it.preview.id] = it.result; });

  renderTrials(items);
  updateStats(items);
  document.getElementById("exportBtn").disabled = false;

  // Manual mode: no API key -> mark all pending as manual and stop here.
  const manualBanner = document.getElementById("manualBanner");
  if (!state.apiKey) {
    items.forEach((it, i) => {
      if (it.status === "pending") {
        it.status = "manual";
        renderRow(it, i);
      }
    });
    if (manualBanner) manualBanner.classList.remove("hidden");
    updateStats(items);
    setProgress(100, "Manual mode — expand a trial to copy its prompt and paste back the JSON response.");
    return;
  } else if (manualBanner) {
    manualBanner.classList.add("hidden");
  }

  // 3. Process pending entries with throttle
  state.running = true;
  document.getElementById("processBtn").disabled = true;
  document.getElementById("stopBtn").classList.remove("hidden");

  const pendingIdxs = items.map((it, i) => it.status === "pending" ? i : -1).filter(i => i >= 0);
  let processed = 0;
  for (const i of pendingIdxs) {
    if (state.abort) break;
    const it = items[i];
    it.status = "processing";
    renderRow(it, i);
    setProgress(
      Math.round((processed) / Math.max(1, pendingIdxs.length) * 100),
      `Processing ${it.preview.id} (${processed+1}/${pendingIdxs.length})...`
    );
    try {
      const result = await callOpenAI(it.raw);
      // Preserve preview ID if model dropped it
      if (!result.trial_id || result.trial_id === "string") result.trial_id = it.preview.id;
      // Preserve any pre-extraction active toggle the user already flipped.
      if (it.userActive === false) result.active = false;
      it.result = result;
      it.status = "done";
      state.results[i] = result;
      state.resultsById[result.trial_id] = result;
      // Auto-assign care path enum if any are defined.
      if (state.carePaths.length) {
        const cpId = inferCarePathId(result);
        if (cpId) result.care_path_id = cpId;
      }
    } catch (e) {
      it.error = e.message;
      it.status = "error";
    }
    processed++;
    renderRow(it, i);
    updateStats(items);
    if (!state.abort && processed < pendingIdxs.length) {
      await sleep(state.throttleMs);
    }
  }

  setProgress(100, state.abort ? "Stopped." : "Pipeline complete.");  state.running = false;
  document.getElementById("processBtn").disabled = false;
  document.getElementById("stopBtn").classList.add("hidden");
  renderCarePathsPanel();
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { state._sleepCancel = null; resolve(); }, ms);
    state._sleepCancel = () => { clearTimeout(t); state._sleepCancel = null; resolve(); };
  });
}


/* =========================== 8. RENDERING / UI =========================== */

function setProgress(pct, label) {
  document.getElementById("progressBar").style.width = `${Math.max(0, Math.min(100, pct))}%`;
  document.getElementById("progressLabel").textContent = label || "";
}

function updateStats(items) {
  const total = items.length;
  const done = items.filter(i => i.status === "done").length;
  const reused = items.filter(i => i.status === "reused").length;
  const err = items.filter(i => i.status === "error").length;
  document.getElementById("statTotal").textContent = total;
  document.getElementById("statDone").textContent = done;
  document.getElementById("statSkip").textContent = reused;
  document.getElementById("statErr").textContent = err;
}

function statusBadge(status) {
  const map = {
    pending:    ["bg-slate-100 text-slate-600", "Pending"],
    processing: ["bg-blue-100 text-blue-700", "Processing"],
    done:       ["bg-emerald-100 text-emerald-700", "Done"],
    reused:     ["bg-amber-100 text-amber-700", "Reused"],
    manual:     ["bg-indigo-100 text-indigo-700", "Manual"],
    error:      ["bg-rose-100 text-rose-700", "Error"],
  };
  const [cls, label] = map[status] || map.pending;
  return `<span class="badge ${cls}">${label}</span>`;
}

const trialItems = []; // mirrors items array for re-rendering

function renderTrials(items) {
  trialItems.length = 0;
  trialItems.push(...items);
  renderCarePathsPanel();
  const list = document.getElementById("trialsList");
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = `<div class="p-8 text-sm text-slate-500 text-center">No trials.</div>`;
    return;
  }
  items.forEach((it, i) => list.appendChild(buildRow(it, i)));
}

function buildRow(it, i) {
  const tpl = document.getElementById("trialRowTpl").content.cloneNode(true);
  const root = tpl.querySelector("details");
  root.dataset.idx = i;
  // Wire the trial-level active toggle (works pre- or post-LLM extraction).
  const toggle = root.querySelector("[data-active-toggle]");
  if (toggle) {
    // Stop the click from bubbling up and toggling the <details> open/close.
    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Initialise active flag on the result if missing; if the trial hasn't
      // been processed yet, we still allow toggling — store the flag on `it`
      // and copy it onto `it.result` once extraction finishes.
      if (it.result) {
        it.result.active = it.result.active === false ? true : false;
      } else {
        it.userActive = it.userActive === false ? true : false;
      }
      updateRow(root, it);
    });
  }
  updateRow(root, it);
  // Lazy-render body only when opened (keeps long lists fast)
  root.addEventListener("toggle", () => {
    if (root.open) renderBody(root.querySelector("[data-body]"), it, i);
  });
  return root;
}

function renderRow(it, i) {
  const list = document.getElementById("trialsList");
  const root = list.querySelector(`details[data-idx="${i}"]`);
  if (!root) return;
  updateRow(root, it);
  if (root.open) renderBody(root.querySelector("[data-body]"), it, i);
}

function updateRow(root, it) {
  // Active toggle visual state. Defaults to active when unknown.
  const toggle = root.querySelector("[data-active-toggle]");
  if (toggle) {
    const active = it.result ? (it.result.active !== false) : (it.userActive !== false);
    toggle.title = active ? "Trial is active — click to deactivate" : "Trial is inactive — click to activate";
    toggle.className = "shrink-0 w-7 h-7 rounded-md border text-[10px] font-bold transition flex items-center justify-center " + (
      active
        ? "bg-emerald-500 text-white border-emerald-500 hover:bg-emerald-600"
        : "bg-white text-slate-300 border-slate-300 hover:border-slate-400"
    );
    toggle.textContent = active ? "ON" : "OFF";
    // Dim the rest of the summary when inactive.
    root.classList.toggle("opacity-60", !active);
  }
  root.querySelector("[data-status]").outerHTML =
    statusBadge(it.status).replace("<span ", `<span data-status `);
  root.querySelector("[data-tid]").textContent = it.preview.id;
  root.querySelector("[data-title]").textContent = it.preview.title;
  const meta = it.error ? `Error: ${it.error}` : (it.preview.meta || "");
  root.querySelector("[data-meta]").textContent = meta;
  // Show #active criteria / total alongside phase count so users can see at a
  // glance how many criteria are still in play after manual deactivations.
  let counts = "";
  if (it.result?.criteria) {
    const total = it.result.criteria.length;
    const act = it.result.criteria.filter(c => c.status === "active").length;
    counts = `${act}/${total} criteria active · ${it.result.care_path?.phases?.length || 0} phases`;
  }
  root.querySelector("[data-counts]").textContent = counts;
}

function renderBody(host, it, i) {
  const t = it.result;

  // Per-trial manual prompt panel (always available, regardless of status).
  const manualPanel = `
    <details class="mb-3 bg-white rounded-xl border border-slate-200 group">
      <summary class="px-4 py-2.5 flex items-center gap-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 rounded-xl">
        <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 text-slate-400 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        No API key? Use any LLM manually
        <span class="ml-auto text-[11px] font-normal text-slate-400">copy prompt → paste JSON</span>
      </summary>
      <div class="px-4 pb-4 pt-1 space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <button data-act="copy-prompt" class="inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg bg-slate-900 text-white px-3 py-1.5 hover:bg-slate-700">
            <svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8" y="4" width="12" height="16" rx="2"/><path d="M16 4V2H6a2 2 0 00-2 2v14h2" stroke-linecap="round"/></svg>
            Copy prompt
          </button>
          <span data-copy-status class="text-[11px] text-emerald-600"></span>
        </div>
        <textarea data-paste class="w-full h-40 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg p-2 ring-focus" placeholder="Paste the JSON response from your LLM here..."></textarea>
        <div class="flex items-center gap-2">
          <button data-act="apply-paste" class="text-xs font-semibold rounded-lg bg-emerald-600 text-white px-3 py-1.5 hover:bg-emerald-500">Apply pasted JSON</button>
          <span data-paste-status class="text-[11px]"></span>
        </div>
      </div>
    </details>
  `;

  if (!t) {
    host.innerHTML = manualPanel + (it.error
      ? `<div class="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3">${escapeHtml(it.error)}</div>`
      : `<div class="text-sm text-slate-500 italic p-3">Not processed yet. Use the manual panel above, or save an API key and run the queue.</div>`);
    bindManualPanel(host, it, i);
    return;
  }

  const m = t.metadata || {};
  const phases = t.care_path?.phases || [];
  const ld = m.lifecycle_dates || {};
  const recOptions = RECRUITMENT_STATES.map(s =>
    `<option value="${escapeHtml(s)}"${m.recruitment_status === s ? " selected" : ""}>${escapeHtml(s)}</option>`
  ).join("");
  host.innerHTML = manualPanel + `
    <div class="grid grid-cols-1 xl:grid-cols-3 gap-4 mt-3">
      <!-- Metadata card (editable) -->
      <div class="bg-white rounded-xl border border-slate-200 p-4" data-meta-card>
        <div class="flex items-center justify-between">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500">Trial Metadata</h3>
          <span class="text-[10px] text-slate-400 italic">Click any field to edit</span>
        </div>
        <input type="text" data-mfield="brief_title" value="${escapeHtml(m.brief_title||"")}" placeholder="Brief title"
          class="mt-2 w-full text-sm font-semibold text-slate-900 bg-transparent border-b border-transparent hover:border-slate-200 focus:border-blue-400 focus:outline-none px-0 py-1"/>
        <div class="mt-2 grid grid-cols-2 gap-y-1.5 gap-x-3 text-[12px]">
          <label class="text-slate-500 self-center">Phase</label>
          <input type="text" data-mfield="phase" value="${escapeHtml(m.phase||"")}" class="meta-input"/>
          <label class="text-slate-500 self-center">Status</label>
          <select data-mfield="recruitment_status" class="meta-input">${recOptions}</select>
          <label class="text-slate-500 self-center">Enrollment</label>
          <input type="number" data-mfield="enrollment_target" value="${m.enrollment_target ?? ""}" class="meta-input"/>
          <label class="text-slate-500 self-center">Drugs</label>
          <input type="text" data-mfield="drugs" data-mlist="1" value="${escapeHtml((m.drugs||[]).join(", "))}" placeholder="comma-separated" class="meta-input"/>
          <label class="text-slate-500 self-center">Diseases</label>
          <input type="text" data-mfield="diseases" data-mlist="1" value="${escapeHtml((m.diseases||[]).join(", "))}" placeholder="comma-separated" class="meta-input"/>
          <label class="text-slate-500 self-center">Care path</label>
          <select data-mfield="care_path_id" data-mtarget="trial" class="meta-input">${carePathOptionsHtml(t.care_path_id || "")}</select>
          <label class="text-slate-500 self-center">Start</label>
          <input type="date" data-mfield="lifecycle_dates.start_date" value="${escapeHtml(ld.start_date||"")}" class="meta-input"/>
          <label class="text-slate-500 self-center">Primary close</label>
          <input type="date" data-mfield="lifecycle_dates.primary_completion_date" value="${escapeHtml(ld.primary_completion_date||"")}" class="meta-input"/>
          <label class="text-slate-500 self-center">Actual close</label>
          <input type="date" data-mfield="lifecycle_dates.actual_close_date" value="${escapeHtml(ld.actual_close_date||"")}" class="meta-input"/>
        </div>
      </div>

      <!-- Care path -->
      <div class="bg-white rounded-xl border border-slate-200 p-4 xl:col-span-2">
        <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500">Care Path</h3>
        <ol class="mt-2 relative border-l border-slate-200 pl-4 space-y-3">
          ${phases.map((p, idx) => `
            <li class="relative">
              <span class="absolute -left-[22px] top-1 w-3 h-3 rounded-full bg-blue-500 ring-4 ring-blue-100"></span>
              <div class="text-sm font-semibold text-slate-900">${idx+1}. ${escapeHtml(p.phase_name)} <span class="text-[11px] font-normal text-slate-500">${escapeHtml(p.duration||"")}</span></div>
              <div class="text-[12px] text-slate-600">${escapeHtml(p.description||"")}</div>
              ${(p.key_activities||[]).length ? `<ul class="mt-1 flex flex-wrap gap-1">${p.key_activities.map(a => `<li class="badge bg-slate-100 text-slate-700 border border-slate-200">${escapeHtml(a)}</li>`).join("")}</ul>` : ""}
            </li>`).join("") || `<li class="text-sm text-slate-500 italic">No care path phases inferred.</li>`}
        </ol>
      </div>
    </div>

    <!-- Criteria workspace -->
    <div class="mt-4 bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div class="flex items-center justify-between px-5 py-3 border-b border-slate-100">
        <div>
          <h3 class="text-sm font-semibold text-slate-900">Criteria</h3>
          <p class="text-[11px] text-slate-500">Numbered 1→N, easiest first. Drag the handle to fine-tune the run order.</p>
        </div>
        <div class="text-[11px] text-slate-500">${(t.criteria||[]).filter(c=>c.type==="inclusion").length} incl. · ${(t.criteria||[]).filter(c=>c.type==="exclusion").length} excl.</div>
      </div>
      <div class="px-3 py-3 space-y-2 bg-slate-50/40" data-criteria></div>
    </div>
  `;

  const critHost = host.querySelector("[data-criteria]");
  (t.criteria || []).forEach((c, ci) => critHost.appendChild(buildCriterionRow(t, c, ci)));
  enableCriterionDrag(critHost, t);
  bindMetadataInputs(host, t);
  bindManualPanel(host, it, i);
}

// Wire up live edits on the editable metadata card.
function bindMetadataInputs(host, trial) {
  trial.metadata = trial.metadata || {};
  host.querySelectorAll("[data-mfield]").forEach(input => {
    input.addEventListener("input", () => {
      const field = input.dataset.mfield;
      let value = input.value;
      if (input.dataset.mlist) {
        value = value.split(",").map(s => s.trim()).filter(Boolean);
      } else if (input.type === "number") {
        value = value === "" ? null : Number(value);
      }
      // Fields targeting the trial root (e.g. care_path_id) rather than
      // trial.metadata.* live alongside the title without dot-notation.
      if (input.dataset.mtarget === "trial") {
        trial[field] = value;
        if (field === "care_path_id") renderCarePathsPanel();
        return;
      }
      const path = field.split(".");
      let target = trial.metadata;
      for (let i = 0; i < path.length - 1; i++) {
        target[path[i]] = target[path[i]] || {};
        target = target[path[i]];
      }
      target[path[path.length - 1]] = value;
    });
  });
}

// Wire up the per-trial manual copy/paste panel.
function bindManualPanel(host, it, i) {
  const userPrompt = buildUserPrompt(it.raw);
  const fullPrompt = `[SYSTEM]\n${SYSTEM_PROMPT}\n\n[USER]\n${userPrompt}`;
  const copyStatus = host.querySelector("[data-copy-status]");
  const flash = (msg) => {
    if (!copyStatus) return;
    copyStatus.textContent = msg;
    setTimeout(() => { copyStatus.textContent = ""; }, 1800);
  };
  const copyText = async (txt, label) => {
    try { await navigator.clipboard.writeText(txt); flash(`${label} copied`); }
    catch { flash("Copy failed — select & copy manually"); }
  };
  host.querySelector('[data-act="copy-prompt"]')?.addEventListener("click", () => copyText(fullPrompt, "Prompt"));

  host.querySelector('[data-act="apply-paste"]')?.addEventListener("click", () => {
    const ta = host.querySelector("[data-paste]");
    const status = host.querySelector("[data-paste-status]");
    let txt = (ta?.value || "").trim();
    if (!txt) { status.textContent = "Nothing to apply."; status.className = "text-[11px] text-rose-600"; return; }
    // Strip ``` fences if user pasted markdown
    txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    try {
      const parsed = JSON.parse(txt);
      const clean = sanitizeTrial(parsed);
      if (!clean.trial_id || clean.trial_id === "string") clean.trial_id = it.preview.id;
      it.result = clean;
      it.status = "done";
      it.error = null;
      state.results[i] = clean;
      state.resultsById[clean.trial_id] = clean;
      status.textContent = "Applied ✓";
      status.className = "text-[11px] text-emerald-600";
      renderRow(it, i);
      updateStats(trialItems);
    } catch (e) {
      status.textContent = `Invalid JSON: ${e.message}`;
      status.className = "text-[11px] text-rose-600";
    }
  });
}

// Status is now a simple binary toggle: active or inactive.
const STATUS_CYCLE = [
  { id: "active",   label: "Active",   cls: "bg-emerald-500 text-white border-emerald-500 hover:bg-emerald-600" },
  { id: "inactive", label: "Inactive", cls: "bg-white text-slate-400 border-slate-300 hover:border-slate-400" },
];

// --------------------------- Guidance history ---------------------------
// Persistent local history of free-text criterion guidance so users get
// datalist suggestions that prefill from prior similar criteria. Stored as
// { categoryKey: [recent, ..., oldest] } in localStorage.
const GUIDANCE_STORAGE = "trialschema.guidance.history";
const GUIDANCE_MAX_PER_KEY = 8;

function loadGuidanceHistory() {
  try { return JSON.parse(localStorage.getItem(GUIDANCE_STORAGE) || "{}"); }
  catch { return {}; }
}
function saveGuidanceHistory(h) {
  try { localStorage.setItem(GUIDANCE_STORAGE, JSON.stringify(h)); } catch {}
}
function recordGuidance(category, value) {
  if (!value) return;
  const h = loadGuidanceHistory();
  const key = (category || "_general").toLowerCase();
  const list = (h[key] || []).filter(v => v !== value);
  list.unshift(value);
  h[key] = list.slice(0, GUIDANCE_MAX_PER_KEY);
  // Also keep a global pool for cross-category fallback suggestions.
  const all = (h._all || []).filter(v => v !== value);
  all.unshift(value);
  h._all = all.slice(0, GUIDANCE_MAX_PER_KEY * 3);
  saveGuidanceHistory(h);
}
function refreshGuidanceSuggestions(dlist, criterion) {
  const h = loadGuidanceHistory();
  const key = (criterion.category || "_general").toLowerCase();
  const seen = new Set();
  const pool = [...(h[key] || []), ...(h._all || [])].filter(v => {
    if (seen.has(v)) return false;
    seen.add(v); return true;
  }).slice(0, 12);
  dlist.innerHTML = pool.map(v => `<option value="${escapeHtml(v)}"></option>`).join("");
}

// --------------------------- Care Paths (clinical-domain enum) ---------------------------
// A normalized enum derived from a sample of input trials, then editable across
// the full dataset. Used downstream so a patient-matching prompt can reliably
// place a patient into one of these buckets (e.g. "breast_cancer", "heart_failure",
// "type_2_diabetes") regardless of source language or phrasing.
const CAREPATHS_STORAGE = "trialschema.carepaths";

function loadCarePaths() {
  try {
    const arr = JSON.parse(localStorage.getItem(CAREPATHS_STORAGE) || "[]");
    state.carePaths = Array.isArray(arr) ? arr.filter(x => x && x.id && x.label) : [];
  } catch { state.carePaths = []; }
}
function saveCarePaths() {
  try { localStorage.setItem(CAREPATHS_STORAGE, JSON.stringify(state.carePaths)); } catch {}
}
function slugifyCarePath(label) {
  return String(label).toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "carepath";
}
function uniqueCarePathId(base) {
  let id = base, n = 2;
  const taken = new Set(state.carePaths.map(c => c.id));
  while (taken.has(id)) { id = `${base}_${n++}`; }
  return id;
}

// Best-effort auto-assignment: lowercase alias match against the trial's
// title + diseases + first-N criterion texts. Returns "" if no match.
function inferCarePathId(trial) {
  if (!state.carePaths.length || !trial) return "";
  const m = trial.metadata || {};
  const hay = [
    m.brief_title || "",
    (m.diseases || []).join(" "),
    (trial.criteria || []).slice(0, 6).map(c => c.original_text || "").join(" "),
  ].join(" ").toLowerCase();
  let best = "", bestScore = 0;
  for (const cp of state.carePaths) {
    const aliases = [cp.label, ...(cp.aliases || [])].map(a => String(a).toLowerCase().trim()).filter(Boolean);
    let score = 0;
    for (const a of aliases) {
      if (!a || a.length < 3) continue;
      if (hay.includes(a)) score += a.length;
    }
    if (score > bestScore) { bestScore = score; best = cp.id; }
  }
  return best;
}

function reassignAllCarePaths() {
  let changed = 0;
  (state.results || []).forEach(t => {
    if (!t) return;
    const id = inferCarePathId(t);
    if (id && t.care_path_id !== id) { t.care_path_id = id; changed++; }
  });
  return changed;
}

async function detectCarePathsFromSample() {
  const statusEl = document.getElementById("carePathsStatus");
  if (!state.apiKey) {
    statusEl.innerHTML = `<span class="text-rose-600">Save an OpenAI key in the header to detect care paths.</span>`;
    return;
  }
  const sample = (state.rawRows || []).slice(0, 12);
  if (!sample.length) {
    statusEl.innerHTML = `<span class="text-rose-600">Load trials first (upload a source file).</span>`;
    return;
  }
  statusEl.innerHTML = `<span class="italic text-slate-500">Sampling ${sample.length} trials…</span>`;
  const sys = `You normalize clinical trials from ANY field of medicine (oncology, cardiology, neurology, endocrinology, infectious disease, rheumatology, …) into a small enum of CARE PATHS — clinical-domain buckets used downstream for patient matching. Examples (illustrative, NOT exhaustive): "breast_cancer", "prostate_cancer", "heart_failure", "atrial_fibrillation", "type_2_diabetes", "alzheimer_disease", "rheumatoid_arthritis", "hiv". Given a sample of trials in any language (e.g. Dutch "borst"/"mamma" -> breast cancer, "prostaat" -> prostate cancer, "hartfalen" -> heart failure, "suikerziekte" -> diabetes), return a deduplicated enum covering ALL of them. Return STRICT JSON: {"care_paths":[{"id":"breast_cancer","label":"Breast cancer","aliases":["breast cancer","mamma","mammacarcinoma","borst","borstkanker"]}]}. Use snake_case English ids. Choose specificity that matches the sample (sub-types when meaningful, broader domains when not). Aliases MUST include every language/spelling/synonym that appears in the sample so downstream alias-matching can place trials into the right bucket. Use lowercase aliases. 3-15 care paths total. No prose.`;
  const condensed = sample.map((r, i) => {
    const title = r.__raw?.metadata?.brief_title || r.__raw?.brief_title || r.__raw?.Studietitel || r.__raw?.Titel || "";
    const dis   = r.__raw?.metadata?.conditions || r.__raw?.diseases || r.__raw?.Tumorgroep || r.__raw?.Indicatie || "";
    return `${i+1}. title="${String(title).slice(0,160)}" diseases="${Array.isArray(dis)?dis.join(", "):String(dis).slice(0,120)}"`;
  }).join("\n");
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${state.apiKey}`, "X-DangerouslyAllowBrowser": "true" },
      body: JSON.stringify({
        model: state.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sys },
          { role: "user",   content: `Sample trials:\n${condensed}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const parsed = JSON.parse(j.choices?.[0]?.message?.content || "{}");
    const list = Array.isArray(parsed.care_paths) ? parsed.care_paths : [];
    // Merge with existing (preserve user edits where label matches).
    const byId = Object.fromEntries(state.carePaths.map(c => [c.id, c]));
    list.forEach(cp => {
      const id = String(cp.id || slugifyCarePath(cp.label || "")).toLowerCase();
      const label = String(cp.label || id);
      const aliases = Array.isArray(cp.aliases) ? cp.aliases.map(a => String(a).toLowerCase().trim()).filter(Boolean) : [];
      if (byId[id]) {
        const merged = new Set([...(byId[id].aliases || []), ...aliases]);
        byId[id].aliases = [...merged];
      } else {
        byId[id] = { id, label, aliases };
      }
    });
    state.carePaths = Object.values(byId);
    saveCarePaths();
    const changed = reassignAllCarePaths();
    renderCarePathsPanel();
    // Refresh visible trial bodies so their dropdowns reflect new ids.
    trialItems.forEach((it, i) => { if (it.result) renderRow(it, i); });
    statusEl.innerHTML = `<span class="text-emerald-700">Detected ${list.length} care path(s). Auto-assigned ${changed} trial(s).</span>`;
  } catch (e) {
    statusEl.innerHTML = `<span class="text-rose-600">Detection failed: ${escapeHtml(e.message)}</span>`;
  }
}

function carePathOptionsHtml(selectedId) {
  const opts = [`<option value="">— unassigned —</option>`];
  state.carePaths.forEach(cp => {
    opts.push(`<option value="${escapeHtml(cp.id)}"${cp.id === selectedId ? " selected" : ""}>${escapeHtml(cp.label)}</option>`);
  });
  return opts.join("");
}

function renderCarePathsPanel() {
  const section = document.getElementById("carePathsSection");
  if (!section) return;
  const hasAnyTrials = (state.rawRows || []).length > 0 || (state.results || []).length > 0;
  if (!hasAnyTrials && !state.carePaths.length) { section.classList.add("hidden"); return; }
  section.classList.remove("hidden");
  const list = document.getElementById("carePathsList");
  if (!state.carePaths.length) {
    list.innerHTML = `<div class="col-span-full text-xs text-slate-500 italic p-3 border border-dashed border-slate-200 rounded-lg text-center">No care paths defined yet. Click <strong>Detect from sample</strong> to derive them with the LLM, or <strong>+ Add</strong> to create manually.</div>`;
    return;
  }
  // Per-care-path count of currently-assigned trials.
  const counts = {};
  (state.results || []).forEach(t => { if (t?.care_path_id) counts[t.care_path_id] = (counts[t.care_path_id] || 0) + 1; });
  list.innerHTML = state.carePaths.map(cp => `
    <div class="border border-slate-200 rounded-lg p-2.5 bg-slate-50/50" data-cp="${escapeHtml(cp.id)}">
      <div class="flex items-center gap-2">
        <input data-cp-label class="flex-1 text-sm font-semibold text-slate-900 bg-transparent border-b border-transparent hover:border-slate-200 focus:border-blue-400 focus:outline-none px-0 py-0.5" value="${escapeHtml(cp.label)}"/>
        <span class="text-[10px] font-mono text-slate-400">${escapeHtml(cp.id)}</span>
        <span class="badge bg-blue-50 text-blue-700 border border-blue-200">${counts[cp.id] || 0}</span>
        <button data-cp-delete title="Delete care path" class="text-slate-400 hover:text-rose-600 text-sm leading-none px-1">×</button>
      </div>
      <input data-cp-aliases placeholder="aliases, comma-separated (lowercase: breast, mamma, borst…)"
        class="mt-1.5 w-full text-[11px] font-mono rounded border border-slate-200 bg-white focus:border-blue-400 focus:outline-none px-2 py-1"
        value="${escapeHtml((cp.aliases || []).join(", "))}"/>
    </div>
  `).join("");

  list.querySelectorAll("[data-cp]").forEach(card => {
    const id = card.dataset.cp;
    const cp = state.carePaths.find(c => c.id === id);
    if (!cp) return;
    card.querySelector("[data-cp-label]").addEventListener("input", e => { cp.label = e.target.value; saveCarePaths(); });
    card.querySelector("[data-cp-aliases]").addEventListener("input", e => {
      cp.aliases = e.target.value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
      saveCarePaths();
    });
    card.querySelector("[data-cp-delete]").addEventListener("click", () => {
      if (!confirm(`Delete care path "${cp.label}"? Trials currently assigned to it will become unassigned.`)) return;
      state.carePaths = state.carePaths.filter(c => c.id !== id);
      (state.results || []).forEach(t => { if (t && t.care_path_id === id) t.care_path_id = ""; });
      saveCarePaths();
      renderCarePathsPanel();
      trialItems.forEach((it, i) => { if (it.result) renderRow(it, i); });
    });
  });
}

function bindCarePathControls() {
  document.getElementById("detectCarePathsBtn")?.addEventListener("click", () => detectCarePathsFromSample());
  document.getElementById("addCarePathBtn")?.addEventListener("click", () => {
    const label = prompt("New care path label (e.g. \"Breast cancer\"):");
    if (!label) return;
    const id = uniqueCarePathId(slugifyCarePath(label));
    state.carePaths.push({ id, label: label.trim(), aliases: [label.trim().toLowerCase()] });
    saveCarePaths();
    renderCarePathsPanel();
  });
  document.getElementById("reassignCarePathsBtn")?.addEventListener("click", () => {
    const n = reassignAllCarePaths();
    document.getElementById("carePathsStatus").innerHTML =
      `<span class="text-emerald-700">Re-assigned ${n} trial(s) based on current aliases.</span>`;
    renderCarePathsPanel();
    trialItems.forEach((it, i) => { if (it.result) renderRow(it, i); });
  });
}

// --------------------------- Stage expansion ---------------------------
// Detect a likely cancer-staging reference in free text. We surface a
// dedicated "Expand" affordance because LLMs can hallucinate stage groupings
// at evaluation time; this freezes the explicit set into the trial JSON.
function detectStageRange(text) {
  if (!text) return null;
  const t = text;
  if (/\bFIGO\b[^.]{0,80}\b(?:I{1,3}V?|IV)[A-D]?\d?\b/i.test(t)) return { system: "FIGO" };
  if (/\bAJCC\b|\bTNM\b/i.test(t) && /\b(?:I{1,3}V?|IV)[A-D]?\b/i.test(t))   return { system: "AJCC/TNM" };
  if (/\bstage\s+(?:I{1,3}V?|IV|0)[A-D]?\b/i.test(t))                       return { system: "Stage" };
  if (/\b[Tt][0-4](?:[a-d])?(?:\s*[-–]\s*[Tt][0-4][a-d]?)?\s*[Nn][0-3](?:[a-d])?(?:\s*[-–]\s*[Nn][0-3][a-d]?)?\b/.test(t)) return { system: "TNM" };
  return null;
}

async function expandStagesForCriterion(criterion, stageMatch, host) {
  if (!state.apiKey) {
    host.innerHTML = `<span class="text-[10px] text-rose-600">Save an OpenAI key in the header to expand stages.</span>`;
    return;
  }
  host.innerHTML = `<span class="text-[10px] text-slate-500 italic">Expanding ${escapeHtml(stageMatch.system)} stages…</span>`;
  const sys = `You are a clinical staging expert. Given a free-text criterion that references a cancer staging range, enumerate every explicit stage in that range and provide its TNM-8 mapping when applicable. Return STRICT JSON: {"system":"FIGO|AJCC|TNM|Stage","values":[{"stage":"IB2","tnm":"T1b2 N0 M0"}, ...]}. No prose. If the text doesn't actually specify a stage range, return {"system":"","values":[]}.`;
  const usr = `Criterion text:\n${criterion.original_text}\n\nDetected staging system: ${stageMatch.system}\n\nEnumerate every individual stage in the range, inclusive. Use the disease context implied by the criterion to pick the correct TNM-8 mapping; if ambiguous, omit the tnm field.`;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.apiKey}`,
        "X-DangerouslyAllowBrowser": "true",
      },
      body: JSON.stringify({
        model: state.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sys },
          { role: "user",   content: usr },
        ],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const parsed = JSON.parse(j.choices?.[0]?.message?.content || "{}");
    const values = Array.isArray(parsed.values) ? parsed.values.filter(v => v && v.stage) : [];
    if (!values.length) {
      host.innerHTML = `<span class="text-[10px] text-amber-700">No stages enumerated.</span>`;
      return;
    }
    criterion.stage_expansion = { system: parsed.system || stageMatch.system, values };
    host.innerHTML = `<span class="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">${escapeHtml(parsed.system || stageMatch.system)}:</span>` +
      values.map(v => `<span class="badge bg-violet-50 text-violet-700 border border-violet-200">${escapeHtml(v.stage)}${v.tnm ? ` <span class="text-violet-400 font-normal">${escapeHtml(v.tnm)}</span>` : ""}</span>`).join("");
  } catch (e) {
    host.innerHTML = `<span class="text-[10px] text-rose-600">Failed to expand: ${escapeHtml(e.message)}</span>`;
  }
}

function buildCriterionRow(trial, c, ci) {
  const card = document.createElement("div");
  card.className = "criterion-card bg-white border border-slate-200 rounded-xl px-4 py-3 hover:border-blue-200 hover:shadow-sm transition";
  card.draggable = true;
  card.dataset.cid = c.criterion_id;

  const typeColor = c.type === "exclusion"
    ? "bg-rose-50 text-rose-700 border-rose-200"
    : "bg-emerald-50 text-emerald-700 border-emerald-200";

  // Quantitative pill (boolean is implicit when omitted; less visual noise).
  const evalPill = c.evaluation_type === "quantitative" && c.structured_target
    ? `<span class="inline-flex items-center gap-1 text-[11px] font-medium rounded-md bg-indigo-50 text-indigo-700 border border-indigo-100 px-2 py-0.5">
         ${escapeHtml(c.structured_target.metric)} ${escapeHtml(c.structured_target.operator)} ${c.structured_target.value}${c.structured_target.upper_value!==undefined?`–${c.structured_target.upper_value}`:""}${c.structured_target.unit?` ${escapeHtml(c.structured_target.unit)}`:""}
       </span>`
    : "";
  const codePill = c.structured_target?.standard_code
    ? `<span class="text-[10px] font-mono text-slate-400" title="Ontology code used by the matching engine to align with patient EHR fields">${escapeHtml(c.structured_target.standard_code)}</span>`
    : "";

  // Category label (informational pill, not an interactive control).
  const categoryNorm = (c.category || "").toLowerCase().trim();
  const isOtherCategory = categoryNorm === "other" || !KNOWN_CATEGORIES.has(categoryNorm);
  const categoryLabel = isOtherCategory ? "other" : (DOC_BY_ID[categoryNorm]?.short || categoryNorm);

  // Guidance datalist for the 'other' textarea.
  const guidanceListId = `guidance-list-${trial.trial_id}-${c.criterion_id}`.replace(/[^a-z0-9_-]/gi, "_");

  // Render-time helpers ----------------------------------------------------
  const otherActiveNow = () => docRoutingState(c, "other") !== "off";

  card.innerHTML = `
    <!-- Header row: handle | # rank | type | criterion text | clarify | status -->
    <div class="flex items-start gap-3">
      <button type="button" data-handle title="Drag to reorder"
        class="shrink-0 mt-1 text-slate-300 hover:text-slate-500 cursor-grab select-none">
        <svg viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>
      </button>
      <span data-rank title="Run-order position (lower = run earlier)"
        class="shrink-0 w-7 h-7 grid place-items-center rounded-full bg-slate-100 text-slate-700 text-[12px] font-bold mt-0.5">${ci+1}</span>
      <span class="shrink-0 inline-flex items-center text-[10px] font-semibold rounded-md border ${typeColor} px-2 py-0.5 mt-1">${escapeHtml(c.criterion_id)}</span>
      <div class="flex-1 min-w-0">
        <div data-text class="text-[13px] leading-relaxed text-slate-800">${escapeHtml(c.original_text)}</div>
        <div data-original-line></div>
        <div class="mt-1.5 flex items-center gap-2 flex-wrap text-[11px]">
          <span class="text-slate-400 lowercase tracking-wide">${escapeHtml(categoryLabel)}</span>
          ${evalPill}
          ${codePill}
        </div>
      </div>
      <div class="shrink-0 flex flex-col items-end gap-1.5 mt-0.5">
        <button type="button" data-status-toggle
          class="text-[11px] font-semibold rounded-full px-3 py-1 border transition w-24"></button>
        <button type="button" data-clarify-toggle title="Rewrite this criterion to be unambiguous and self-contained"
          class="inline-flex items-center gap-1 text-[11px] font-semibold rounded-md bg-blue-50 text-blue-700 border border-blue-200 px-2 py-1 hover:bg-blue-100">
          <svg viewBox="0 0 24 24" class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20l9-9-4-4-9 9-1 5 5-1z" stroke-linejoin="round"/></svg>
          Clarify
        </button>
      </div>
    </div>

    <!-- Clarify panel (vertical, full-width) -->
    <div data-clarify-panel class="hidden mt-3 rounded-lg border border-blue-200 bg-blue-50/60 p-3 space-y-2">
      <div class="text-[11px] font-semibold text-blue-800">Rewrite this criterion to be explicit for the matching agent</div>
      <textarea data-clarify-input rows="2"
        placeholder="Optional guidance, e.g. 'HER2-low means IHC 1+ or 2+ ISH-negative'. Leave blank to just disambiguate."
        class="w-full text-[12px] rounded-md border border-blue-200 bg-white focus:border-blue-400 focus:outline-none px-2.5 py-1.5 resize-y"></textarea>
      <div class="flex items-center gap-2">
        <button type="button" data-clarify-run
          class="text-[11px] font-semibold rounded-md bg-blue-600 text-white px-3 py-1.5 hover:bg-blue-700 disabled:opacity-50">Rewrite with LLM</button>
        <button type="button" data-clarify-cancel
          class="text-[11px] font-medium text-slate-500 hover:text-slate-700 px-1">cancel</button>
        <span data-clarify-status class="text-[10px]"></span>
      </div>
    </div>

    <!-- Routing strip -->
    <div class="mt-3 pt-3 border-t border-slate-100">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Where to find this in patient docs</span>
        <span class="text-[10px] text-slate-400">— click to cycle:
          <span class="inline-flex items-center gap-1 ml-1"><span class="inline-block w-2 h-2 rounded-full bg-blue-600"></span>primary</span>
          <span class="inline-flex items-center gap-1 ml-1"><span class="inline-block w-2 h-2 rounded-full bg-amber-300"></span>fallback</span>
          <span class="inline-flex items-center gap-1 ml-1"><span class="inline-block w-2 h-2 rounded-full bg-slate-200"></span>off</span>
        </span>
      </div>
      <div class="flex flex-wrap gap-1.5" data-routing></div>
      <div data-other-guidance class="${otherActiveNow() ? "" : "hidden"} mt-2">
        <textarea data-guidance list="${guidanceListId}" rows="2"
          placeholder="Free-text guidance for the matching agent (e.g. 'check signed consent form is on file')"
          class="w-full text-[12px] rounded-md border border-amber-200 bg-amber-50/40 focus:bg-white focus:border-amber-400 focus:outline-none px-2.5 py-1.5 resize-y">${escapeHtml(c.guidance||"")}</textarea>
        <datalist id="${guidanceListId}" data-guidance-list></datalist>
      </div>
    </div>
  `;

  // ---------- Render the routing chips ----------
  const routingHost = card.querySelector("[data-routing]");
  const otherGuidance = card.querySelector("[data-other-guidance]");
  MATRIX_DOCS.forEach(d => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.dataset.doc = d.id;
    routingHost.appendChild(chip);
    renderMatrixCell(chip, c, d, () => {
      if (d.id === "other") {
        otherGuidance.classList.toggle("hidden", !otherActiveNow());
        if (otherActiveNow()) {
          refreshGuidanceSuggestions(card.querySelector("[data-guidance-list]"), c);
          card.querySelector("[data-guidance]")?.focus();
        }
      }
    });
  });

  // ---------- Inline original-text "was: ... revert" line ----------
  const textEl = card.querySelector("[data-text]");
  const originalLine = card.querySelector("[data-original-line]");
  const refreshOriginalLine = () => {
    originalLine.innerHTML = "";
    if (c.original_text_raw && c.original_text_raw !== c.original_text) {
      const div = document.createElement("div");
      div.className = "mt-1 text-[10px] text-slate-400 italic";
      div.innerHTML = `was: "${escapeHtml(c.original_text_raw)}" <button type="button" data-clarify-revert class="ml-1 text-blue-600 hover:underline not-italic font-semibold">revert</button>`;
      originalLine.appendChild(div);
      div.querySelector("[data-clarify-revert]").addEventListener("click", () => {
        c.original_text = c.original_text_raw;
        delete c.original_text_raw;
        textEl.textContent = c.original_text;
        refreshOriginalLine();
      });
    }
  };
  refreshOriginalLine();

  // ---------- Stage expansion (inline below criterion text) ----------
  const stageMatch = detectStageRange(c.original_text);
  if (stageMatch) {
    const stageBar = document.createElement("div");
    stageBar.className = "mt-2 flex flex-wrap items-center gap-1.5";
    const expanded = c.stage_expansion?.values || [];
    if (expanded.length) {
      stageBar.innerHTML = `<span class="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">${escapeHtml(stageMatch.system)}:</span>` +
        expanded.map(v => `<span class="inline-flex items-center text-[11px] rounded-md bg-violet-50 text-violet-700 border border-violet-100 px-2 py-0.5">${escapeHtml(v.stage)}${v.tnm ? ` <span class="text-violet-400 font-normal ml-1">${escapeHtml(v.tnm)}</span>` : ""}</span>`).join("");
    } else {
      const btn = document.createElement("button");
      btn.className = "inline-flex items-center gap-1 text-[10px] font-semibold rounded-md bg-violet-50 text-violet-700 border border-violet-200 px-2 py-0.5 hover:bg-violet-100";
      btn.innerHTML = `<svg viewBox="0 0 24 24" class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg> Expand ${escapeHtml(stageMatch.system)} stages`;
      btn.title = "Use the LLM to enumerate explicit stages with TNM-8 mappings.";
      btn.addEventListener("click", () => expandStagesForCriterion(c, stageMatch, stageBar));
      stageBar.appendChild(btn);
    }
    originalLine.after(stageBar);
  }

  // ---------- Status toggle (active / inactive) ----------
  const statusBtn = card.querySelector("[data-status-toggle]");
  const paintStatus = () => {
    const cur = STATUS_CYCLE.find(s => s.id === c.status) || STATUS_CYCLE[0];
    statusBtn.className = `text-[11px] font-semibold rounded-full px-3 py-1 border transition w-24 ${cur.cls}`;
    statusBtn.textContent = cur.label;
    statusBtn.title = `Click to ${c.status === "active" ? "deactivate" : "activate"} this criterion`;
    card.classList.toggle("opacity-60", c.status === "inactive");
  };
  paintStatus();
  statusBtn.addEventListener("click", () => {
    c.status = c.status === "active" ? "inactive" : "active";
    paintStatus();
  });

  // ---------- Guidance textarea ----------
  const guidance = card.querySelector("[data-guidance]");
  const dlist    = card.querySelector("[data-guidance-list]");
  if (guidance) {
    refreshGuidanceSuggestions(dlist, c);
    guidance.addEventListener("input", () => { c.guidance = guidance.value; });
    guidance.addEventListener("blur", () => {
      const v = guidance.value.trim();
      if (v) recordGuidance(c.category, v);
    });
  }

  // ---------- Clarify panel wiring ----------
  const clarifyToggle = card.querySelector("[data-clarify-toggle]");
  const clarifyPanel  = card.querySelector("[data-clarify-panel]");
  const clarifyInput  = card.querySelector("[data-clarify-input]");
  const clarifyRun    = card.querySelector("[data-clarify-run]");
  const clarifyCancel = card.querySelector("[data-clarify-cancel]");
  const clarifyStatus = card.querySelector("[data-clarify-status]");
  clarifyToggle?.addEventListener("click", () => {
    const open = !clarifyPanel.classList.contains("hidden");
    clarifyPanel.classList.toggle("hidden", open);
    if (!open) clarifyInput?.focus();
  });
  clarifyCancel?.addEventListener("click", () => clarifyPanel.classList.add("hidden"));
  clarifyRun?.addEventListener("click", async () => {
    if (!state.apiKey) {
      clarifyStatus.textContent = "Save an OpenAI key first.";
      clarifyStatus.className = "text-[10px] text-rose-600";
      return;
    }
    const userHint = (clarifyInput?.value || "").trim();
    clarifyRun.disabled = true;
    clarifyStatus.textContent = "Rewriting…";
    clarifyStatus.className = "text-[10px] text-slate-500 italic";
    try {
      const newText = await clarifyCriterionWithLLM(trial, c, userHint);
      if (newText && newText !== c.original_text) {
        if (!c.original_text_raw) c.original_text_raw = c.original_text;
        c.original_text = newText;
        textEl.textContent = newText;
        refreshOriginalLine();
        clarifyStatus.textContent = "Rewritten ✓";
        clarifyStatus.className = "text-[10px] text-emerald-600";
        setTimeout(() => { clarifyPanel.classList.add("hidden"); clarifyStatus.textContent = ""; }, 1200);
      } else {
        clarifyStatus.textContent = "No change.";
        clarifyStatus.className = "text-[10px] text-slate-500";
      }
    } catch (e) {
      clarifyStatus.textContent = `Error: ${e.message}`;
      clarifyStatus.className = "text-[10px] text-rose-600";
    } finally {
      clarifyRun.disabled = false;
    }
  });

  return card;
}

// Call the LLM to rewrite a single criterion so it is unambiguous and
// self-contained. The prompt teaches the model to bake in the background
// knowledge a downstream matcher would otherwise need to invent.
async function clarifyCriterionWithLLM(trial, criterion, userHint) {
  const sys = `You rewrite a SINGLE clinical-trial eligibility criterion so that it is fully explicit, unambiguous, and self-contained for a downstream patient-matching agent. Bake in the background clinical knowledge needed to evaluate it (e.g. resolve abbreviations, name the staging system, give numeric thresholds when widely accepted, name the relevant lab/imaging modality). Keep it ONE sentence (or two short ones). Do NOT add commentary. Preserve the original meaning — NEVER make it more or less restrictive. Return STRICT JSON: {"rewritten":"...string..."}.`;
  const m = trial.metadata || {};
  const ctx = [
    m.brief_title ? `Trial title: ${m.brief_title}` : "",
    m.diseases?.length ? `Diseases: ${m.diseases.join(", ")}` : "",
    m.phase ? `Phase: ${m.phase}` : "",
    `Criterion type: ${criterion.type}`,
    `Criterion category: ${criterion.category}`,
    `Original text: ${criterion.original_text}`,
    userHint ? `\nUser guidance (apply this when rewriting): ${userHint}` : "",
  ].filter(Boolean).join("\n");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${state.apiKey}`,
      "X-DangerouslyAllowBrowser": "true",
    },
    body: JSON.stringify({
      model: state.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user",   content: ctx },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const parsed = JSON.parse(j.choices?.[0]?.message?.content || "{}");
  return String(parsed.rewritten || "").trim();
}

function docRoutingState(criterion, docId) {
  if (criterion.routing.primary_docs.includes(docId)) return "primary";
  if (criterion.routing.fallback_docs.includes(docId)) return "fallback";
  return "off";
}

function setDocRouting(criterion, docId, next) {
  // Strip from both arrays first, then add to the chosen one.
  criterion.routing.primary_docs  = criterion.routing.primary_docs.filter(x => x !== docId);
  criterion.routing.fallback_docs = criterion.routing.fallback_docs.filter(x => x !== docId);
  if (next === "primary")  criterion.routing.primary_docs.push(docId);
  if (next === "fallback") criterion.routing.fallback_docs.push(docId);
}

function renderMatrixCell(btn, criterion, doc, onAfterChange) {
  const paint = () => {
    const state = docRoutingState(criterion, doc.id);
    btn.title = `${doc.label} — ${doc.hint}\n(current: ${state})`;
    const base = "inline-flex items-center gap-1 text-[11px] font-semibold rounded-md px-2.5 py-1 border transition";
    const isOther = doc.id === "other";
    if (state === "primary") {
      btn.className = `${base} bg-blue-600 text-white border-blue-600 hover:bg-blue-700`;
    } else if (state === "fallback") {
      btn.className = `${base} bg-amber-100 text-amber-700 border-amber-300 hover:bg-amber-200`;
    } else {
      btn.className = `${base} bg-white text-slate-400 border-slate-200 hover:border-blue-300 hover:text-blue-600${isOther ? " border-dashed" : ""}`;
    }
    btn.innerHTML = `<span>${escapeHtml(doc.short)}</span>`;
  };
  paint();
  btn.addEventListener("click", () => {
    const cycle = { off: "primary", primary: "fallback", fallback: "off" };
    setDocRouting(criterion, doc.id, cycle[docRoutingState(criterion, doc.id)]);
    paint();
    onAfterChange?.();
  });
}

// HTML5 drag-and-drop reordering. After every drop we re-emit
// priority_level = 1..N based on the new visual position so the displayed
// rank badge always matches the order in the list.
function enableCriterionDrag(host, trial) {
  let dragSrc = null;
  const cards = () => Array.from(host.querySelectorAll(".criterion-card"));
  const repaintRanks = () => {
    cards().forEach((card, i) => {
      const badge = card.querySelector("[data-rank]");
      if (badge) badge.textContent = String(i + 1);
    });
  };
  cards().forEach(card => {
    card.addEventListener("dragstart", (e) => {
      dragSrc = card;
      card.classList.add("opacity-50");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", card.dataset.cid || "");
    });
    card.addEventListener("dragend", () => card.classList.remove("opacity-50"));
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragSrc || dragSrc === card) return;
      const rect = card.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      host.insertBefore(dragSrc, before ? card : card.nextSibling);
    });
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      const order = cards().map(r => r.dataset.cid);
      trial.criteria.sort((a, b) => order.indexOf(a.criterion_id) - order.indexOf(b.criterion_id));
      // Re-number both the data model and the visible rank badges so the
      // ranking is purely positional (1..N) after every drop.
      trial.criteria.forEach((c, i) => { c.priority_level = i + 1; });
      repaintRanks();
    });
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}


/* ============================== 9. EXPORT ============================== */
//
// External wire format: TrialSchema v1.
// Source of truth: docs/schemas/trialschema.v1.schema.json
//                  ($id https://trialschema.org/v1/export.schema.json)
//
// The internal app data model is an implementation detail; everything that
// crosses the app boundary (download, re-import) flows through these two
// transforms. End users never hand-curate ontology codes — the LLM populates
// best-effort hints during extraction, and free-text fallbacks remain valid.

const TS_V1 = {
  FORMAT: "trialschema",
  VERSION: "1.0",
  GENERATOR: { name: "trialschema-ui", version: "1.0.0" },
  DOC_TYPE_MAP: {
    intake_notes:      "intake-notes",
    referral_letters:  "referral-letters",
    mdo_notes:         "mdo-notes",
    pathology:         "pathology",
    imaging_radiology: "imaging",
    treatment_history: "treatment-history",
    molecular_genomic: "molecular-genomic",
    core_lab:          "core-lab",
    other:             "other",
    unknown:           null,
  },
  DOC_TYPE_INVERSE: {
    "intake-notes":      "intake_notes",
    "referral-letters":  "referral_letters",
    "mdo-notes":         "mdo_notes",
    "pathology":         "pathology",
    "imaging":           "imaging_radiology",
    "treatment-history": "treatment_history",
    "molecular-genomic": "molecular_genomic",
    "core-lab":          "core_lab",
    "other":             "other",
  },
  TERMINOLOGY_SYSTEMS: {
    LOINC:       "http://loinc.org",
    SNOMED:      "http://snomed.info/sct",
    "SNOMED-CT": "http://snomed.info/sct",
    SCT:         "http://snomed.info/sct",
    RXNORM:      "http://www.nlm.nih.gov/research/umls/rxnorm",
    ICD10:       "http://hl7.org/fhir/sid/icd-10",
    "ICD-10":    "http://hl7.org/fhir/sid/icd-10",
    ICD11:       "http://id.who.int/icd11",
    HGNC:        "http://www.genenames.org",
    ATC:         "http://www.whocc.no/atc",
  },
  PHASE_MAP: {
    "n/a": "n-a", "na": "n-a", "not applicable": "n-a",
    "early phase 1": "early-phase-1", "early-phase-1": "early-phase-1",
    "phase 1": "phase-1", "phase i": "phase-1",
    "phase 1/2": "phase-1-2", "phase i/ii": "phase-1-2", "phase 1-2": "phase-1-2",
    "phase 2": "phase-2", "phase ii": "phase-2",
    "phase 2/3": "phase-2-3", "phase ii/iii": "phase-2-3", "phase 2-3": "phase-2-3",
    "phase 3": "phase-3", "phase iii": "phase-3",
    "phase 4": "phase-4", "phase iv": "phase-4",
  },
  STATUS_MAP: {
    "Not yet recruiting":     "not-yet-recruiting",
    "Recruiting":             "recruiting",
    "Active, not recruiting": "active-not-recruiting",
    "Completed":              "completed",
    "Suspended":              "suspended",
    "Terminated":             "terminated",
    "Withdrawn":              "withdrawn",
  },
  STATUS_INVERSE: {
    "not-yet-recruiting":     "Not yet recruiting",
    "recruiting":             "Recruiting",
    "active-not-recruiting":  "Active, not recruiting",
    "completed":              "Completed",
    "suspended":              "Recruiting",
    "terminated":             "Completed",
    "withdrawn":              "Completed",
  },
  DOMAIN_FOR_CATEGORY: {
    intake_notes:      "demographics",
    referral_letters:  "condition",
    mdo_notes:         "procedure",
    pathology:         "observation",
    imaging_radiology: "observation",
    treatment_history: "medication",
    molecular_genomic: "genomic",
    core_lab:          "observation",
    other:             "other",
  },
};

function tsv1NormalizePhase(p) {
  const k = String(p || "").trim().toLowerCase();
  if (!k) return "unknown";
  return TS_V1.PHASE_MAP[k] || "unknown";
}

function tsv1ParseCode(raw) {
  // "LOINC:2160-0" -> { system, code }; bare "X" -> { code }; empty -> null
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^([A-Za-z][A-Za-z0-9-]*)\s*[:|]\s*(.+)$/);
  if (m) {
    const sys = TS_V1.TERMINOLOGY_SYSTEMS[m[1].toUpperCase()];
    if (sys) return { system: sys, code: m[2].trim() };
  }
  return { code: s };
}

function tsv1Coding(parts) {
  if (!parts) return null;
  const out = {};
  if (parts.system)  out.system  = parts.system;
  if (parts.code)    out.code    = parts.code;
  if (parts.display) out.display = parts.display;
  if (parts.text)    out.text    = parts.text;
  return Object.keys(out).length ? out : null;
}

function tsv1UcumForUnit(unit) {
  if (!unit) return null;
  const u = String(unit).trim();
  const map = {
    "%": "%", "years": "a", "year": "a", "yr": "a",
    "months": "mo", "month": "mo", "mo": "mo",
    "weeks": "wk", "week": "wk", "wk": "wk",
    "days": "d", "day": "d", "d": "d",
    "hours": "h", "hour": "h", "h": "h",
    "minutes": "min", "minute": "min", "min": "min",
    "mmHg": "mm[Hg]", "mm Hg": "mm[Hg]",
    "ml/min": "mL/min", "mL/min": "mL/min",
  };
  return map[u] || u;
}

function tsv1Quantity(value, unit) {
  if (!Number.isFinite(+value)) return null;
  const q = { value: +value };
  if (unit) {
    q.unit = String(unit);
    q.system = "http://unitsofmeasure.org";
    q.code = tsv1UcumForUnit(unit);
  }
  return q;
}

function tsv1Constraint(c) {
  // Build a v1 tagged-union constraint from the internal criterion shape.
  // Always-valid fallback: { kind: "text", description: source_text }.
  const fallback = () => ({ kind: "text", description: String(c.original_text || "") });
  if (c.evaluation_type !== "quantitative" || !c.structured_target) return fallback();
  const st = c.structured_target;
  const op = st.operator;
  if (op === "between" && Number.isFinite(+st.value) && Number.isFinite(+st.upper_value)) {
    return {
      kind: "range",
      low:  tsv1Quantity(st.value, st.unit),
      high: tsv1Quantity(st.upper_value, st.unit),
    };
  }
  const q = tsv1Quantity(st.value, st.unit);
  if (!q || !["<", "<=", "=", ">=", ">", "!="].includes(op)) return fallback();
  return { kind: "comparison", operator: op, quantity: q };
}

function tsv1Criterion(c, idx) {
  const concept = {
    domain: TS_V1.DOMAIN_FOR_CATEGORY[c.category] || "other",
  };
  const code = tsv1ParseCode(c.structured_target?.standard_code);
  if (code) concept.code = tsv1Coding(code);
  if (c.structured_target?.metric) concept.text = String(c.structured_target.metric);
  return {
    id: c.criterion_id,
    kind: c.type === "exclusion" ? "exclusion" : "inclusion",
    enabled: c.status !== "inactive",
    rank: Number.isFinite(+c.priority_level) ? +c.priority_level : (idx + 1),
    source_text: String(c.original_text_raw || c.original_text || ""),
    clarified_text: c.original_text_raw && c.original_text_raw !== c.original_text
      ? String(c.original_text) : null,
    concept,
    assertion: "present",
    constraint: tsv1Constraint(c),
    routing: {
      primary:  (c.routing?.primary_docs  || []).map(d => TS_V1.DOC_TYPE_MAP[d]).filter(Boolean),
      fallback: (c.routing?.fallback_docs || []).map(d => TS_V1.DOC_TYPE_MAP[d]).filter(Boolean),
    },
    guidance: typeof c.guidance === "string" ? c.guidance : "",
    provenance: {
      extracted_at: new Date().toISOString(),
      extracted_by: `openai/${state.model || "unknown"}`,
    },
  };
}

function tsv1Trial(t) {
  const m = t.metadata || {};
  const conditions = (m.diseases || []).map(d => tsv1Coding({ text: String(d) })).filter(Boolean);
  const interventions = (m.drugs || []).map(d => ({ type: "drug", label: String(d) }));
  const lifecycle = {};
  if (m.recruitment_status) {
    lifecycle.status = TS_V1.STATUS_MAP[m.recruitment_status] || "unknown";
  }
  const ld = m.lifecycle_dates || {};
  if (ld.start_date)              lifecycle.start_date = ld.start_date;
  if (ld.primary_completion_date) lifecycle.primary_completion_date = ld.primary_completion_date;
  if (ld.actual_close_date)       lifecycle.completion_date = ld.actual_close_date;

  const out = {
    id: String(t.trial_id || ""),
    kind: "trial",
    enabled: t.active !== false,
    title: String(m.brief_title || ""),
    phase: tsv1NormalizePhase(m.phase),
    conditions,
    interventions,
  };
  if (Number.isFinite(+m.enrollment_target) && +m.enrollment_target > 0) {
    out.enrollment = { target: +m.enrollment_target };
  }
  if (Object.keys(lifecycle).length) out.lifecycle = lifecycle;

  if (t.care_path && Array.isArray(t.care_path.phases) && t.care_path.phases.length) {
    const cp = state.carePaths.find(p => p.id === t.care_path_id);
    out.care_path = {
      id:    t.care_path_id || "",
      label: cp?.label || "",
      phases: t.care_path.phases.map((p, i) => ({
        id: `phase-${i + 1}`,
        label: String(p.phase_name || ""),
        description: String(p.description || ""),
        key_activities: Array.isArray(p.key_activities) ? p.key_activities.map(String) : [],
      })),
    };
  }

  out.criteria = (t.criteria || []).map((c, i) => tsv1Criterion(c, i));
  return out;
}

function toV1Envelope(trials) {
  return {
    format:         TS_V1.FORMAT,
    format_version: TS_V1.VERSION,
    generated_at:   new Date().toISOString(),
    generator:      TS_V1.GENERATOR,
    trial_count:    trials.length,
    trials:         trials.map(tsv1Trial),
  };
}

// Reverse transform: TrialSchema v1 envelope -> internal model. Used when the
// user re-imports a previously exported file.
function fromV1Trial(v) {
  const m = {
    brief_title: v.title || "",
    phase: (v.phase || "").replace(/^phase-/, "Phase ").replace("-", "/").replace("n-a", ""),
    drugs: (v.interventions || []).map(i => i.label).filter(Boolean),
    diseases: (v.conditions || []).map(c => c.display || c.text || c.code || "").filter(Boolean),
    enrollment_target: v.enrollment?.target || 0,
    recruitment_status: TS_V1.STATUS_INVERSE[v.lifecycle?.status] || "Recruiting",
    lifecycle_dates: {
      start_date:              v.lifecycle?.start_date || "",
      primary_completion_date: v.lifecycle?.primary_completion_date || "",
      actual_close_date:       v.lifecycle?.completion_date || "",
    },
  };
  const criteria = (v.criteria || []).map((c, i) => {
    const cat = (c.routing?.primary || []).map(d => TS_V1.DOC_TYPE_INVERSE[d]).filter(Boolean)[0] || "other";
    let st = null, evalType = "boolean";
    if (c.constraint?.kind === "comparison") {
      evalType = "quantitative";
      const sysShort = (c.concept?.code?.system || "").split("/").pop();
      st = {
        metric: c.concept?.text || "",
        standard_code: c.concept?.code?.code ? `${sysShort}:${c.concept.code.code}` : "",
        operator: c.constraint.operator,
        value: c.constraint.quantity?.value ?? 0,
        unit: c.constraint.quantity?.unit || "",
      };
    } else if (c.constraint?.kind === "range") {
      evalType = "quantitative";
      st = {
        metric: c.concept?.text || "",
        standard_code: "",
        operator: "between",
        value: c.constraint.low?.value ?? 0,
        upper_value: c.constraint.high?.value ?? 0,
        unit: c.constraint.low?.unit || c.constraint.high?.unit || "",
      };
    }
    return {
      criterion_id: c.id || `${c.kind === "exclusion" ? "EXC" : "INC"}-${String(i + 1).padStart(2, "0")}`,
      type: c.kind === "exclusion" ? "exclusion" : "inclusion",
      original_text: c.clarified_text || c.source_text || "",
      original_text_raw: c.clarified_text ? c.source_text : "",
      category: cat,
      priority_level: c.rank || (i + 1),
      status: c.enabled === false ? "inactive" : "active",
      routing: {
        primary_docs:  (c.routing?.primary  || []).map(d => TS_V1.DOC_TYPE_INVERSE[d]).filter(Boolean),
        fallback_docs: (c.routing?.fallback || []).map(d => TS_V1.DOC_TYPE_INVERSE[d]).filter(Boolean),
      },
      evaluation_type: evalType,
      structured_target: st,
      guidance: c.guidance || "",
      other_active: cat === "other",
    };
  });
  const carePathPhases = (v.care_path?.phases || []).map(p => ({
    phase_name: p.label || "",
    description: p.description || "",
    duration: "",
    key_activities: p.key_activities || [],
  }));
  return sanitizeTrial({
    trial_id: v.id,
    active: v.enabled !== false,
    metadata: m,
    care_path: { phases: carePathPhases },
    care_path_id: v.care_path?.id || "",
    criteria,
  });
}

function fromV1Envelope(parsed) {
  if (!parsed || parsed.format !== TS_V1.FORMAT) return null;
  const trials = Array.isArray(parsed.trials) ? parsed.trials.map(fromV1Trial) : [];
  return { trials };
}

function exportUnified() {
  // Merge: start from existing export (preserving any non-matching trials),
  // then override with current results (newly processed + edits).
  const merged = {};
  const priorTrials = state.existingExport
    ? (Array.isArray(state.existingExport) ? state.existingExport : (state.existingExport.trials || []))
    : [];
  for (const t of priorTrials) {
    if (t && t.trial_id) merged[t.trial_id] = t;
  }
  for (const t of state.results) {
    if (t && t.trial_id) merged[t.trial_id] = t;
  }
  const out = toV1Envelope(Object.values(merged));
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "trialschema_export.json";
  a.click();
  URL.revokeObjectURL(url);
}


/* =========================== 10. WIRE-UP =========================== */

function bindFilters() {
  const search = document.getElementById("searchInput");
  const filter = document.getElementById("filterStatus");
  const apply = () => {
    const q = search.value.trim().toLowerCase();
    const f = filter.value;
    const list = document.getElementById("trialsList");
    list.querySelectorAll("details").forEach(el => {
      const idx = +el.dataset.idx;
      const it = trialItems[idx];
      if (!it) return;
      const text = `${it.preview.id} ${it.preview.title} ${it.preview.meta||""}`.toLowerCase();
      const okQ = !q || text.includes(q);
      const okF = !f || it.status === f;
      el.style.display = (okQ && okF) ? "" : "none";
    });
  };
  search.addEventListener("input", apply);
  filter.addEventListener("change", apply);
}

document.addEventListener("DOMContentLoaded", () => {
  loadApiKey();
  loadCarePaths();
  bindManualUploads();
  bindFilters();
  bindSourceInfoModal();
  bindCarePathControls();
  renderCarePathsPanel();

  document.getElementById("saveKeyBtn").addEventListener("click", saveApiKey);
  document.getElementById("apiKeyInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveApiKey();
  });
  document.getElementById("modelSelect").addEventListener("change", (e) => {
    state.model = e.target.value;
    localStorage.setItem(MODEL_STORAGE, state.model);
  });
  document.querySelectorAll(".tpl-btn").forEach(btn => {
    btn.addEventListener("click", () => downloadTemplate(btn.dataset.tpl));
  });
  document.getElementById("loadDemoBtn").addEventListener("click", loadDemoCorpus);
  document.getElementById("processBtn").addEventListener("click", runQueue);
  document.getElementById("stopBtn").addEventListener("click", () => {
    state.abort = true;
    if (state._sleepCancel) state._sleepCancel();
  });
  document.getElementById("exportBtn").addEventListener("click", exportUnified);
});

// Load the bundled SIGIR demo corpus so the user can try the pipeline without
// hunting for a sample file. Mimics a manual upload by populating state.newFile.
async function loadDemoCorpus() {
  const url = "ingestion/corpus-sigir-snippet.jsonl";
  const btn = document.getElementById("loadDemoBtn");
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Loading sample…";
  setCtgovRunHint("");
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    const file = new File([text], "corpus-sigir-snippet.jsonl", { type: "application/x-ndjson" });
    state.newFile = file;
    document.getElementById("newFileName").textContent = `${file.name} (${formatBytes(file.size)}) · sample`;
    await previewAndDetectFormat(file);
  } catch (e) {
    setFormatBanner("error", `Could not load sample: ${e.message}. Make sure ingestion/corpus-sigir-snippet.jsonl is served alongside index.html.`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

function bindSourceInfoModal() {
  const open  = document.getElementById("sourceInfoBtn");
  const modal = document.getElementById("sourceInfoModal");
  const close = document.getElementById("sourceInfoClose");
  if (!open || !modal) return;
  open.addEventListener("click", () => modal.classList.remove("hidden"));
  close.addEventListener("click", () => modal.classList.add("hidden"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
}
