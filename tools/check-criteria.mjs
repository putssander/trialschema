#!/usr/bin/env node
// Check a TrialSchema export: structure (no model) and faithfulness of each criterion to its source text (a model).
//
//   node tools/check-criteria.mjs export.json --structure                       structural checks only
//   node tools/check-criteria.mjs export.json --endpoint URL --model M [--key K] any OpenAI-compatible server
//   node tools/check-criteria.mjs export.json --prompts prompts.md              copy-paste prompts (Copilot, ChatGPT, Claude)
//   node tools/check-criteria.mjs export.json --answers answers.json            merge pasted answers
// Output (--out, default findings.json): {"findings": [{trial, criterion, severity, issue, suggested_fix}]}, the format
// tools/review-docx.mjs shows under "Open review points".
import { readFileSync, writeFileSync } from "node:fs";

export const SYSTEM = `You check whether trial eligibility criteria were rewritten faithfully. For each criterion compare
source_text (the original) with clarified_text, constraint, assertion, timing, kind, enabled and guidance. Report only
faithfulness problems: a condition added or dropped; > vs >=, a wrong number, unit or time window; polarity inverted;
a compound source split or merged so the meaning changes (look at sibling criteria); guidance contradicting the source;
an enabled criterion that cannot be judged from medical records (consent, logistics). severity: high = changes a
matching decision; medium = could, for some patients; low = cosmetic or not matchable. Return JSON only:
{"findings": [{"criterion": "...", "severity": "high|medium|low", "issue": "one sentence", "suggested_fix": "one sentence"}]}.
An empty list means no problems.`;

const TIME = /\b(maand|maanden|jaar|jaren|week|weken|dag|dagen|geleden|binnen|month|months|year|years|week|weeks|day|days|within|ago|prior|previous|eerder|voorafgaand)\b/i;
const CONSENT = /\b(informed consent|toestemming|willing|bereid|able to comply|follow-?up)\b/i;

export function structure(exp) {
  const out = [];
  const add = (trial, criterion, severity, issue, suggested_fix) => out.push({ trial, criterion, severity, issue, suggested_fix });
  for (const t of exp.trials || []) {
    if (!(t.care_path_ids || []).length) add(t.id, "-", "high", "no care path: the trial is never considered", "assign a care path");
    if (!(t.identifiers || []).length) add(t.id, "-", "low", "no registry identifier", "add the registry number (enables automatic updates)");
    for (const c of t.criteria || []) {
      if (c.enabled === false) {
        if (!c.guidance) add(t.id, c.id, "low", "disabled without a recorded reason", "add guidance with the reason");
        continue;
      }
      if (TIME.test(c.source_text || "") && !c.timing) add(t.id, c.id, "medium", "source mentions time but no timing is set", "set timing (window or lookback)");
      if ((c.routing?.primary || []).length > 2 || (c.routing?.fallback || []).length > 1) add(t.id, c.id, "low", "more than 2 primary or 1 fallback document types", "reduce routing to save model calls");
      if (CONSENT.test(c.source_text || "")) add(t.id, c.id, "low", "consent or logistics: not judgeable from records", "disable for matching");
      if (!c.clarified_text) add(t.id, c.id, "high", "no clarified text", "clarify the criterion");
    }
  }
  return out;
}

export function prompt(trial) {
  const crit = (trial.criteria || []).map((c) => ({ id: c.id, kind: c.kind, enabled: c.enabled !== false, source_text: c.source_text,
    clarified_text: c.clarified_text, constraint: c.constraint, assertion: c.assertion, timing: c.timing, guidance: c.guidance }));
  return `Trial ${trial.id}: ${trial.title || ""}\nCriteria:\n${JSON.stringify(crit, null, 1)}`;
}

async function ask(endpoint, model, key, user) {
  const r = await fetch(endpoint.replace(/\/$/, "") + "/v1/chat/completions", { method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, temperature: 0, response_format: { type: "json_object" },
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content.replace(/^```(json)?|```$/g, ""));
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : ""; };
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
  const endpoint = opt("--endpoint"), model = opt("--model"), key = opt("--key") || process.env.OPENAI_API_KEY || "";
  const promptsOut = opt("--prompts"), answers = opt("--answers"), out = opt("--out") || "findings.json", only = flag("--structure");
  const exp = JSON.parse(readFileSync(args[0], "utf8"));
  const findings = structure(exp);
  if (promptsOut) {
    writeFileSync(promptsOut, exp.trials.map((t) => `## ${t.id}\n\nPaste into the chat, then save the JSON answer as answers.json under key "${t.id}".\n\n\`\`\`\n${SYSTEM}\n\n${prompt(t)}\n\`\`\`\n`).join("\n"));
    console.log(`prompts for ${exp.trials.length} trials -> ${promptsOut}`);
  } else if (answers) {
    for (const [tid, a] of Object.entries(JSON.parse(readFileSync(answers, "utf8")))) for (const f of a.findings || []) findings.push({ trial: tid, ...f });
  } else if (!only && endpoint) {
    for (const t of exp.trials) {
      try { for (const f of (await ask(endpoint, model, key, prompt(t))).findings || []) findings.push({ trial: t.id, ...f }); console.log(`ok   ${t.id}`); }
      catch (e) { console.log(`FAIL ${t.id}: ${e.message}`); }
    }
  }
  writeFileSync(out, JSON.stringify({ findings }, null, 1));
  const n = (s) => findings.filter((f) => f.severity === s).length;
  console.log(`${findings.length} findings (high ${n("high")}, medium ${n("medium")}, low ${n("low")}) -> ${out}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) main();
