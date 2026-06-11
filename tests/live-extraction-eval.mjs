import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const fixtures = [
  {
    trial: "ACTIVE_NEURO_01",
    row: {
      trial: "ACTIVE_NEURO_01",
      care_path: "Neurologie",
      inclusion: [
        "Meningeoom WHO graad 1",
        "Leeftijd >18 jaar",
        "Karnofsky Performance Score 70 of hoger",
      ].join("\n"),
      exclusion: [
        "Resectie meningeoom korter dan 3 maanden geleden",
        "Zwangerschap",
        "Eerdere craniele radiotherapie",
        "Eerdere chemotherapie in de afgelopen 5 jaar",
        "Contra-indicatie voor MRI (metalen implantaten, claustrofobie)",
      ].join("\n"),
      status: "active",
    },
    expectations: [
      {
        id: "strict age > 18",
        source: "Leeftijd >18 jaar",
        type: "inclusion",
        assertion: "present",
        quantitative: { metric: /age/i, operator: ">", value: 18, unit: /years?/i },
        text: [/strictly greater than 18/i, /exactly 18 .*does not satisfy/i],
      },
      {
        id: "Karnofsky >= 70",
        source: "Karnofsky Performance Score 70 of hoger",
        type: "inclusion",
        quantitative: { metric: /karnofsky/i, operator: ">=", value: 70 },
      },
      {
        id: "pregnancy exclusion keeps present assertion",
        source: "Zwangerschap",
        type: "exclusion",
        assertion: "present",
        text: [/pregnan/i],
      },
    ],
  },
  {
    trial: "ACTIVE_HEAD_NECK_01",
    row: {
      trial: "ACTIVE_HEAD_NECK_01",
      care_path: "Hoofd/Hals",
      inclusion: [
        "Leeftijd groter of gelijk aan 18 jaar",
        "Orofarynx carcinoom",
        "HPV of P16 positief plaveiselcelcarcinoom",
        "Verwezen voor curatieve radiotherapie",
      ].join("\n"),
      exclusion: [
        "HPV negatief, ook indien P16 positief",
        "Afstandsmetastasen = M1",
        "HPV gerelateerd cervix-, anus-, of peniscarcinoom",
      ].join("\n"),
      status: "active",
    },
    expectations: [
      {
        id: "inclusive age >= 18",
        source: "Leeftijd groter of gelijk aan 18 jaar",
        type: "inclusion",
        quantitative: { metric: /age/i, operator: ">=", value: 18, unit: /years?/i },
        text: [/18 years.*older|18 years of age or older/i],
      },
    ],
  },
  {
    trial: "ACTIVE_BREAST_01",
    row: {
      trial: "ACTIVE_BREAST_01",
      care_path: "Mamma",
      inclusion: [
        "Leeftijd groter of gelijk aan 18 jaar",
        "WHO performance status kleiner of gelijk aan 2",
        "Locoregionaal recidief borstkanker of een tweede primaire tumor borstkanker",
        "Behandeld met lokale excisie na eerdere mastectomie of behandeld met salvage-mastectomie",
        "(Hoogrisico tumorkenmerken met indicatie voor postoperatieve herbestraling)",
        "PET-CT moet gemaakt zijn",
        "Maximaal 5 metastasen in lymfeklieren in het mediastinum, hals, contralaterale axillaire regio of supraclaviculaire regio",
      ].join("\n"),
      exclusion: "Primair mammasarcoom",
      status: "active",
    },
    expectations: [
      {
        id: "WHO performance status <= 2",
        source: "WHO performance status kleiner of gelijk aan 2",
        type: "inclusion",
        quantitative: { metric: /WHO performance status/i, operator: "<=", value: 2 },
      },
    ],
  },
  {
    trial: "ACTIVE_UROLOGY_01",
    row: {
      trial: "ACTIVE_UROLOGY_01",
      care_path: "Urologie",
      inclusion: [
        "Prostaatcarcinoom in het verleden behandeld met radicale prostatectomie",
        "Tumorstadium prostatectomie is pT2-4, R0-1, pN0 of cN0, cNx",
        "Gleason score beschikbaar",
        "PSMA scan beschikbaar en niet ouder dan 60 dagen",
        "Geen metastasen of positieve klieren op PSMA scan",
        "Stijgend PSA gedefinieerd als 2 opeenvolgende stijgingen met het laatste PSA van > 0,1 mg/L OF 3 opeenvolgende stijgingen",
        "PSA bij inclusie kleiner dan 1,0 mg/L",
        "WHO 0-2 bij inclusie",
        "Leeftijd tussen 18 en 80 jaar",
      ].join("\n"),
      exclusion: [
        "Eerdere bekkenbestraling",
        "Eerdere chemotherapie, hormonale therapie of orchidectomie",
        "Eerder of gelijktijdig invasief carcinoom, behalve cutaan basaalcelcarcinoom of plaveiselcelcarcinoom",
        "Metastasen in chirurgisch verwijderde klieren",
        "Dubbelzijdige metalen heupprothese",
      ].join("\n"),
      status: "active",
    },
    expectations: [
      {
        id: "PSMA recency <= 60 days",
        source: "PSMA scan beschikbaar en niet ouder dan 60 dagen",
        type: "inclusion",
        quantitative: { metric: /PSMA.*scan.*age|PSMA scan/i, operator: "<=", value: 60, unit: /days?/i },
        text: [/PSMA/i, /60 days/i],
      },
      {
        id: "no metastases keeps absent assertion",
        source: "Geen metastasen of positieve klieren op PSMA scan",
        type: "inclusion",
        assertion: "absent",
        text: [/metasta/i, /positive nodes|positive lymph nodes/i],
      },
      {
        id: "PSA at inclusion < 1.0 mg/L",
        source: "PSA bij inclusie kleiner dan 1,0 mg/L",
        type: "inclusion",
        quantitative: { metric: /PSA/i, operator: "<", value: 1, unit: /mg\/L/i },
        text: [/PSA/i, /inclusion|eligibility/i],
      },
      {
        id: "age between 18 and 80",
        source: "Leeftijd tussen 18 en 80 jaar",
        type: "inclusion",
        quantitative: { metric: /age/i, operator: "between", value: 18, upper_value: 80, unit: /years?/i },
      },
    ],
  },
];

