/* =====================================================================
 * TrialSchema — app.js
 * 100% client-side BYOK pipeline. Transforms raw clinical trial rows
 * into the structured TrialSchema execution model via OpenAI.
 *
 * Sections:
 *   1.  Constants & state
 *   2.  API key handling (localStorage)
 *   3.  /ingestion/ folder discovery + manual file uploads
 *   4.  Source parsers (TrialGPT, Org JSON, spreadsheet Excel/CSV via SheetJS)
 *   5.  Delta diffing (existing TrialSchema export merge)
 *   6.  OpenAI request (system prompt enforcing all extraction rules)
 *   7.  Throttled queue runner
 *   8.  Rendering: trials list & Clinical Review & Override Workspace
 *   9.  Export & utilities
 * ===================================================================== */


/* =========================== 1. CONSTANTS & STATE =========================== */

// Routing profile (Rule 1) - the user-editable document universe and general
// visit order. The default mirrors the former hard-coded document hierarchy.
const DEFAULT_ROUTING_PROFILE = {
  id: "default_clinical",
  label: "Default clinical document profile",
  document_types: [
    { group: "intake_layer",      id: "intake_notes",      label: "Intake Notes",                              short: "Intake", hint: "Demographics, admin rules, general medical history", concept_domain: "demographics" },
    { group: "intake_layer",      id: "referral_letters",  label: "Referral Letters",                          short: "Refer",  hint: "External clinical history validation", concept_domain: "condition" },
    { group: "decision_layer",    id: "mdt_notes",         label: "Multidisciplinary Team Notes",               short: "MDT",    hint: "Multidisciplinary team or specialty board decisions, consensus reviews, therapeutic strategy", concept_domain: "procedure" },
    { group: "diagnostic_core",   id: "pathology",         label: "Histology / Pathology",                     short: "Path",   hint: "Microscopic properties, tissue biomarkers, cellular pathology, biopsies", concept_domain: "observation" },
    { group: "diagnostic_core",   id: "imaging_radiology", label: "Imaging / Functional Testing",              short: "Imag",   hint: "Structural lesions, size tracking, radiology, MRI, CT, EKG/ECG, EEG, echo", concept_domain: "observation" },
    { group: "diagnostic_core",   id: "treatment_history", label: "Treatment History",                         short: "Tx Hx",  hint: "Prior systemic therapy, prior medication lines, washouts, surgical interventions", concept_domain: "medication" },
    { group: "eligibility_layer", id: "molecular_genomic", label: "Advanced / Genomic Labs",                   short: "Mol",    hint: "Genetic sequencing, molecular profiling, liquid biopsy", concept_domain: "genomic" },
    { group: "eligibility_layer", id: "core_lab",          label: "Core Laboratory / Chemistries",             short: "Lab",    hint: "Standard blood/urine, metabolic panels, cell counts (HbA1c, creatinine, potassium...)", concept_domain: "observation" },
    { group: "soft_layer",        id: "other",             label: "Other / Soft criterion",                    short: "Other",  hint: "Consent, willingness, logistics, study-specific rules - pair with free-text guidance", concept_domain: "other" },
  ],
  // User-definable default scan set: the document ids most criteria should
  // search by default. Editable in the UI and persisted with the profile.
  default_scan_set: ["intake_notes", "referral_letters", "mdt_notes"],
};
const ROUTING_PROFILE_STORAGE = "trialschema.routing.profile.v1";

function cloneRoutingProfile(profile = DEFAULT_ROUTING_PROFILE) {
  return JSON.parse(JSON.stringify(profile));
}

function normalizeDocId(id) {
  const normalized = String(id || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
    .slice(0, 48) || "document";
  return normalized;
}

function deriveDocShort(label, id = "") {
  const words = String(label || "").trim().split(/\s+/).filter(Boolean);
  const acronym = words.map(w => w[0]).join("").slice(0, 6);
  return acronym || String(id || "").slice(0, 6) || "doc";
}

function normalizeRoutingProfile(profile) {
  const base = cloneRoutingProfile(DEFAULT_ROUTING_PROFILE);
  const src = profile && typeof profile === "object" ? profile : base;
  const out = {
    id: normalizeDocId(src.id || base.id),
    label: String(src.label || base.label),
    document_types: [],
  };
  const seen = new Set();
  const list = Array.isArray(src.document_types) ? src.document_types : base.document_types;
  list.forEach((d, i) => {
    if (!d || typeof d !== "object") return;
    let id = normalizeDocId(d.id);
    if (!id) id = `document_${i + 1}`;
    if (seen.has(id)) {
      let n = 2, candidate = `${id}_${n}`;
      while (seen.has(candidate)) candidate = `${id}_${++n}`;
      id = candidate;
    }
    seen.add(id);
    const label = String(d.label || id.replace(/_/g, " "));
    const def = base.document_types.find(x => normalizeDocId(x.id) === id);
    out.document_types.push({
      id,
      label,
      short: String(d.short || def?.short || deriveDocShort(label, id)),
      group: String(d.group || def?.group || "custom"),
      hint: String(d.hint !== undefined ? d.hint : (def?.hint || "")),
      concept_domain: normalizeConceptDomain(d.concept_domain || def?.concept_domain),
    });
  });
  if (!out.document_types.some(d => d.id === "other")) {
    out.document_types.push(cloneRoutingProfile(DEFAULT_ROUTING_PROFILE).document_types.find(d => d.id === "other"));
  }
  const validIds = new Set(out.document_types.map(d => d.id));
  const requested = Array.isArray(src.default_scan_set) ? src.default_scan_set : base.default_scan_set;
  const scan = [];
  requested.forEach(id => {
    const k = normalizeDocId(id);
    if (validIds.has(k) && !scan.includes(k)) scan.push(k);
  });
  // Fall back to the first 3 (non-"other") document types if nothing valid was set.
  if (!scan.length) {
    out.document_types.filter(d => d.id !== "other").slice(0, 3).forEach(d => scan.push(d.id));
  }
  out.default_scan_set = scan;
  return out;
}

function normalizeConceptDomain(v) {
  const allowed = new Set(["demographics", "condition", "observation", "medication", "procedure", "adverse-event", "genomic", "consent", "logistic", "other"]);
  const s = String(v || "").trim().toLowerCase();
  return allowed.has(s) ? s : "other";
}

function matrixDocs() {
  return (state.routingProfile?.document_types || []).filter(d => d && d.id);
}

function docById(id) {
  const k = normalizeDocId(id);
  return matrixDocs().find(d => d.id === k) || null;
}

function currentDocIds() {
  return matrixDocs().map(d => d.id);
}

function defaultScanDocIds() {
  const set = state.routingProfile?.default_scan_set;
  const valid = new Set(currentDocIds());
  const ids = (Array.isArray(set) ? set : []).filter(id => valid.has(id));
  if (ids.length) return ids;
  // Fallback: first 3 non-"other" document types in visit order.
  return currentDocIds().filter(id => id !== "other").slice(0, 3);
}

function isDefaultScanDocId(id) {
  return defaultScanDocIds().includes(normalizeDocId(id));
}

function toggleDefaultScanDocId(id) {
  const k = normalizeDocId(id);
  if (!isKnownDocId(k)) return;
  const profile = state.routingProfile;
  const set = Array.isArray(profile.default_scan_set) ? profile.default_scan_set.slice() : [];
  const idx = set.indexOf(k);
  if (idx >= 0) set.splice(idx, 1);
  else set.push(k);
  // Keep the scan set ordered by the document visit order.
  const order = currentDocIds();
  profile.default_scan_set = order.filter(d => set.includes(d));
}

function isKnownDocId(id) {
  return !!docById(id);
}

function coerceDocIdToProfile(id) {
  const k = normalizeDocId(id);
  return isKnownDocId(k) ? k : "";
}

// Default candidate filenames inside /ingestion/. Static apps can't list a
// directory, so we probe a manifest file first, then a sensible default list.
// (Folder scanning is disabled by default; templates + manual upload only.)

function inferBestProfileDoc(criterion) {
  const blob = `${criterion.category||""} ${criterion.original_text||""} ${criterion.structured_target?.metric||""}`.toLowerCase();
  const candidates = [
    [/molecul|gene|mutation|biomark|genom|liquid biops|ctdna|sequenc/, "molecular_genomic"],
    [/lab|blood|urine|chem|wbc|platelet|neutrophil|hb |hemoglob|gfr|creatin|alt|ast|bilirub|pth|sodium|potassium|electrolyte|hba1c|glucose|cholesterol|metabolic|panel/, "core_lab"],
    [/imag|mri|ct|pet|scan|lesion|tumor size|radiograph|sonograph|ultrasound|echo|ekg|ecg|eeg|x-ray|xray|angiogra|spirometr/, "imaging_radiology"],
    [/patholog|histolog|tissue|biopsy|specimen|grade|cytolog/, "pathology"],
    [/prior|previous|treatment|therap|surger|washout|chemo|radiation|line of|medication|prior med/, "treatment_history"],
  ];
  for (const [rx, id] of candidates) {
    if (rx.test(blob) && isKnownDocId(id)) return id;
  }
  return currentDocIds().find(id => id !== "other") || "other";
}

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
  processMode: "single",
  running: false,
  abort: false,
  carePaths: [],        // normalized clinical-domain enum [{id, label, aliases[]}]
  routingProfile: cloneRoutingProfile(DEFAULT_ROUTING_PROFILE),
  selectedRoutingDocId: "",
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
  const status = document.getElementById("keyStatus");
  const savedModel = state.model;

  // Filter to RECENT, chat-completion-capable models. Exclude non-chat or
  // legacy / specialty endpoints (mini/nano variants, image, audio, search,
  // fine-tunes, embeddings, etc.). Also drop anything older than ~14 months
  // based on the `created` timestamp returned by /v1/models.
  const EXCLUDE = /mini|nano|instruct|whisper|tts|dall-?e|embed|moderat|babbage|davinci|realtime|audio|search|preview|transcribe|image|tools|computer-use|\bft\b/i;
  const RECENCY_CUTOFF_DAYS = 420;
  const cutoffEpoch = Math.floor(Date.now() / 1000) - RECENCY_CUTOFF_DAYS * 86400;

  let models = [];
  let keyState = state.apiKey ? "checking" : "empty";
  if (status) {
    status.textContent = state.apiKey ? "checking..." : "manual mode";
    status.className = `text-[11px] ${state.apiKey ? "text-slate-500" : "text-slate-400"}`;
  }

  if (state.apiKey) {
    try {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { "Authorization": `Bearer ${state.apiKey}` },
      });
      if (res.ok) {
        keyState = "verified";
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
      } else {
        keyState = "invalid";
      }
    } catch (_) { keyState = "network"; }
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
  if (status) {
    if (!state.apiKey) {
      status.textContent = "manual mode";
      status.className = "text-[11px] text-slate-400";
    } else if (keyState === "verified") {
      status.textContent = `verified · ${models.length} models`;
      status.className = "text-[11px] text-emerald-600";
    } else if (keyState === "invalid") {
      status.textContent = "invalid key";
      status.className = "text-[11px] text-rose-600";
    } else {
      status.textContent = "saved · check unavailable";
      status.className = "text-[11px] text-amber-600";
    }
  }
  updateApiKeyDependentUi();
}

function loadApiKey() {
  state.apiKey = localStorage.getItem(KEY_STORAGE) || "";
  state.model = localStorage.getItem(MODEL_STORAGE) || "gpt-5.5";
  const input = document.getElementById("apiKeyInput");
  const status = document.getElementById("keyStatus");
  if (state.apiKey) {
    input.value = state.apiKey;
    status.textContent = "checking...";
    status.className = "text-[11px] text-slate-500";
  }
  loadModels();
}

function saveApiKey() {
  const v = document.getElementById("apiKeyInput").value.trim();
  state.apiKey = v;
  localStorage.setItem(KEY_STORAGE, v);
  const status = document.getElementById("keyStatus");
  status.textContent = v ? "checking..." : "manual mode";
  status.className = `text-[11px] ${v ? "text-slate-500" : "text-slate-400"}`;
  updateApiKeyDependentUi();
  // Refresh model list now that we have (or lost) a key.
  loadModels();
  trialItems.forEach((it, i) => renderRow(it, i));
  updateProcessButtonLabel();
}