function loadAppPrompts() {
  const src = readFileSync(join(root, "app.js"), "utf8");
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: { getItem() { return null; }, setItem() {} },
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelectorAll() { return []; },
    },
    window: {},
    Blob: class {},
    File: class {},
    fetch() { throw new Error("fetch is disabled while loading app prompts"); },
  };
  vm.createContext(context);
  vm.runInContext(src, context);
  return {
    buildSystemPrompt: context.buildSystemPrompt,
    buildUserPrompt: context.buildUserPrompt,
    sanitizeTrial: context.sanitizeTrial,
    toV1Envelope: context.toV1Envelope,
  };
}

function approxEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 1e-9;
}

function criterionHaystack(c) {
  return [
    c.original_text_raw,
    c.original_text,
    c.guidance,
    c.structured_target?.metric,
  ].filter(Boolean).join(" ");
}

function findCriterion(criteria, expectation) {
  const sourceLower = expectation.source.toLowerCase();
  return criteria.find(c => String(c.original_text_raw || "").toLowerCase() === sourceLower)
    || criteria.find(c => criterionHaystack(c).toLowerCase().includes(sourceLower))
    || criteria.find(c => expectation.text?.some(rx => rx.test(criterionHaystack(c))));
}

function checkExpectation(criteria, expectation) {
  const c = findCriterion(criteria, expectation);
  const failures = [];
  if (!c) return [`missing criterion: ${expectation.source}`];
  if (expectation.type && c.type !== expectation.type) failures.push(`type expected ${expectation.type}, got ${c.type}`);
  if (expectation.assertion && c.assertion !== expectation.assertion) failures.push(`assertion expected ${expectation.assertion}, got ${c.assertion || "(missing)"}`);
  if (expectation.text) {
    const hay = criterionHaystack(c);
    for (const rx of expectation.text) {
      if (!rx.test(hay)) failures.push(`text did not match ${rx}`);
    }
  }
  if (expectation.quantitative) {
    if (c.evaluation_type !== "quantitative") failures.push(`evaluation_type expected quantitative, got ${c.evaluation_type}`);
    const st = c.structured_target || {};
    const q = expectation.quantitative;
    if (q.metric && !q.metric.test(String(st.metric || ""))) failures.push(`metric ${st.metric || "(missing)"} did not match ${q.metric}`);
    if (q.operator && st.operator !== q.operator) failures.push(`operator expected ${q.operator}, got ${st.operator || "(missing)"}`);
    if (q.value !== undefined && !approxEqual(st.value, q.value)) failures.push(`value expected ${q.value}, got ${st.value}`);
    if (q.upper_value !== undefined && !approxEqual(st.upper_value, q.upper_value)) failures.push(`upper_value expected ${q.upper_value}, got ${st.upper_value}`);
    if (q.unit && !q.unit.test(String(st.unit || ""))) failures.push(`unit ${st.unit || "(missing)"} did not match ${q.unit}`);
  }
  return failures;
}

function validateV1Envelope(envelope) {
  const failures = [];
  if (envelope.format !== "trialschema") failures.push("v1 envelope format is not trialschema");
  for (const trial of envelope.trials || []) {
    if (trial.kind !== "trial") failures.push(`${trial.id}: missing kind=trial`);
    for (const c of trial.criteria || []) {
      for (const key of ["id", "kind", "enabled", "rank", "source_text", "concept", "assertion", "constraint", "routing"]) {
        if (!(key in c)) failures.push(`${trial.id}/${c.id}: missing v1 key ${key}`);
      }
      if (!["present", "absent", "unknown"].includes(c.assertion)) failures.push(`${trial.id}/${c.id}: invalid assertion ${c.assertion}`);
      if (!c.constraint?.kind) failures.push(`${trial.id}/${c.id}: missing constraint.kind`);
    }
  }
  return failures;
}

async function callOpenAI({ model, apiKey, system, user }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 1000)}`);
  const json = JSON.parse(text);
  const content = json.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

async function main() {
  if (process.env.OPENAI_LIVE_EVAL !== "1") {
    console.log("Skipped live OpenAI eval. Run with OPENAI_LIVE_EVAL=1 OPENAI_API_KEY=... [OPENAI_MODEL=...] node tests/live-extraction-eval.mjs");
    return;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for live eval.");
  const model = process.env.OPENAI_MODEL || "gpt-5.5";
  const app = loadAppPrompts();
  const system = app.buildSystemPrompt();
  const failures = [];

  console.log(`Running live extraction eval with model ${model} on ${fixtures.length} active-trial fixtures...`);
  for (const fixture of fixtures) {
    const raw = { __sourceFormat: "spreadsheet", __raw: fixture.row };
    const parsed = await callOpenAI({
      model,
      apiKey,
      system,
      user: app.buildUserPrompt(raw),
    });
    const sanitized = app.sanitizeTrial(parsed);
    const envelope = app.toV1Envelope([sanitized]);
    const schemaFailures = validateV1Envelope(envelope);
    for (const failure of schemaFailures) failures.push(`${fixture.trial}: ${failure}`);

    for (const expectation of fixture.expectations) {
      const expectationFailures = checkExpectation(sanitized.criteria || [], expectation);
      if (expectationFailures.length) {
        failures.push(`${fixture.trial}/${expectation.id}: ${expectationFailures.join("; ")}`);
        console.log(`FAIL ${fixture.trial}: ${expectation.id}`);
      } else {
        console.log(`PASS ${fixture.trial}: ${expectation.id}`);
      }
    }
  }

  if (failures.length) {
    console.error("\nLive extraction eval failures:");
    failures.forEach(f => console.error(`- ${f}`));
    process.exitCode = 1;
  } else {
    console.log("\nLive extraction eval passed.");
  }
}

await main();