function updateApiKeyDependentUi() {
  const hasKey = !!state.apiKey;
  document.getElementById("manualModeHint")?.classList.toggle("hidden", hasKey);
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

function showCtgovSourcePanel() {
  const panel = document.getElementById("ctgovSourcePanel");
  const toggle = document.getElementById("ctgovSourceToggle");
  if (panel) panel.classList.remove("hidden");
  if (toggle) toggle.classList.add("ring-2", "ring-cyan-200", "bg-cyan-50");
}

const SPREADSHEET_REQUIRED_GROUPS = [
  { label: "trial", aliases: ["trial"] },
  { label: "inclusion or exclusion", aliases: ["inclusion", "exclusion"] },
];
const SPREADSHEET_OPTIONAL_COLUMNS = [
  "trial_id",
  "care_path",
  "active",
  "condition",
  "indication",
  "start_date",
  "completion_date",
];
const SPREADSHEET_COLUMN_ALIASES = {
  trial_id: ["trial_id"],
  trial: ["trial"],
  care_path: ["care_path"],
  inclusion: ["inclusion"],
  exclusion: ["exclusion"],
  active: ["active"],
  condition: ["condition"],
  indication: ["indication"],
  start_date: ["start_date"],
  completion_date: ["completion_date"],
};

function normalizeHeaderName(name) {
  return String(name || "").trim().toLowerCase();
}

function spreadsheetHeaderMap(headers) {
  const normalized = Object.fromEntries(headers.map(h => [normalizeHeaderName(h), h]));
  const map = {};
  Object.entries(SPREADSHEET_COLUMN_ALIASES).forEach(([canonical, aliases]) => {
    for (const alias of aliases) {
      const key = normalizeHeaderName(alias);
      if (normalized[key]) { map[canonical] = normalized[key]; break; }
    }
  });
  return map;
}

function spreadsheetMissingGroups(headers) {
  const keys = new Set(headers.map(normalizeHeaderName));
  return SPREADSHEET_REQUIRED_GROUPS
    .filter(group => !group.aliases.some(alias => keys.has(normalizeHeaderName(alias))))
    .map(group => group.label);
}

function spreadsheetCellString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalizeSpreadsheetRow(row) {
  const headers = Object.keys(row || {});
  const map = spreadsheetHeaderMap(headers);
  const get = key => map[key] ? row[map[key]] : "";
  return {
    trial_id: spreadsheetCellString(get("trial_id")),
    trial: spreadsheetCellString(get("trial")),
    care_path: spreadsheetCellString(get("care_path")),
    inclusion: spreadsheetCellString(get("inclusion")),
    exclusion: spreadsheetCellString(get("exclusion")),
    active: spreadsheetCellString(get("active")),
    condition: spreadsheetCellString(get("condition")),
    indication: spreadsheetCellString(get("indication")),
    start_date: spreadsheetCellString(get("start_date")),
    completion_date: spreadsheetCellString(get("completion_date")),
    _original_columns: row,
  };
}

function parseTrialEnabled(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["false", "no", "n", "0", "inactive", "inactief", "disabled", "off"].includes(s)) return false;
  if (["true", "yes", "y", "1", "active", "enabled", "on"].includes(s)) return true;
  return null;
}

const INTERVENTION_TYPES = new Set(["drug", "device", "procedure", "biological", "behavioral", "radiation", "diagnostic-test", "other"]);

function normalizeInterventionType(type) {
  const s = String(type || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (s === "diagnostic" || s === "diagnostic-test") return "diagnostic-test";
  if (s === "biologic") return "biological";
  return INTERVENTION_TYPES.has(s) ? s : "other";
}

function normalizeMetadataInterventions(m = {}) {
  const structured = Array.isArray(m.interventions) ? m.interventions.map(iv => {
    if (typeof iv === "string") return { type: "other", label: iv };
    return {
      type: normalizeInterventionType(iv?.type),
      label: String(iv?.label || iv?.name || "").trim(),
    };
  }).filter(iv => iv.label) : [];
  const seen = new Set(structured.map(iv => iv.label.toLowerCase()));
  (Array.isArray(m.drugs) ? m.drugs : []).map(String).map(s => s.trim()).filter(Boolean).forEach(label => {
    const key = label.toLowerCase();
    if (!seen.has(key)) {
      structured.push({ type: "drug", label });
      seen.add(key);
    }
  });
  return structured;
}

function interventionDisplayNames(m = {}) {
  return normalizeMetadataInterventions(m).map(iv => iv.label);
}

function spreadsheetFormatHelpHtml() {
  return [
    `Required: <code>trial</code> and at least one of <code>inclusion</code> / <code>exclusion</code>.`,
    `Optional: <code>${SPREADSHEET_OPTIONAL_COLUMNS.join("</code>, <code>")}</code>.`,
    `Use exact English column names from the template.`,
  ].join(" ");
}

// Detect the source format from a sample row + filename.
function detectFormat(filename, sampleRow) {
  const ext = (filename || "").toLowerCase().split(".").pop();
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return "spreadsheet";
  const r = sampleRow || {};
  if (r.format === TS_V1.FORMAT || (r.kind === "trial" && "criteria" in r)) return "trialschema";
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
    clearPreparedTrials();
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
      // Resume from a canonical TrialSchema v1 export. The envelope is converted
      // back to the internal model so the matcher / UI keep working.
      if (!parsed || parsed.format !== TS_V1.FORMAT) {
        throw new Error(`Not a TrialSchema ${TS_V1.VERSION} export.`);
      }
      const trials = fromV1Envelope(parsed).trials;
      state.existingExport = { trials };
      state.existingById = {};
      for (const t of trials) {
        if (t && t.trial_id) state.existingById[t.trial_id] = t;
      }
      document.getElementById("existingStats").textContent =
        `Loaded ${trials.length} reviewed trial${trials.length === 1 ? "" : "s"} — continue this export alone, or reuse matching edits with a new upload.`;
      clearPreparedTrials("Previous export loaded. Load rows to continue it alone or combine it with a new source.");
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
      showCtgovSourcePanel();
      ctgovInput.value = value;
      ctgovInput.focus();
      ctgovInput.setSelectionRange(ctgovInput.value.length, ctgovInput.value.length);
      setCtgovRunHint("");
      setStatus("warn", `Example loaded into the field. Click <strong>Load</strong> when ready.`);
    };
    const trigger = async () => {
      showCtgovSourcePanel();
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
        clearPreparedTrials("CT.gov source ready. Load trial rows to review before processing.");
        setStatus("ok", `Loaded ${ids.length} stud${ids.length === 1 ? "y" : "ies"} from ClinicalTrials.gov.`);
        setCtgovRunHint(`CT.gov source ready: <strong>${ids.join(", ")}</strong>. Use <strong>Load Trial Rows</strong> above to review before processing.`);
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
      state.format = "spreadsheet";
      const headers = Object.keys(json[0]);
      const missing = spreadsheetMissingGroups(headers);
      if (missing.length) {
        setFormatBanner("warn", `Detected <strong>Excel</strong> with ${json.length} rows, but missing: <code>${missing.join(", ")}</code>. ${spreadsheetFormatHelpHtml()}`);
      } else {
        setFormatBanner("ok", `Detected <strong>Excel</strong> &middot; ${json.length} trial rows. ${spreadsheetFormatHelpHtml()}`);
      }
      return;
    }
    if (ext === "csv") {
      const text = await f.text();
      const wb = XLSX.read(text, { type: "string" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
      state.format = "spreadsheet";
      const missing = json.length ? spreadsheetMissingGroups(Object.keys(json[0])) : ["trial", "inclusion or exclusion"];
      if (missing.length) {
        setFormatBanner("warn", `Detected <strong>CSV</strong> with ${json.length} rows, but missing: <code>${missing.join(", ")}</code>. ${spreadsheetFormatHelpHtml()}`);
      } else {
        setFormatBanner("ok", `Detected <strong>CSV</strong> &middot; ${json.length} rows. ${spreadsheetFormatHelpHtml()}`);
      }
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
      if (parsed && parsed.format === TS_V1.FORMAT) {
        const count = Array.isArray(parsed.trials) ? parsed.trials.length : 0;
        state.format = "trialschema";
        setFormatBanner("ok", `Detected <strong>TrialSchema export</strong> &middot; ${count} processed trial${count === 1 ? "" : "s"}.`);
        return;
      }
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
                  : state.format === "trialschema" ? "TrialSchema JSON"
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
  "trial_id", "trial", "care_path", "inclusion", "exclusion",
  "active", "condition", "indication", "start_date", "completion_date",
];
const TEMPLATE_EXAMPLE_ROW = {
  trial_id: "EXAMPLE-01",
  trial: "Replace this row with your trial title",
  care_path: "breast_cancer",
  inclusion: "Histologically confirmed disease\nAge >= 18 years\nECOG 0-2",
  exclusion: "Distant metastases\nPregnancy or lactation",
  active: "true",
  condition: "Breast cancer",
  indication: "Locally advanced disease",
  start_date: "",
  completion_date: "",
};
const TEMPLATE_COLUMN_GUIDE = [
  { column: "trial", required: "yes", description: "Trial title or short name." },
  { column: "inclusion", required: "one of inclusion/exclusion", description: "Inclusion criteria. Put one criterion per line when possible." },
  { column: "exclusion", required: "one of inclusion/exclusion", description: "Exclusion criteria. Put one criterion per line when possible." },
  { column: "trial_id", required: "no", description: "Stable id such as NCT id or local study id." },
  { column: "care_path", required: "no", description: "Clinical-domain bucket or comma-separated buckets, e.g. breast_cancer." },
  { column: "active", required: "no", description: "true/false. Local TrialSchema matching switch; false means agents should skip the trial." },
  { column: "condition", required: "no", description: "ClinicalTrials.gov-style condition: primary condition, diagnosis, disorder, or focus of study." },
  { column: "indication", required: "no", description: "Specific indication or setting." },
  { column: "start_date", required: "no", description: "YYYY-MM-DD. Matching window open date; leave blank if unknown." },
  { column: "completion_date", required: "no", description: "YYYY-MM-DD. Matching window close date; leave blank if unknown." },
];

function downloadTemplate(kind) {
  if (kind === "xlsx" || kind === "csv") {
    const ws = XLSX.utils.json_to_sheet([TEMPLATE_EXAMPLE_ROW], { header: TEMPLATE_HEADERS });
    if (kind === "xlsx") {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Trials");
      const guide = XLSX.utils.json_to_sheet(TEMPLATE_COLUMN_GUIDE, { header: ["column", "required", "description"] });
      XLSX.utils.book_append_sheet(wb, guide, "Column guide");
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
        drugs: ["DrugX"],
        interventions: [{ type: "drug", label: "DrugX" }],
        conditions: ["Condition Y"],
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
  if (!state.newFile) {
    const prior = state.existingExport?.trials || [];
    return prior.map(t => ({ __raw: t, __sourceFormat: "trialschema", __structuredTrial: t }));
  }
  const f = state.newFile;
  const ext = f.name.toLowerCase().split(".").pop();
  if (ext === "xlsx" || ext === "xls") {
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
    json.forEach(r => rows.push({ __raw: normalizeSpreadsheetRow(r), __sourceFormat: "spreadsheet" }));
  } else if (ext === "csv") {
    const text = await f.text();
    const wb = XLSX.read(text, { type: "string" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
    json.forEach(r => rows.push({ __raw: normalizeSpreadsheetRow(r), __sourceFormat: "spreadsheet" }));
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
      if (j && j.format === TS_V1.FORMAT) {
        const env = fromV1Envelope(j);
        return (env?.trials || []).map(t => ({ __raw: t, __sourceFormat: "trialschema", __structuredTrial: t }));
      }
      let arr;
      if (Array.isArray(j)) arr = j;
      else if (Array.isArray(j.studies)) arr = j.studies;
      else if (j.protocolSection) arr = [j];
      else arr = j.trials || j.data || [];
      if (arr.length && arr[0]?.kind === "trial" && "criteria" in arr[0]) {
        return arr.map(fromV1Trial).map(t => ({ __raw: t, __sourceFormat: "trialschema", __structuredTrial: t }));
      }
      return arr.map(wrapRaw);
    } catch { return []; }
  }
  if (ext === "csv") {
    const wb = XLSX.read(text, { type: "string" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval: "" })
      .map(r => ({ __raw: normalizeSpreadsheetRow(r), __sourceFormat: "spreadsheet" }));
  }
  return [];
}

function wrapRaw(obj) {
  return { __raw: obj, __sourceFormat: state.format };
}

// Pull the "best guess" trial id and brief title for display before LLM runs.
function previewIdAndTitle(raw) {
  if (state.format === "spreadsheet" || raw.__sourceFormat === "spreadsheet") {
    const r = raw.__raw || {};
    return {
      id: r.trial_id || r.trial || cryptoSlug(JSON.stringify(r).slice(0, 80)),
      title: r.trial || "(Untitled trial)",
    meta: [r.condition, r.indication].filter(Boolean).join(" • "),
    };
  }
  if (state.format === "ctgov" || raw.__sourceFormat === "ctgov") {
    const ps = raw.__raw?.protocolSection || {};
    const idm = ps.identificationModule || {};
    const sm  = ps.statusModule || {};
    const cm  = ps.conditionsModule || {};
    return {
      id: idm.nctId || cryptoSlug(JSON.stringify(raw.__raw).slice(0, 80)),
      title: idm.briefTitle || idm.officialTitle || "(CT.gov trial)",
      meta: [
        (cm.conditions || [])[0],
      ].filter(Boolean).join(" • "),
    };
  }
  const r = raw.__raw || {};
  const m = r.metadata || {};
  return {
    id: r._id || r.trial_id || r.NCTId || cryptoSlug(JSON.stringify(r).slice(0, 80)),
    title: r.title || m.brief_title || "(Untitled trial)",
    meta: [(m.conditions || []).join?.(", ")].filter(Boolean).join(" • "),
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
    const direct = row.__structuredTrial
      ? sanitizeTrial(JSON.parse(JSON.stringify(row.__structuredTrial)))
      : null;
    const reused = direct || (state.existingById[id]
      ? applySpreadsheetSourceFields(sanitizeTrial(JSON.parse(JSON.stringify(state.existingById[id]))), row)
      : null);
    const enabledHint = row.__sourceFormat === "spreadsheet" ? parseTrialEnabled(row.__raw?.active) : null;
    return {
      idx: i,
      preview: { id, title, meta },
      raw: row,
      status: reused ? "reused" : "pending",
      result: reused || null,
      error: null,
      userEnabled: enabledHint,
    };
  });
}


/* ============================ 6. OPENAI REQUEST ============================ */

function routingProfilePromptBlock() {
  const docs = matrixDocs();
  const defaultScan = new Set(defaultScanDocIds());
  const guidance = docs.map((d, i) =>
    `  ${i + 1}. "${d.id}"${defaultScan.has(d.id) ? " [default-scan]" : ""} - ${d.label}: ${d.hint || "No additional hint."}`
  ).join("\n");
  return [
    `Routing profile: ${state.routingProfile.id} - ${state.routingProfile.label}`,
    "Use ONLY these document IDs, shown in the user's general visit order:",
    guidance,
    `Default scan set for most criteria: ${defaultScanDocIds().map(id => `"${id}"`).join(", ")}`,
  ].join("\n");
}

// Care-path enum context for the per-trial extractor. Empty string when no enum
// has been detected yet (the panel auto-fills before/while processing).
function carePathPromptBlock() {
  if (!state.carePaths.length) return "";
  const lines = state.carePaths.map(cp => {
    const aliases = (cp.aliases || []).slice(0, 12).join(", ");
    return `  - "${cp.id}" (${cp.label})${aliases ? ` — aliases: ${aliases}` : ""}`;
  }).join("\n");
  return [
    "Active normalized CARE PATH enum (clinical-domain buckets for downstream patient matching):",
    lines,
  ].join("\n");
}

function buildSystemPrompt() {
  const docIds = currentDocIds();
  const scanIds = defaultScanDocIds();
  const categoryList = docIds.map(id => `"${id}"`).join(", ");
  const categoryShape = docIds.join(" | ");
  return `You are TrialSchema-Extractor, a clinical-trial structuring engine.
You receive ONE raw clinical trial row from ANY field of medicine (oncology,
cardiology, neurology, endocrinology, infectious disease, rare disease, etc.)
and return a SINGLE JSON object that strictly matches the TrialSchema execution
model. You must obey ALL of the following rules:

RULE 1 - CATEGORY-SPECIFIC DOCUMENT ROUTING.
Map each criterion to clinically appropriate document domains. Never produce blind
checklists. The end user has configured the active document universe and default
agent visit order below:
${routingProfilePromptBlock()}
Populate routing.primary_docs with at most ${Math.max(scanIds.length, 1)} best-fit document IDs. For most criteria,
use the default scan set exactly. Replace one of those defaults only when the criterion
clearly needs a more specific configured document type. Populate routing.fallback_docs
only for optional secondary routes. Do not use document IDs outside the active profile.

RULE 2 - CRITERIA EXPLICIT ENRICHMENT (DOWNSTREAM AI OPTIMIZATION).
For any criterion containing a numeric/quantitative comparison (e.g. "HbA1c >= 7.0 %",
"LVEF < 40 %", "intact-PTH <= 240 pg/mL", "age > 15 years", "GFR >= 50 ml/min",
"WBC >= 3.0", "ECOG 0-2", "systolic BP >= 140 mmHg"), set:
  evaluation_type: "quantitative"
  structured_target: { metric, standard_code, operator, value, unit }
where:
  - metric: the exact parameter name as written (e.g. "HbA1c", "LVEF", "intact-PTH", "age", "GFR", "ECOG").
  - standard_code: BEST-EFFORT ontology code, prefixed by terminology, e.g.
                     LOINC:4548-4 (HbA1c), LOINC:2160-0 (creatinine), LOINC:2164-2 (creatinine clearance),
                     LOINC:30525-0 (age), LOINC:8480-6 (systolic BP), LOINC:33747-0 (Karnofsky),
                     SNOMED:271649006 (systolic BP), SNOMED:254837009 (breast cancer),
                     RXNORM:1601480 (palbociclib), HGNC:3430 (ERBB2/HER2),
                     ICD10:C50.9 (breast cancer NOS).
                   Set "" when not confident. End users do NOT verify these codes by hand;
                   the downstream matcher treats them as hints, not contracts.
  - operator: one of "<", "<=", ">", ">=", "=", "!=", "between".
  - value: numeric. For "between" use the lower bound and add upper_value.
  - unit: explicit unit string aligned to UCUM where possible (e.g. "%", "pg/mL",
                   "years", "mL/min", "mmHg", "mg/dL"). Use "" when unitless.
For purely categorical / boolean criteria (consent, pregnancy, prior radiotherapy yes/no,
NYHA class assignment, presence-of-condition flags), set evaluation_type: "boolean" and
OMIT structured_target (or set it to null).
The downstream matching agent must be able to execute mathematical evaluation
WITHOUT re-reading the original_text.

RULE 3 - CROSS-LINGUAL TRANSLATION & STANDARDIZATION.
If the input contains any non-English clinical text, interpret it natively but translate
ALL output strings (criteria text, conditions, descriptions) cleanly into
English. Preserve clinical precision.

RULE 4 - MATCHING WINDOW DATE NORMALIZATION.
lifecycle_dates.start_date and lifecycle_dates.completion_date represent the trial's
matching window. Use "YYYY-MM-DD" or "" and never invent dates. Do not output a
trial status field; future planning is handled by dates, not a binary status.

RULE 5 - CRITERION CATEGORY (CLOSED VOCABULARY).
The "category" field on every criterion MUST be exactly ONE of these lower-case tokens:
  ${categoryList}
Pick the SAME id as the criterion's primary document domain. Use "other" ONLY when the
criterion truly does not fit any configured document type (e.g. consent, willingness,
contraception requirements, study-logistics rules), or when the active profile label/hint
for "other" says that is appropriate.

RULE 6 - DAG FUNNEL PRIORITY (CHEAPEST TO MOST COMPLEX).
Set "priority_level" so the downstream pipeline can short-circuit on the cheapest
deterministic checks first. Use this funnel:
  1 - Structured EHR knock-outs: demographics, gender, diagnosis flags, structured lab values.
  2 - High-yield unstructured tier: biomarkers, staging, histology, molecular profile, organ-specific imaging.
  3 - Complex timeline / cross-document tier: prior therapies, washout windows, line-of-therapy ordering, board decisions.
  4 - "other" / soft criteria: consent, willingness, logistics.
  5 - Reserved for unranked or trivially redundant items.
Use the active routing profile's general visit order as a tie-breaker inside each tier.

RULE 7 - NORMALIZED CARE PATHS (CLINICAL-DOMAIN BUCKETS).
A trial may belong to ONE OR MORE normalized care paths (clinical-domain buckets used
downstream for patient matching, e.g. breast_cancer, heart_failure, type_2_diabetes).
This is a first-pass matching filter: downstream agents should evaluate the trial's criteria
only when the patient care path matches at least one returned care_path_id.
${state.carePaths.length
  ? `Choose care_path_ids ONLY from the active enum below, using the snake_case ids exactly as shown.
Match across languages and synonyms (Dutch "borst"/"mamma" -> breast_cancer, "hartfalen" -> heart_failure).
Return ALL that genuinely apply (most trials map to exactly one; combination / multi-domain trials may
list several). Return [] when none of the enum entries fit.
${carePathPromptBlock()}`
  : `No care-path enum is configured yet, so return care_path_ids as an empty array [].`}

RULE 8 - TRIAL SCOPE VS ELIGIBILITY CRITERIA.
Conditions, interventions/drugs, and care_path_ids describe what the trial is about.
Put them in metadata / care_path_ids as trial-level scope. Do NOT create an inclusion or exclusion
criterion merely because a condition or drug appears in the title, condition list, arm list, or care-path
hint. Create a criterion only when the eligibility text says a patient must have, must not have, must
previously have received, or must avoid that condition/intervention.

OUTPUT SHAPE - return EXACTLY this JSON structure (no extra keys, no commentary):
{
  "trial_id": "string",
  "enabled": true,
  "metadata": {
    "brief_title": "string",
    "drugs": ["string"],
    "interventions": [{ "type": "drug|device|procedure|biological|behavioral|radiation|diagnostic-test|other", "label": "string" }],
    "conditions": ["string"],
    "lifecycle_dates": {
      "start_date": "",
      "completion_date": ""
    }
  },
  "care_path_ids": [],
  "criteria": [
    {
      "criterion_id": "INC-01",
      "type": "inclusion",
      "original_text": "string",
      "category": "${categoryShape}",
      "priority_level": 1,
      "status": "active",
      "routing": { "primary_docs": ${JSON.stringify(scanIds.length ? scanIds : [docIds[0] || "other"])}, "fallback_docs": [] },
      "evaluation_type": "boolean",
      "structured_target": {
        "metric": "string (e.g., HbA1c or age)",
        "standard_code": "string (Optional: LOINC, SNOMED-CT, or ICD-10 code; empty string if unsure)",
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
care_path_ids is the normalized clinical-domain bucket assignment (Rule 7) — an array of enum
ids; [] when no enum entry applies.
Return ONLY the JSON object - no markdown fences, no explanations.`;
}

// Build the per-trial user prompt depending on the source format.
function buildUserPrompt(raw) {
  const sf = raw.__sourceFormat;
  if (sf === "spreadsheet") {
    return [
      "SOURCE FORMAT: English spreadsheet row.",
      "Minimum expected fields are `trial` plus at least one of `inclusion` or `exclusion`.",
      "Optional fields include `trial_id`, `care_path`, `active`, `condition`, `indication`, `start_date`, and `completion_date`.",
      "Use `trial_id` when present; otherwise derive trial_id from `trial`.",
      "Use `active` as the local TrialSchema matching switch. true/active means enabled=true; false/inactive means enabled=false.",
      "Use `start_date` and `completion_date` as matching-window dates only when provided; leave missing dates as empty strings.",
      "If `care_path` is present, use it as a strong hint for care_path_ids.",
      "Parse one Criterion per line/bullet from `inclusion` and `exclusion`.",
      "Normalized row:",
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
function buildCtgovPrompt(study) {
  const ps  = study?.protocolSection || {};
  const idm = ps.identificationModule || {};
  const sm  = ps.statusModule || {};
  const cm  = ps.conditionsModule || {};
  const aim = ps.armsInterventionsModule || {};
  const elm = ps.eligibilityModule || {};

  const interventions = (aim.interventions || []).map(iv => ({
    type: (iv.type || "").toLowerCase(), // drug | device | procedure | behavioral | ...
    name: iv.name,
  }));

  const preExtracted = {
    trial_id: idm.nctId || "",
    metadata: {
      brief_title:        idm.briefTitle || "",
      official_title:     idm.officialTitle || "",
      conditions:         cm.conditions || [],
      drugs:              interventions.filter(i => i.type === "drug").map(i => i.name),
      interventions,
      lifecycle_dates: {
        start_date:      sm.startDateStruct?.date || "",
        completion_date: sm.completionDateStruct?.date || "",
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
    "Your job is to produce the structured `criteria` array by parsing the eligibility text.",
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
  const systemPrompt = buildSystemPrompt();
  const body = {
    model: state.model,
    // dangerouslyAllowBrowser is an SDK-level flag; the raw fetch endpoint accepts
    // browser calls directly. We add it as a header hint for clarity.
    // Note: temperature is intentionally omitted — several newer OpenAI models
    // (gpt-5.x and reasoning variants) only accept the default value.
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
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

function applySpreadsheetSourceFields(trial, raw) {
  if (!trial || raw?.__sourceFormat !== "spreadsheet") return trial;
  const row = raw.__raw || {};
  trial.metadata = trial.metadata || {};
  const m = trial.metadata;
  if (!m.brief_title && row.trial) m.brief_title = row.trial;
  const condition = [row.condition, row.indication].map(s => String(s || "").trim()).filter(Boolean);
  if (condition.length && !(m.conditions || []).length) m.conditions = condition;

  const enabled = parseTrialEnabled(row.active);
  if (enabled !== null) trial.enabled = enabled;
  m.lifecycle_dates = m.lifecycle_dates || {};
  m.lifecycle_dates.start_date = isoDate(row.start_date);
  m.lifecycle_dates.completion_date = isoDate(row.completion_date);
  return trial;
}

// Normalize/repair LLM output so the rest of the app can rely on shape.
function sanitizeTrial(t) {
  if (!t || typeof t !== "object") t = {};
  t.trial_id = String(t.trial_id || cryptoSlug(JSON.stringify(t).slice(0, 64)));
  t.enabled = t.enabled === false ? false : true;
  t.metadata = t.metadata || {};
  const m = t.metadata;
  m.brief_title = String(m.brief_title || "");
  m.drugs = Array.isArray(m.drugs) ? m.drugs.map(String) : [];
  m.interventions = normalizeMetadataInterventions(m);
  m.conditions = Array.isArray(m.conditions) ? m.conditions.map(String) : [];
  m.lifecycle_dates = m.lifecycle_dates || {};
  m.lifecycle_dates.start_date = isoDate(m.lifecycle_dates.start_date);
  m.lifecycle_dates.completion_date = isoDate(m.lifecycle_dates.completion_date);

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
  // Care-path enum assignment (ids from state.carePaths). A trial may belong to
  // MULTIPLE normalized care paths. Keeps only ids that exist in the active enum
  // (or all provided ids when the enum is still empty, so nothing is lost before
  // detection runs).
  t.care_path_ids = normalizeCarePathIds(Array.isArray(t.care_path_ids) ? t.care_path_ids : []);
  // Edit-state provenance. Tracks whether the trial was produced/updated by AI
  // and whether a human hand-edited it in the workspace. Persisted on export
  // and restored on import so manual work is never lost or repeated.
  t.edit_state = normalizeEditState(t.edit_state);
  return t;
}

// Normalize an edit-state record. Accepts partial shapes and always returns
// the full { ai, manual, ai_at, manual_at, ai_by } structure.
function normalizeEditState(s) {
  s = (s && typeof s === "object") ? s : {};
  return {
    ai: !!s.ai,
    manual: !!s.manual,
    ai_at: typeof s.ai_at === "string" ? s.ai_at : "",
    manual_at: typeof s.manual_at === "string" ? s.manual_at : "",
    ai_by: typeof s.ai_by === "string" ? s.ai_by : "",
  };
}

// Mark a trial as produced/updated by AI (fresh extraction or pasted JSON).
function markTrialAI(trial, by) {
  if (!trial) return;
  trial.edit_state = normalizeEditState(trial.edit_state);
  trial.edit_state.ai = true;
  trial.edit_state.ai_at = new Date().toISOString();
  if (by) trial.edit_state.ai_by = String(by);
  refreshTrialProvenance(trial);
}

// Mark a trial as hand-edited by the user and refresh its overview badges.
// Call from every manual-edit handler in the workspace so the provenance
// indicator and the "edited" counter stay accurate.
function markTrialEdited(trial) {
  if (!trial) return;
  trial.edit_state = normalizeEditState(trial.edit_state);
  if (!trial.edit_state.manual) {
    trial.edit_state.manual = true;
  }
  trial.edit_state.manual_at = new Date().toISOString();
  refreshTrialProvenance(trial);
}

// Repaint the per-row provenance pills + the top "edited" stat for a trial
// without re-rendering its whole card. No-op if the row isn't mounted yet.
function refreshTrialProvenance(trial) {
  if (!trial || !Array.isArray(trialItems)) return;
  const idx = trialItems.findIndex(it => it.result === trial);
  if (idx >= 0) {
    const list = document.getElementById("trialsList");
    const prov = list?.querySelector(`details[data-idx="${idx}"] [data-prov]`);
    if (prov) prov.innerHTML = provenancePillsHtml(trial.edit_state);
  }
  updateEditedStat();
}

// Small inline pills shown in each trial row summarising who touched it.
function provenancePillsHtml(es) {
  es = normalizeEditState(es);
  const pills = [];
  if (es.ai) {
    pills.push(`<span class="badge bg-violet-50 text-violet-700" title="Structured by AI${es.ai_by ? ` (${escapeHtml(es.ai_by)})` : ""}">AI</span>`);
  }
  if (es.manual) {
    pills.push(`<span class="badge bg-indigo-50 text-indigo-700" title="Includes manual edits — preserved when you resume from an export">Edited</span>`);
  }
  return pills.join("");
}

// Recount trials carrying manual edits and update the overview stat.
function updateEditedStat() {
  const el = document.getElementById("statEdited");
  if (!el || !Array.isArray(trialItems)) return;
  const n = trialItems.filter(it => it.result?.edit_state?.manual).length;
  el.textContent = String(n);
}

function sanitizeCriterion(c, i) {
  c = c || {};
  const type = c.type === "exclusion" ? "exclusion" : "inclusion";
  const prefix = type === "exclusion" ? "EXC" : "INC";
  // Closed category vocabulary: current routing-profile document ids.
  const rawCat = coerceDocIdToProfile(c.category);
  const category = rawCat || (isKnownDocId("other") ? "other" : (currentDocIds()[0] || "other"));
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
      primary_docs:  Array.isArray(c.routing?.primary_docs)  ? c.routing.primary_docs.map(coerceDocIdToProfile).filter(Boolean)  : [],
      fallback_docs: Array.isArray(c.routing?.fallback_docs) ? c.routing.fallback_docs.map(coerceDocIdToProfile).filter(Boolean) : [],
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

  // Profile-aware fallback rule: preserve model/user routing when present. If
  // missing, seed the primary routes from the profile's default scan set. The
  // default scan set is the max primary-doc visit set for most criteria.
  const llmPrimary = out.routing.primary_docs.slice();
  const llmFallback = out.routing.fallback_docs.slice();
  const defaultScan = defaultScanDocIds();
  // Primary-doc cap follows the user-defined default scan set (min 3).
  const primaryCap = Math.max(defaultScan.length, 3);
  const inferred = inferBestProfileDoc(out);
  let primarySeed;
  if (llmPrimary.length) {
    primarySeed = llmPrimary.slice(0, primaryCap);
  } else {
    const specific = [category, inferred].find(d => d && d !== "other" && isKnownDocId(d));
    primarySeed = specific && !defaultScan.includes(specific)
      ? [specific, ...defaultScan].slice(0, primaryCap)
      : defaultScan.slice();
  }
  // When the criterion is itself an "other / soft" rule (consent, willingness,
  // logistics…) auto-mark the Other chip as primary so the free-text guidance
  // textarea is surfaced. Same when the criterion carries an `other_active`
  // flag or existing guidance text.
  const isOther = out.category === "other"
    || c.other_active === true
    || (typeof c.guidance === "string" && c.guidance.trim() !== "");
  if (isOther) primarySeed = ["other", ...primarySeed.filter(d => d !== "other")].slice(0, primaryCap);
  const primarySet = new Set(primarySeed);
  out.routing.primary_docs = Array.from(primarySet).filter(d => isKnownDocId(d));
  // Fallbacks = LLM-suggested + primary suggestions beyond the default cap.
  const fbSet = new Set([...llmFallback, ...llmPrimary.slice(3)]);
  out.routing.primary_docs.forEach(d => fbSet.delete(d));
  out.routing.fallback_docs = Array.from(fbSet).filter(d => isKnownDocId(d));
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

async function prepareQueue() {
  state.abort = false;
  saveRoutingProfile();
  renderRoutingProfileEditor();

  setProgress(0, "Reading raw rows...");
  let rawRows = [];
  try { rawRows = await gatherRawRows(); }
  catch (e) { setProgress(0, `Read error: ${e.message}`); return false; }

  if (!rawRows.length) {
    setProgress(0, "No rows found. Upload a trial source file in the sidebar.");
    return false;
  }

  rawRows.forEach(r => { if (!r.__sourceFormat) r.__sourceFormat = state.format; });
  rawRows = rawRows.slice(0, state.maxTrials);
  state.rawRows = rawRows;
  ensureCarePathsFromRawRows(rawRows);

  const items = classifyRows(rawRows);
  state.results = items.map(it => it.result);
  state.resultsById = {};
  items.forEach(it => { if (it.result) state.resultsById[it.preview.id] = it.result; });

  renderTrials(items);
  updateStats(items);
  document.getElementById("exportBtn").disabled = false;
  renderCarePathsPanel();

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
    setProgress(100, "Rows loaded. Manual mode — expand a trial to copy its prompt and paste back JSON.");
  } else {
    if (manualBanner) manualBanner.classList.add("hidden");
    const nextStep = state.processMode === "all" ? "Run all pending trials when ready." : "Process one trial or switch to Batch.";
    setProgress(100, `Loaded ${items.length} trial row${items.length === 1 ? "" : "s"}. ${nextStep}`);
  }
  updateProcessButtonLabel();
  updateWorkflowGuide();
  focusTrialsList();
  return true;
}

async function ensureCarePathsDetected() {
  if (!state.apiKey || state.carePaths.length) return;
  setProgress(0, "Detecting care paths from sample...");
  try { await detectCarePathsFromSample({ silent: true }); } catch {}
}

function processableTrialIndexes() {
  return trialItems
    .map((it, i) => ["pending", "manual", "error"].includes(it.status) ? i : -1)
    .filter(i => i >= 0);
}

async function processTrialAtIndex(i, processed, total) {
  const it = trialItems[i];
  if (!it || !["pending", "manual", "error"].includes(it.status)) return false;
  const rawCarePathIds = carePathIdsFromRaw(it.raw);
  it.status = "processing";
  it.error = "";
  it.progressLabel = "Calling model";
  renderRow(it, i);
  focusTrialRow(i);
  setProgress(
    Math.round(processed / Math.max(1, total) * 100),
    `Processing ${it.preview.id} (${processed + 1}/${total})...`
  );
  try {
    const result = await callOpenAI(it.raw);
    it.progressLabel = "Finalizing";
    renderRow(it, i);
    applySpreadsheetSourceFields(result, it.raw);
    if (!result.trial_id || result.trial_id === "string") result.trial_id = it.preview.id;
    if (typeof it.userEnabled === "boolean") result.enabled = it.userEnabled;
    markTrialAI(result, `openai/${state.model}`);
    it.result = result;
    it.status = "done";
    state.results[i] = result;
    state.resultsById[result.trial_id] = result;
    let inferred = inferCarePathIds(result);
    const conditionCarePathIds = (!rawCarePathIds.length && !inferred.length) ? ensureCarePathsFromTrial(result) : [];
    if (conditionCarePathIds.length) inferred = inferCarePathIds(result);
    result.care_path_ids = normalizeCarePathIds([
      ...(result.care_path_ids || []),
      ...rawCarePathIds,
      ...conditionCarePathIds,
      ...inferred,
    ]);
  } catch (e) {
    it.error = e.message;
    it.status = "error";
    it.progressLabel = "";
  }
  if (it.status !== "error") it.progressLabel = "";
  renderRow(it, i);
  focusTrialRow(i);
  updateStats(trialItems);
  renderCarePathsPanel();
  updateWorkflowGuide();
  return true;
}

async function processTrialIndexes(indexes, labelMode = "batch") {
  if (state.running) return;
  if (!trialItems.length) {
    const prepared = await prepareQueue();
    if (!prepared) return;
  }

  const idxs = indexes.filter(i => trialItems[i] && ["pending", "manual", "error"].includes(trialItems[i].status));
  if (!idxs.length) {
    setProgress(100, "No pending trials to process.");
    updateProcessButtonLabel();
    return;
  }

  const manualBanner = document.getElementById("manualBanner");
  if (!state.apiKey) {
    idxs.forEach(i => {
      trialItems[i].status = "manual";
      renderRow(trialItems[i], i);
    });
    if (manualBanner) manualBanner.classList.remove("hidden");
    updateStats(trialItems);
    setProgress(100, "Manual mode — expand a trial to copy its prompt and paste back JSON.");
    updateProcessButtonLabel();
    return;
  }
  if (manualBanner) manualBanner.classList.add("hidden");

  state.abort = false;
  state.running = true;
  document.getElementById("processBtn").disabled = true;
  document.getElementById("stopBtn").classList.remove("hidden");
  updateProcessButtonLabel();

  try {
    await ensureCarePathsDetected();
    let processed = 0;
    for (const i of idxs) {
      if (state.abort) break;
      await processTrialAtIndex(i, processed, idxs.length);
      processed++;
      if (!state.abort && processed < idxs.length) await sleep(state.throttleMs);
    }
  } finally {
    state.running = false;
    document.getElementById("processBtn").disabled = false;
    document.getElementById("stopBtn").classList.add("hidden");
    renderCarePathsPanel();
    const remaining = processableTrialIndexes().length;
    const doneLabel = labelMode === "single"
      ? (remaining ? `Processed one trial. ${remaining} still pending.` : "All prepared trials processed.")
      : (remaining ? `Processed selected trials. ${remaining} still pending.` : "Pipeline complete.");
    setProgress(100, state.abort ? "Stopped." : doneLabel);
    updateProcessButtonLabel();
    trialItems.forEach((it, i) => renderRow(it, i));
  }
}

async function runQueue() {
  if (state.running) return;
  if (!trialItems.length) {
    const prepared = await prepareQueue();
    if (!prepared || state.processMode === "single") return;
  }

  const pending = processableTrialIndexes();
  const idxs = state.processMode === "single" ? pending.slice(0, 1) : pending;
  await processTrialIndexes(idxs, state.processMode === "single" ? "single" : "batch");
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

function updateProcessModeUi() {
  document.querySelectorAll("[data-process-mode]").forEach(btn => {
    const active = btn.dataset.processMode === state.processMode;
    btn.className = "process-mode-btn rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition " + (
      active
        ? "bg-white text-slate-900 shadow-sm"
        : "text-slate-500 hover:text-slate-800"
    );
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function updateProcessButtonLabel() {
  const label = document.getElementById("processBtnLabel");
  const btn = document.getElementById("processBtn");
  if (!label || !btn) return;
  if (state.running) {
    label.textContent = "Processing...";
    btn.disabled = true;
  } else if (!trialItems.length) {
    label.textContent = "Load Trial Rows";
    btn.disabled = false;
  } else if (state.processMode === "single") {
    label.textContent = "Process Next Trial";
    btn.disabled = false;
  } else {
    label.textContent = "Run All Pending Trials";
    btn.disabled = false;
  }
  updateProcessModeUi();
  updateWorkflowGuide();
}

function updateWorkflowGuide() {
  const steps = document.querySelectorAll("[data-workflow-step]");
  if (!steps.length) return;
  const pending = trialItems.length ? processableTrialIndexes().length : 0;
  const done = trialItems.filter(it => it.status === "done" || it.status === "reused").length;
  const hasSource = !!state.newFile || !!state.existingExport;
  const states = {
    source: hasSource ? ["done", state.newFile ? "source ready" : "export ready"] : ["active", "choose source"],
    setup: ["optional", "ready"],
    rows: trialItems.length ? ["done", `${trialItems.length} loaded`] : (hasSource ? ["active", "load rows"] : ["pending", "waiting"]),
    process: trialItems.length
      ? (pending ? ["active", `${pending} pending`] : ["done", `${done} complete`])
      : ["pending", "trial"],
  };
  steps.forEach(step => {
    const [status, label] = states[step.dataset.workflowStep] || ["pending", ""];
    step.className = "rounded-lg border px-2 py-1.5 " + (
      status === "done"
        ? "border-emerald-200 bg-emerald-50"
        : status === "active"
          ? "border-slate-900 bg-white shadow-sm"
          : status === "optional"
            ? "border-slate-200 bg-white"
            : "border-slate-200 bg-slate-50"
    );
    const title = step.querySelector(".font-bold");
    if (title) title.className = "font-bold " + (status === "done" ? "text-emerald-800" : status === "active" ? "text-slate-900" : "text-slate-600");
    const labelEl = step.querySelector("[data-workflow-label]");
    if (labelEl) {
      labelEl.textContent = label;
      labelEl.className = "mt-0.5 truncate " + (status === "done" ? "text-emerald-700" : status === "active" ? "text-slate-600" : "text-slate-400");
    }
  });
}

function focusTrialsList() {
  const section = document.getElementById("trialsSection");
  if (!section) return;
  setTimeout(() => section.scrollIntoView({ behavior: "smooth", block: "start" }), 40);
}

function focusTrialRow(i) {
  const list = document.getElementById("trialsList");
  const root = list?.querySelector(`details[data-idx="${i}"]`);
  if (!root) return;
  root.open = true;
  const item = trialItems[i];
  if (item) renderBody(root.querySelector("[data-body]"), item, i);
  setTimeout(() => root.scrollIntoView({ behavior: "smooth", block: "center" }), 40);
}

function clearPreparedTrials(message = "Source ready. Load trial rows to review before processing.") {
  trialItems.length = 0;
  state.rawRows = [];
  state.results = [];
  state.resultsById = {};
  const list = document.getElementById("trialsList");
  if (list) list.innerHTML = `<div class="p-8 text-sm text-slate-500 text-center">No trials loaded.</div>`;
  const exportBtn = document.getElementById("exportBtn");
  if (exportBtn) exportBtn.disabled = true;
  updateStats([]);
  setProgress(0, message);
  updateProcessButtonLabel();
  updateWorkflowGuide();
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
  const edited = items.filter(i => i.result?.edit_state?.manual).length;
  const editedEl = document.getElementById("statEdited");
  if (editedEl) editedEl.textContent = edited;
}

function statusBadge(status) {
  const map = {
    pending:    ["bg-slate-100 text-slate-600", "Pending"],
    processing: ["bg-blue-100 text-blue-700", `<span class="ts-spinner h-3 w-3 rounded-full border-2 border-blue-200 border-t-blue-700"></span> Processing`],
    done:       ["bg-emerald-100 text-emerald-700", "Done"],
    reused:     ["bg-amber-100 text-amber-700", "Reused"],
    manual:     ["bg-indigo-100 text-indigo-700", "Manual"],
    error:      ["bg-rose-100 text-rose-700", "Error"],
  };
  const [cls, label] = map[status] || map.pending;
  return `<span class="badge ${cls}">${label}</span>`;
}

const trialItems = []; // mirrors items array for re-rendering

// --------------------------- Routing Profile ---------------------------
function loadRoutingProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROUTING_PROFILE_STORAGE) || "null");
    state.routingProfile = normalizeRoutingProfile(saved || DEFAULT_ROUTING_PROFILE);
  } catch {
    state.routingProfile = normalizeRoutingProfile(DEFAULT_ROUTING_PROFILE);
  }
}

function saveRoutingProfile() {
  state.routingProfile = normalizeRoutingProfile(state.routingProfile);
  try { localStorage.setItem(ROUTING_PROFILE_STORAGE, JSON.stringify(state.routingProfile)); } catch {}
}

function routingProfileStatus(message) {
  const el = document.getElementById("routingProfileStatus");
  if (!el) return;
  const scanCount = defaultScanDocIds().length;
  el.textContent = message || `${matrixDocs().length} document types. ${scanCount} marked as the default scan set for most criteria.`;
}

function uniqueRoutingDocId(base, exceptId = "") {
  const taken = new Set(currentDocIds().filter(id => id !== exceptId));
  let id = normalizeDocId(base), n = 2;
  while (taken.has(id)) id = `${normalizeDocId(base)}_${n++}`;
  return id;
}

function remapCriterionDocId(criterion, oldId, newId) {
  if (!criterion) return;
  if (criterion.category === oldId) criterion.category = newId;
  ["primary_docs", "fallback_docs"].forEach(key => {
    const arr = criterion.routing?.[key];
    if (!Array.isArray(arr)) return;
    criterion.routing[key] = [...new Set(arr.map(id => id === oldId ? newId : id))];
  });
}

function renameRoutingDocId(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  const scan = state.routingProfile?.default_scan_set;
  if (Array.isArray(scan)) {
    state.routingProfile.default_scan_set = scan.map(id => (id === oldId ? newId : id));
  }
  const allTrials = [
    ...(state.results || []),
    ...Object.values(state.resultsById || {}),
    ...Object.values(state.existingById || {}),
  ];
  allTrials.forEach(t => (t?.criteria || []).forEach(c => remapCriterionDocId(c, oldId, newId)));
}

function removeRoutingDocId(id) {
  const scan = state.routingProfile?.default_scan_set;
  if (Array.isArray(scan)) {
    state.routingProfile.default_scan_set = scan.filter(d => d !== id);
  }
  const allTrials = [
    ...(state.results || []),
    ...Object.values(state.resultsById || {}),
    ...Object.values(state.existingById || {}),
  ];
  allTrials.forEach(t => (t?.criteria || []).forEach(c => {
    if (c.category === id) c.category = isKnownDocId("other") ? "other" : (currentDocIds()[0] || "other");
    if (c.routing) {
      c.routing.primary_docs = (c.routing.primary_docs || []).filter(d => d !== id);
      c.routing.fallback_docs = (c.routing.fallback_docs || []).filter(d => d !== id);
    }
  }));
}

function refreshRoutingDependentUi() {
  saveRoutingProfile();
  renderRoutingProfileEditor();
  trialItems.forEach((it, i) => { if (it.result) renderRow(it, i); });
}

function renderRoutingProfileEditor() {
  const host = document.getElementById("routingProfileList");
  if (!host) return;
  const docs = matrixDocs();
  if (!docs.length) {
    host.innerHTML = `<div class="text-xs text-slate-500 italic p-3 border border-dashed border-slate-200 rounded-lg text-center">No document types configured.</div>`;
    routingProfileStatus();
    return;
  }
  if (!state.selectedRoutingDocId || !docs.some(d => d.id === state.selectedRoutingDocId)) {
    state.selectedRoutingDocId = docs[0].id;
  }
  const selected = docs.find(d => d.id === state.selectedRoutingDocId) || docs[0];
  const selectedIdx = docs.findIndex(d => d.id === selected.id);
  host.innerHTML = `
    <div class="overflow-x-auto pb-2">
      <div class="flex gap-2 min-w-max" data-routing-strip>
        ${docs.map((d, i) => {
          const active = d.id === selected.id;
          const inDefaultScan = isDefaultScanDocId(d.id);
          return `
            <button type="button" data-routing-doc="${escapeHtml(d.id)}"
              draggable="true"
              class="w-36 text-left rounded-lg border px-2.5 py-2 transition ${active ? "bg-slate-900 text-white border-slate-900 shadow-sm" : "bg-white text-slate-700 border-slate-200 hover:border-slate-400"}">
              <div class="flex items-center justify-between gap-2">
                <span class="w-6 h-6 grid place-items-center rounded-full text-[10px] font-bold ${active ? "bg-white/15 text-white" : "bg-slate-100 text-slate-600"}">${i + 1}</span>
                <span class="text-[10px] font-mono truncate ${active ? "text-white/70" : "text-slate-400"}">${escapeHtml(d.id)}</span>
              </div>
              <div class="mt-2 text-[13px] font-semibold truncate">${escapeHtml(d.short || d.label)}</div>
              <div class="mt-0.5 text-[10px] truncate ${active ? "text-white/65" : "text-slate-500"}">${escapeHtml(d.label)}</div>
              ${inDefaultScan ? `<div class="mt-1 text-[9px] font-semibold uppercase tracking-wider ${active ? "text-white/65" : "text-emerald-700"}">default scan</div>` : ""}
            </button>
          `;
        }).join("")}
      </div>
    </div>

    <div class="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3" data-routing-details="${escapeHtml(selected.id)}">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div class="text-[10px] uppercase tracking-wider font-semibold text-slate-500">Selected document type</div>
          <div class="mt-0.5 flex items-center gap-2">
            <span class="w-7 h-7 grid place-items-center rounded-full bg-white border border-slate-200 text-[11px] font-bold text-slate-600">${selectedIdx + 1}</span>
            <span class="text-sm font-semibold text-slate-900">${escapeHtml(selected.label)}</span>
            <span class="text-[10px] font-mono text-slate-400">${escapeHtml(selected.id)}</span>
          </div>
        </div>
        <div class="flex items-center gap-1.5">
          <button type="button" data-doc-scan aria-pressed="${isDefaultScanDocId(selected.id)}"
            title="Include this document type in the default scan set used for most criteria."
            class="text-[11px] font-semibold rounded-lg border px-2.5 py-1.5 transition ${isDefaultScanDocId(selected.id) ? "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : "border-slate-200 bg-white text-slate-500 hover:text-slate-700"}">
            ${isDefaultScanDocId(selected.id) ? "✓ In default scan" : "Add to default scan"}
          </button>
          <button type="button" data-doc-delete ${selected.id === "other" ? "disabled" : ""}
            title="${selected.id === "other" ? "The other document type is kept as the soft-criteria fallback." : "Delete document type"}"
            class="text-[11px] font-semibold rounded-lg border border-slate-200 bg-white text-slate-500 px-2.5 py-1.5 hover:text-rose-600 disabled:opacity-40 disabled:hover:text-slate-500">Delete</button>
        </div>
      </div>
      <div class="mt-3 grid grid-cols-12 gap-2">
        <label class="col-span-12 md:col-span-3 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          Id
          <input data-doc-id value="${escapeHtml(selected.id)}" ${selected.id === "other" ? "disabled" : ""}
            class="mt-1 w-full text-[11px] font-mono rounded border border-slate-200 bg-white px-2 py-1.5 focus:border-blue-400 focus:outline-none disabled:bg-slate-100 disabled:text-slate-400"/>
        </label>
        <label class="col-span-12 md:col-span-5 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          Label
          <input data-doc-label value="${escapeHtml(selected.label)}"
            class="mt-1 w-full text-[12px] rounded border border-slate-200 bg-white px-2 py-1.5 focus:border-blue-400 focus:outline-none"/>
        </label>
        <label class="col-span-12 md:col-span-4 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          Hint
          <input data-doc-hint value="${escapeHtml(selected.hint)}"
            class="mt-1 w-full text-[12px] rounded border border-slate-200 bg-white px-2 py-1.5 focus:border-blue-400 focus:outline-none"/>
        </label>
      </div>
    </div>
  `;

  host.querySelectorAll("[data-routing-doc]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.selectedRoutingDocId = btn.dataset.routingDoc;
      renderRoutingProfileEditor();
    });
    btn.addEventListener("dragstart", e => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", btn.dataset.routingDoc || "");
      btn.classList.add("opacity-50");
    });
    btn.addEventListener("dragend", () => btn.classList.remove("opacity-50"));
    btn.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    btn.addEventListener("drop", e => {
      e.preventDefault();
      const sourceId = e.dataTransfer.getData("text/plain");
      const targetId = btn.dataset.routingDoc;
      if (!sourceId || !targetId || sourceId === targetId) return;
      const arr = state.routingProfile.document_types;
      const sourceIdx = arr.findIndex(d => d.id === sourceId);
      const targetIdx = arr.findIndex(d => d.id === targetId);
      if (sourceIdx < 0 || targetIdx < 0) return;
      const [moved] = arr.splice(sourceIdx, 1);
      const rect = btn.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      let insertIdx = arr.findIndex(d => d.id === targetId);
      if (!before) insertIdx += 1;
      arr.splice(insertIdx, 0, moved);
      state.selectedRoutingDocId = sourceId;
      refreshRoutingDependentUi();
    });
  });

  const selectedDoc = state.routingProfile.document_types.find(d => d.id === selected.id);
  if (selectedDoc) {
    const liveSave = () => { saveRoutingProfile(); routingProfileStatus("Routing profile saved."); };
    host.querySelector("[data-doc-label]")?.addEventListener("input", e => {
      selectedDoc.label = e.target.value;
      selectedDoc.short = deriveDocShort(selectedDoc.label, selectedDoc.id);
      liveSave();
      trialItems.forEach((it, i) => { if (it.result) renderRow(it, i); });
    });
    host.querySelector("[data-doc-hint]")?.addEventListener("input", e => { selectedDoc.hint = e.target.value; liveSave(); });
    host.querySelector("[data-doc-scan]")?.addEventListener("click", () => {
      toggleDefaultScanDocId(selected.id);
      refreshRoutingDependentUi();
      routingProfileStatus(`Default scan set: ${defaultScanDocIds().length} document type${defaultScanDocIds().length === 1 ? "" : "s"}.`);
    });
    host.querySelector("[data-doc-id]")?.addEventListener("blur", e => {
      const next = uniqueRoutingDocId(e.target.value, selected.id);
      if (next !== selected.id) {
        selectedDoc.id = next;
        state.selectedRoutingDocId = next;
        renameRoutingDocId(selected.id, next);
      }
      refreshRoutingDependentUi();
      routingProfileStatus("Routing profile saved.");
    });
    host.querySelector("[data-doc-delete]")?.addEventListener("click", () => {
      if (!confirm(`Delete document type "${selectedDoc.label}"? Existing criterion routes to it will be removed.`)) return;
      state.routingProfile.document_types = state.routingProfile.document_types.filter(d => d.id !== selected.id);
      removeRoutingDocId(selected.id);
      state.selectedRoutingDocId = state.routingProfile.document_types[Math.max(0, selectedIdx - 1)]?.id || "";
      refreshRoutingDependentUi();
    });
  }
  routingProfileStatus();
}

function bindRoutingProfileControls() {
  document.getElementById("addRoutingDocBtn")?.addEventListener("click", () => {
    const label = prompt("New document type label (e.g. Radiation plan):");
    if (!label) return;
    const id = uniqueRoutingDocId(label);
    const doc = {
      id,
      label: label.trim(),
      short: deriveDocShort(label, id),
      group: "custom",
      hint: "",
      concept_domain: "other",
    };
    const otherIdx = state.routingProfile.document_types.findIndex(d => d.id === "other");
    if (otherIdx >= 0) state.routingProfile.document_types.splice(otherIdx, 0, doc);
    else state.routingProfile.document_types.push(doc);
    refreshRoutingDependentUi();
    routingProfileStatus("Document type added.");
  });
  document.getElementById("resetRoutingProfileBtn")?.addEventListener("click", () => {
    if (!confirm("Reset document types and visit order to the default profile?")) return;
    state.routingProfile = normalizeRoutingProfile(DEFAULT_ROUTING_PROFILE);
    refreshRoutingDependentUi();
    routingProfileStatus("Routing profile reset to default.");
  });
}

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
  const enabledToggle = root.querySelector("[data-trial-enabled-toggle]");
  if (enabledToggle) {
    enabledToggle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setTrialEnabled(it, !isTrialEnabled(it));
      updateRow(root, it);
      if (root.open) renderBody(root.querySelector("[data-body]"), it, i);
    });
  }
  const oneBtn = root.querySelector("[data-process-one]");
  if (oneBtn) {
    oneBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await processTrialIndexes([i], "single");
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

function isTrialEnabled(it) {
  if (it.result) return it.result.enabled !== false;
  return it.userEnabled !== false;
}

function setTrialEnabled(it, enabled) {
  if (it.result) {
    it.result.enabled = !!enabled;
    markTrialEdited(it.result);
  } else {
    it.userEnabled = !!enabled;
  }
}

function updateRow(root, it) {
  const enabledToggle = root.querySelector("[data-trial-enabled-toggle]");
  if (enabledToggle) {
    const enabled = isTrialEnabled(it);
    enabledToggle.title = enabled ? "Active for matching — click to deactivate" : "Inactive for matching — click to activate";
    enabledToggle.className = "shrink-0 min-w-20 h-7 rounded-md border text-[10px] font-bold transition flex items-center justify-center px-2 " + (
      enabled
        ? "bg-emerald-500 text-white border-emerald-500 hover:bg-emerald-600"
        : "bg-white text-slate-400 border-slate-300 hover:border-slate-400"
    );
    enabledToggle.textContent = enabled ? "Active" : "Inactive";
    root.classList.toggle("opacity-60", !enabled);
  }
  root.querySelector("[data-status]").outerHTML =
    statusBadge(it.status).replace("<span ", `<span data-status `);
  root.querySelector("[data-tid]").textContent = it.preview.id;
  root.querySelector("[data-title]").textContent = it.preview.title;
  const meta = it.error ? `Error: ${it.error}` : (it.preview.meta || "");
  root.querySelector("[data-meta]").textContent = meta;
  // Show #active criteria / total so users can see how many criteria are still
  // in play after manual deactivations.
  let counts = "";
  if (it.result?.criteria) {
    const total = it.result.criteria.length;
    const act = it.result.criteria.filter(c => c.status === "active").length;
    counts = `${act}/${total} criteria active`;
  }
  root.querySelector("[data-counts]").textContent = counts;
  // Provenance pills: shows whether the trial was structured by an LLM and/or
  // carries manual edits, so reviewers can see at a glance what's been touched.
  const prov = root.querySelector("[data-prov]");
  if (prov) prov.innerHTML = it.result ? provenancePillsHtml(it.result.edit_state) : "";
  const processFeedback = root.querySelector("[data-process-feedback]");
  if (processFeedback) {
    processFeedback.classList.toggle("hidden", it.status !== "processing");
    processFeedback.classList.toggle("inline-flex", it.status === "processing");
    const text = processFeedback.querySelector("[data-process-feedback-text]");
    if (text) text.textContent = it.progressLabel || "Structuring";
  }
  const oneBtn = root.querySelector("[data-process-one]");
  if (oneBtn) {
    const canProcess = !!state.apiKey && !state.running && ["pending", "manual", "error"].includes(it.status);
    oneBtn.classList.toggle("hidden", !canProcess);
    oneBtn.disabled = !canProcess;
    oneBtn.textContent = it.status === "error" ? "Retry" : "Process";
    oneBtn.title = it.status === "error" ? "Retry this trial" : "Process this trial";
  }
}

function renderBody(host, it, i) {
  const t = it.result;
  const hasApiKey = !!state.apiKey;

  // Per-trial manual prompt panel, shown only when no API key is available.
  const manualPanel = hasApiKey ? "" : `
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
      : `<div class="text-sm text-slate-500 italic p-3">${hasApiKey ? "Not processed yet. Use Process on this trial or Process Next Trial." : "Not processed yet. Use the manual panel above, or save an API key and run the queue."}</div>`);
    if (!hasApiKey) bindManualPanel(host, it, i);
    return;
  }

  const m = t.metadata || {};
  const ld = m.lifecycle_dates || {};
  host.innerHTML = manualPanel + `
    <div class="grid grid-cols-1 gap-4 mt-3">
      <!-- Overview card (editable) -->
      <div class="bg-white rounded-xl border border-slate-200 p-4" data-meta-card>
        <div class="flex items-center justify-between">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500">Trial Overview</h3>
          <span class="text-[10px] text-slate-400 italic">Click any field to edit</span>
        </div>
        <input type="text" data-mfield="brief_title" value="${escapeHtml(m.brief_title||"")}" placeholder="Brief title"
          class="mt-2 w-full text-sm font-semibold text-slate-900 bg-transparent border-b border-transparent hover:border-slate-200 focus:border-blue-400 focus:outline-none px-0 py-1"/>
        <div class="mt-3 border-t border-slate-100 pt-3">
          <h4 class="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Trial Scope</h4>
          <div class="grid grid-cols-2 gap-y-1.5 gap-x-3 text-[12px]">
            <label class="text-slate-500 self-center">Conditions</label>
            <input type="text" data-mfield="conditions" data-mlist="1" value="${escapeHtml((m.conditions||[]).join(", "))}" placeholder="comma-separated" class="meta-input"/>
            <label class="text-slate-500 self-center">Interventions / drugs</label>
            <input type="text" data-scope-interventions value="${escapeHtml(interventionDisplayNames(m).join(", "))}" placeholder="comma-separated" class="meta-input"/>
            <label class="text-slate-500 self-center">Care paths</label>
            <div data-cp-editor>${carePathChipsHtml(t.care_path_ids || [])}</div>
          </div>
        </div>
        <div class="mt-3 border-t border-slate-100 pt-3">
          <h4 class="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Matching Control</h4>
          <div class="grid grid-cols-2 gap-y-1.5 gap-x-3 text-[12px]">
            <label class="text-slate-500 self-center">Active for matching</label>
            <label class="inline-flex items-center gap-2 text-[12px] font-semibold text-slate-700">
              <input type="checkbox" data-trial-enabled ${t.enabled !== false ? "checked" : ""} class="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"/>
              Include trial
            </label>
            <label class="text-slate-500 self-center">Open date</label>
            <input type="date" data-mfield="lifecycle_dates.start_date" value="${escapeHtml(ld.start_date||"")}" class="meta-input"/>
            <label class="text-slate-500 self-center">Close date</label>
            <input type="date" data-mfield="lifecycle_dates.completion_date" value="${escapeHtml(ld.completion_date||"")}" class="meta-input"/>
          </div>
        </div>
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
  if (!hasApiKey) bindManualPanel(host, it, i);
}

// Wire up live edits on the editable metadata card.
function bindMetadataInputs(host, trial) {
  trial.metadata = trial.metadata || {};
  bindCarePathEditor(host, trial);
  host.querySelector("[data-scope-interventions]")?.addEventListener("input", e => {
    const labels = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
    trial.metadata.drugs = labels;
    trial.metadata.interventions = labels.map(label => ({ type: "drug", label }));
    markTrialEdited(trial);
  });
  host.querySelector("[data-trial-enabled]")?.addEventListener("change", e => {
    trial.enabled = !!e.target.checked;
    markTrialEdited(trial);
    const idx = trialItems.findIndex(it => it.result === trial);
    const row = idx >= 0 ? document.querySelector(`#trialsList details[data-idx="${idx}"]`) : null;
    if (row) updateRow(row, trialItems[idx]);
  });
  host.querySelectorAll("[data-mfield]").forEach(input => {
    input.addEventListener("input", () => {
      const field = input.dataset.mfield;
      let value = input.value;
      if (input.dataset.mlist) {
        value = value.split(",").map(s => s.trim()).filter(Boolean);
      } else if (input.type === "number") {
        value = value === "" ? null : Number(value);
      }
      // Fields targeting the trial root rather than trial.metadata.* live
      // alongside the title without dot-notation.
      if (input.dataset.mtarget === "trial") {
        trial[field] = value;
        return;
      }
      const path = field.split(".");
      let target = trial.metadata;
      for (let i = 0; i < path.length - 1; i++) {
        target[path[i]] = target[path[i]] || {};
        target = target[path[i]];
      }
      target[path[path.length - 1]] = value;
      markTrialEdited(trial);
    });
  });
}

// Wire the multi-select care-path chips editor in the metadata card.
function bindCarePathEditor(host, trial) {
  const editor = host.querySelector("[data-cp-editor]");
  if (!editor) return;
  trial.care_path_ids = normalizeCarePathIds(trial.care_path_ids);
  const rerender = () => {
    editor.innerHTML = carePathChipsHtml(trial.care_path_ids || []);
    wire();
    renderCarePathsPanel();
  };
  const wire = () => {
    editor.querySelectorAll("[data-cp-chip-remove]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.cpChipRemove;
        trial.care_path_ids = (trial.care_path_ids || []).filter(x => x !== id);
        markTrialEdited(trial);
        rerender();
      });
    });
    editor.querySelector("[data-cp-add]")?.addEventListener("change", e => {
      const id = e.target.value;
      if (!id) return;
      trial.care_path_ids = normalizeCarePathIds([...(trial.care_path_ids || []), id]);
      markTrialEdited(trial);
      rerender();
    });
  };
  wire();
}

// Wire up the per-trial manual copy/paste panel.
function bindManualPanel(host, it, i) {
  const userPrompt = buildUserPrompt(it.raw);
  const fullPrompt = `[SYSTEM]\n${buildSystemPrompt()}\n\n[USER]\n${userPrompt}`;
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
      const clean = applySpreadsheetSourceFields(sanitizeTrial(parsed), it.raw);
      if (!clean.trial_id || clean.trial_id === "string") clean.trial_id = it.preview.id;
      markTrialAI(clean, "manual-paste");
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

function carePathLabelFromHint(value) {
  const s = String(value || "").trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!s) return "";
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

function carePathHintsFromValue(value) {
  return String(value || "")
    .split(/[,;|\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function upsertCarePathFromHint(value) {
  const raw = String(value || "").trim();
  const label = carePathLabelFromHint(raw);
  if (!label) return "";
  const id = slugifyCarePath(raw);
  const alias = raw.toLowerCase();
  let cp = state.carePaths.find(c =>
    c.id === id ||
    String(c.label || "").toLowerCase() === label.toLowerCase() ||
    (c.aliases || []).some(a => String(a).toLowerCase() === alias)
  );
  if (!cp) {
    cp = { id: state.carePaths.some(c => c.id === id) ? uniqueCarePathId(id) : id, label, aliases: [alias] };
    state.carePaths.push(cp);
  } else if (alias && !(cp.aliases || []).includes(alias)) {
    cp.aliases = [...(cp.aliases || []), alias];
  }
  return cp.id;
}

function ensureCarePathsFromRawRows(rawRows) {
  const before = JSON.stringify(state.carePaths);
  (rawRows || []).forEach(row => {
    carePathHintsFromValue(row.__raw?.care_path).forEach(upsertCarePathFromHint);
  });
  if (JSON.stringify(state.carePaths) !== before) {
    saveCarePaths();
    return true;
  }
  return false;
}

function carePathIdsFromRaw(row) {
  if (!row?.__raw?.care_path) return [];
  const ids = carePathHintsFromValue(row.__raw.care_path).map(upsertCarePathFromHint).filter(Boolean);
  if (ids.length) saveCarePaths();
  return normalizeCarePathIds(ids);
}

function ensureCarePathsFromTrial(trial) {
  if (!trial?.metadata?.conditions?.length) return [];
  const ids = trial.metadata.conditions.slice(0, 3).map(upsertCarePathFromHint).filter(Boolean);
  if (ids.length) saveCarePaths();
  return normalizeCarePathIds(ids);
}

// Normalize an arbitrary list of care-path ids: lowercase, dedupe, and (when an
// enum is defined) keep only ids that exist in it. When the enum is still empty
// the raw ids are preserved so an LLM-supplied assignment survives until detection.
function normalizeCarePathIds(ids) {
  const out = [];
  const known = state.carePaths.length ? new Set(state.carePaths.map(c => c.id)) : null;
  (Array.isArray(ids) ? ids : []).forEach(raw => {
    const id = String(raw || "").trim().toLowerCase();
    if (!id) return;
    if (known && !known.has(id)) return;
    if (!out.includes(id)) out.push(id);
  });
  return out;
}

// Best-effort auto-assignment: lowercase alias match against the trial's
// title + conditions + first-N criterion texts. Returns ALL matching care-path
// ids (a trial can map to several), strongest match first. Empty when none.
function inferCarePathIds(trial) {
  if (!state.carePaths.length || !trial) return [];
  const m = trial.metadata || {};
  const hay = [
    m.brief_title || "",
    (m.conditions || []).join(" "),
    (trial.criteria || []).slice(0, 6).map(c => c.original_text || "").join(" "),
  ].join(" ").toLowerCase();
  const scored = [];
  for (const cp of state.carePaths) {
    const aliases = [cp.label, ...(cp.aliases || [])].map(a => String(a).toLowerCase().trim()).filter(Boolean);
    let score = 0;
    for (const a of aliases) {
      if (!a || a.length < 3) continue;
      if (hay.includes(a)) score += a.length;
    }
    if (score > 0) scored.push({ id: cp.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.id);
}

function reassignAllCarePaths() {
  let changed = 0;
  (state.results || []).forEach(t => {
    if (!t) return;
    const inferred = inferCarePathIds(t);
    if (!inferred.length) return;
    const next = normalizeCarePathIds([...(t.care_path_ids || []), ...inferred]);
    if (next.join("|") !== (t.care_path_ids || []).join("|")) { t.care_path_ids = next; changed++; }
  });
  return changed;
}

async function detectCarePathsFromSample({ silent = false } = {}) {
  const statusEl = document.getElementById("carePathsStatus");
  const setStatus = (html) => { if (statusEl) statusEl.innerHTML = html; };
  if (!state.apiKey) {
    if (!silent) setStatus(`<span class="text-rose-600">Save an OpenAI key in the header to detect care paths.</span>`);
    return;
  }
  const sample = (state.rawRows || []).slice(0, 12);
  if (!sample.length) {
    if (!silent) setStatus(`<span class="text-rose-600">Load trials first (upload a source file).</span>`);
    return;
  }
  setStatus(`<span class="italic text-slate-500">Sampling ${sample.length} trials…</span>`);
  const sys = `You normalize clinical trials from ANY field of medicine (oncology, cardiology, neurology, endocrinology, infectious disease, rheumatology, …) into a small enum of CARE PATHS — clinical-domain buckets used downstream for patient matching. Examples (illustrative, NOT exhaustive): "breast_cancer", "prostate_cancer", "heart_failure", "atrial_fibrillation", "type_2_diabetes", "alzheimer_disease", "rheumatoid_arthritis", "hiv". Given a sample of trials in any language (e.g. Dutch "borst"/"mamma" -> breast cancer, "prostaat" -> prostate cancer, "hartfalen" -> heart failure, "suikerziekte" -> diabetes), return a deduplicated enum covering ALL of them. Return STRICT JSON: {"care_paths":[{"id":"breast_cancer","label":"Breast cancer","aliases":["breast cancer","mamma","mammacarcinoma","borst","borstkanker"]}]}. Use snake_case English ids. Choose specificity that matches the sample (sub-types when meaningful, broader domains when not). Aliases MUST include every language/spelling/synonym that appears in the sample so downstream alias-matching can place trials into the right bucket. Use lowercase aliases. 3-15 care paths total. No prose.`;
  const condensed = sample.map((r, i) => {
    const title = r.__raw?.metadata?.brief_title || r.__raw?.brief_title || r.__raw?.trial || r.__raw?.Studietitel || r.__raw?.Titel || "";
    const conditions = r.__raw?.metadata?.conditions || r.__raw?.condition || r.__raw?.indication || r.__raw?.care_path || "";
    return `${i+1}. title="${String(title).slice(0,160)}" conditions="${Array.isArray(conditions)?conditions.join(", "):String(conditions).slice(0,120)}"`;
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
    setStatus(`<span class="text-emerald-700">Detected ${list.length} care path(s). Auto-assigned ${changed} trial(s).</span>`);
  } catch (e) {
    setStatus(`<span class="text-rose-600">Detection failed: ${escapeHtml(e.message)}</span>`);
  }
}

// Multi-select care-path editor for a trial: removable chips for each assigned
// id plus an "add" dropdown of the remaining enum entries.
function carePathChipsHtml(selectedIds) {
  const ids = Array.isArray(selectedIds) ? selectedIds : [];
  const byId = Object.fromEntries(state.carePaths.map(c => [c.id, c]));
  const chips = ids.map(id => {
    const label = byId[id]?.label || id;
    return `<span class="badge bg-blue-50 text-blue-700 border border-blue-200 inline-flex items-center gap-1" data-cp-chip="${escapeHtml(id)}">
      ${escapeHtml(label)}
      <button type="button" data-cp-chip-remove="${escapeHtml(id)}" title="Remove" class="text-blue-400 hover:text-rose-600 leading-none">×</button>
    </span>`;
  }).join("");
  const remaining = state.carePaths.filter(cp => !ids.includes(cp.id));
  const addSelect = remaining.length
    ? `<select data-cp-add class="meta-input text-[11px] py-0.5">
         <option value="">+ add care path…</option>
         ${remaining.map(cp => `<option value="${escapeHtml(cp.id)}">${escapeHtml(cp.label)}</option>`).join("")}
       </select>`
    : (state.carePaths.length ? `<span class="text-[10px] text-slate-400 italic">all assigned</span>` : `<span class="text-[10px] text-slate-400 italic">no care paths defined</span>`);
  return `<div class="flex flex-wrap items-center gap-1" data-cp-chips>${chips}${addSelect}</div>`;
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
  (state.results || []).forEach(t => (t?.care_path_ids || []).forEach(id => { counts[id] = (counts[id] || 0) + 1; }));
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
      (state.results || []).forEach(t => { if (t && Array.isArray(t.care_path_ids)) t.care_path_ids = t.care_path_ids.filter(x => x !== id); });
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

async function expandStagesForCriterion(criterion, stageMatch, host, trial) {
  if (!state.apiKey) {
    host.innerHTML = `<span class="text-[10px] text-rose-600">Save an OpenAI key in the header to expand stages.</span>`;
    return;
  }
  host.innerHTML = `<span class="text-[10px] text-slate-500 italic">Expanding ${escapeHtml(stageMatch.system)} stages…</span>`;
  const sys = `You are a clinical staging expert. Given a free-text criterion that references a cancer staging range, enumerate every explicit stage in that range and provide its TNM-8 mapping when applicable. Return STRICT JSON: {"system":"FIGO|AJCC|TNM|Stage","values":[{"stage":"IB2","tnm":"T1b2 N0 M0"}, ...]}. No prose. If the text doesn't actually specify a stage range, return {"system":"","values":[]}.`;
  const usr = `Criterion text:\n${criterion.original_text}\n\nDetected staging system: ${stageMatch.system}\n\nEnumerate every individual stage in the range, inclusive. Use the condition context implied by the criterion to pick the correct TNM-8 mapping; if ambiguous, omit the tnm field.`;
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
    markTrialAI(trial, `openai/${state.model}`);
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
  const categoryDoc = docById(categoryNorm);
  const isOtherCategory = categoryNorm === "other" || !categoryDoc;
  const categoryLabel = isOtherCategory ? "other" : (categoryDoc.short || categoryNorm);

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
  matrixDocs().forEach(d => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.dataset.doc = d.id;
    routingHost.appendChild(chip);
    renderMatrixCell(chip, c, d, () => {
      markTrialEdited(trial);
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
        markTrialEdited(trial);
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
      btn.addEventListener("click", () => expandStagesForCriterion(c, stageMatch, stageBar, trial));
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
    markTrialEdited(trial);
    paintStatus();
  });

  // ---------- Guidance textarea ----------
  const guidance = card.querySelector("[data-guidance]");
  const dlist    = card.querySelector("[data-guidance-list]");
  if (guidance) {
    refreshGuidanceSuggestions(dlist, c);
    guidance.addEventListener("input", () => { c.guidance = guidance.value; markTrialEdited(trial); });
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
        markTrialAI(trial, `openai/${state.model}`);
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
    m.conditions?.length ? `Conditions: ${m.conditions.join(", ")}` : "",
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
      markTrialEdited(trial);
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
    mdt_notes:         "mdt-notes",
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
    "mdt-notes":         "mdt_notes",
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
  DOMAIN_FOR_CATEGORY: {
    intake_notes:      "demographics",
    referral_letters:  "condition",
    mdt_notes:         "procedure",
    pathology:         "observation",
    imaging_radiology: "observation",
    treatment_history: "medication",
    molecular_genomic: "genomic",
    core_lab:          "observation",
    other:             "other",
  },
};

function tsv1WireDocId(id) {
  const k = normalizeDocId(id);
  return TS_V1.DOC_TYPE_MAP[k] || k.replace(/_/g, "-");
}

function tsv1InternalDocId(id) {
  const s = String(id || "").trim().toLowerCase();
  return TS_V1.DOC_TYPE_INVERSE[s] || normalizeDocId(s);
}

function tsv1RoutingProfile() {
  const docs = matrixDocs().map((d, i) => ({
    id: tsv1WireDocId(d.id),
    label: String(d.label || ""),
    hint: String(d.hint || ""),
  }));
  return {
    id: tsv1WireDocId(state.routingProfile.id || "default_clinical"),
    label: String(state.routingProfile.label || ""),
    document_type_system: "https://trialschema.org/v1/document-types",
    default_scan_set: defaultScanDocIds().map(tsv1WireDocId),
    default_visit_order: docs.map(d => d.id),
    document_types: docs,
  };
}

function fromV1RoutingProfile(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  let docs = Array.isArray(src.document_types) ? src.document_types.map(d => ({
    id: tsv1InternalDocId(d.id),
    label: d.label,
    short: d.short,
    group: d.group,
    hint: d.hint,
    concept_domain: d.concept_domain,
    rank: Number.isFinite(+d.rank) ? +d.rank : 999,
  })) : cloneRoutingProfile(DEFAULT_ROUTING_PROFILE).document_types;
  const order = Array.isArray(src.default_visit_order) ? src.default_visit_order.map(tsv1InternalDocId) : [];
  if (order.length) {
    docs.sort((a, b) => {
      const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    });
  } else {
    docs.sort((a, b) => a.rank - b.rank);
  }
  return normalizeRoutingProfile({
    id: tsv1InternalDocId(src.id || "default-clinical"),
    label: src.label || "Imported routing profile",
    document_types: docs,
    default_scan_set: Array.isArray(src.default_scan_set) ? src.default_scan_set.map(tsv1InternalDocId) : undefined,
  });
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
  const doc = docById(c.category);
  const concept = {
    domain: doc?.concept_domain || TS_V1.DOMAIN_FOR_CATEGORY[c.category] || "other",
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
      primary:  (c.routing?.primary_docs  || []).map(d => coerceDocIdToProfile(d)).filter(Boolean).map(tsv1WireDocId),
      fallback: (c.routing?.fallback_docs || []).map(d => coerceDocIdToProfile(d)).filter(Boolean).map(tsv1WireDocId),
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
  const conditions = (m.conditions || []).map(d => tsv1Coding({ text: String(d) })).filter(Boolean);
  const interventions = normalizeMetadataInterventions(m)
    .map(iv => ({ type: normalizeInterventionType(iv.type), label: String(iv.label) }))
    .filter(iv => iv.label);
  const ld = m.lifecycle_dates || {};

  const out = {
    id: String(t.trial_id || ""),
    kind: "trial",
    enabled: t.enabled !== false,
    title: String(m.brief_title || ""),
    conditions,
    interventions,
  };
  const lifecycle = {};
  if (ld.start_date) lifecycle.start_date = ld.start_date;
  if (ld.completion_date) lifecycle.completion_date = ld.completion_date;
  if (Object.keys(lifecycle).length) out.lifecycle = lifecycle;

  // Normalized clinical-domain care-path assignment (multi-valued). Persisted
  // so manual edits survive a re-import of a previous export.
  const carePathIds = normalizeCarePathIds(t.care_path_ids);
  if (carePathIds.length) out.care_path_ids = carePathIds;

  out.criteria = (t.criteria || []).map((c, i) => tsv1Criterion(c, i));

  // Trial-level provenance: which edits (AI / manual) the trial carries. Kept
  // in the wire format so a re-import restores the badges and, crucially, lets
  // the resume/merge flow know this trial already holds reviewed manual work.
  const es = normalizeEditState(t.edit_state);
  if (es.ai || es.manual) {
    out.provenance = { ai_processed: es.ai, manually_edited: es.manual };
    if (es.ai_at)     out.provenance.ai_at = es.ai_at;
    if (es.ai_by)     out.provenance.ai_by = es.ai_by;
    if (es.manual_at) out.provenance.edited_at = es.manual_at;
  }
  return out;
}

function toV1Envelope(trials) {
  return {
    format:         TS_V1.FORMAT,
    format_version: TS_V1.VERSION,
    generated_at:   new Date().toISOString(),
    generator:      TS_V1.GENERATOR,
    routing_profile: tsv1RoutingProfile(),
    care_path_catalog: tsv1CarePathCatalog(),
    trial_count:    trials.length,
    trials:         trials.map(tsv1Trial),
  };
}

// The normalized care-path enum (id, label, aliases) active at export time.
// Round-trips so re-importing restores the buckets and their aliases.
function tsv1CarePathCatalog() {
  return (state.carePaths || []).map(cp => ({
    id: String(cp.id),
    label: String(cp.label || cp.id),
    aliases: Array.isArray(cp.aliases) ? cp.aliases.map(a => String(a).toLowerCase().trim()).filter(Boolean) : [],
  }));
}

// Reverse transform: TrialSchema v1 envelope -> internal model. Used when the
// user re-imports a previously exported file.
function fromV1Trial(v) {
  const m = {
    brief_title: v.title || "",
    drugs: (v.interventions || []).filter(i => normalizeInterventionType(i.type) === "drug").map(i => i.label).filter(Boolean),
    interventions: (v.interventions || []).map(i => ({
      type: normalizeInterventionType(i.type),
      label: String(i.label || "").trim(),
    })).filter(i => i.label),
    conditions: (v.conditions || []).map(c => c.display || c.text || c.code || "").filter(Boolean),
    lifecycle_dates: {
      start_date:      v.lifecycle?.start_date || "",
      completion_date: v.lifecycle?.completion_date || "",
    },
  };
  const criteria = (v.criteria || []).map((c, i) => {
    const cat = (c.routing?.primary || []).map(tsv1InternalDocId).map(coerceDocIdToProfile).filter(Boolean)[0] || "other";
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
        primary_docs:  (c.routing?.primary  || []).map(tsv1InternalDocId).map(coerceDocIdToProfile).filter(Boolean),
        fallback_docs: (c.routing?.fallback || []).map(tsv1InternalDocId).map(coerceDocIdToProfile).filter(Boolean),
      },
      evaluation_type: evalType,
      structured_target: st,
      guidance: c.guidance || "",
      other_active: cat === "other",
    };
  });
  return sanitizeTrial({
    trial_id: v.id,
    enabled: v.enabled !== false,
    metadata: m,
    care_path_ids: Array.isArray(v.care_path_ids) ? v.care_path_ids : [],
    criteria,
    edit_state: v.provenance ? {
      ai: !!v.provenance.ai_processed,
      manual: !!v.provenance.manually_edited,
      ai_at: v.provenance.ai_at || "",
      ai_by: v.provenance.ai_by || "",
      manual_at: v.provenance.edited_at || "",
    } : undefined,
  });
}

function fromV1Envelope(parsed) {
  if (!parsed || parsed.format !== TS_V1.FORMAT) return null;
  state.routingProfile = fromV1RoutingProfile(parsed.routing_profile);
  saveRoutingProfile();
  renderRoutingProfileEditor();
  // Restore the normalized care-path enum so manual assignments resolve and
  // survive editing a previously exported file.
  if (Array.isArray(parsed.care_path_catalog) && parsed.care_path_catalog.length) {
    const byId = Object.fromEntries(state.carePaths.map(c => [c.id, c]));
    parsed.care_path_catalog.forEach(cp => {
      const id = String(cp.id || slugifyCarePath(cp.label || "")).toLowerCase();
      if (!id) return;
      const label = String(cp.label || id);
      const aliases = Array.isArray(cp.aliases) ? cp.aliases.map(a => String(a).toLowerCase().trim()).filter(Boolean) : [];
      if (byId[id]) {
        byId[id].aliases = [...new Set([...(byId[id].aliases || []), ...aliases])];
      } else {
        byId[id] = { id, label, aliases };
      }
    });
    state.carePaths = Object.values(byId);
    saveCarePaths();
    renderCarePathsPanel();
  }
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
  loadRoutingProfile();
  loadCarePaths();
  bindManualUploads();
  bindFilters();
  bindSourceInfoModal();
  bindRoutingProfileControls();
  bindCarePathControls();
  renderRoutingProfileEditor();
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
  document.getElementById("ctgovSourceToggle")?.addEventListener("click", () => {
    const panel = document.getElementById("ctgovSourcePanel");
    const toggle = document.getElementById("ctgovSourceToggle");
    const willShow = panel?.classList.contains("hidden");
    panel?.classList.toggle("hidden", !willShow);
    toggle?.classList.toggle("ring-2", !!willShow);
    toggle?.classList.toggle("ring-cyan-200", !!willShow);
    toggle?.classList.toggle("bg-cyan-50", !!willShow);
    if (willShow) document.getElementById("ctgovNctInput")?.focus();
  });
  document.querySelectorAll("[data-process-mode]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.processMode = btn.dataset.processMode === "all" ? "all" : "single";
      updateProcessButtonLabel();
    });
  });
  updateProcessButtonLabel();
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
    clearPreparedTrials("Sample source ready. Load trial rows to review before processing.");
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
