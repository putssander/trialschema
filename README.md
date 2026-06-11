# TrialSchema

TrialSchema is a static, browser-only BYOK app for turning clinical-trial eligibility text into an agent-ready JSON export for patient matching. The app keeps the OpenAI API key in browser `localStorage`; there is no backend.

## Schema Goal

TrialSchema is designed to tell a matching agent four things clearly:

- What to check: each eligibility criterion is split into one patient-level rule with a clinical `concept`, source text, clarified text, and assertion polarity.
- Where to look: `routing_profile` defines available document types, the default scan set, and the general visit order; each criterion can override that with `routing.primary` and `routing.fallback`.
- How to evaluate: `constraint`, `assertion`, `rank`, and `enabled` tell the agent whether the rule is a comparison, range, code set, existence check, boolean, or LLM-judgement fallback.
- Which trials to consider first: `care_path_catalog` and trial-level `care_path_ids` provide normalized care paths, such as `breast_cancer` or `heart_failure`, for first-pass matching before criteria evaluation.

The practical goal is higher matching performance: criteria should be explicit enough that an agent does not have to guess threshold strictness, negation, patient fact polarity, or the right part of the patient record to inspect.

## Run Locally

Serve the repository as static files:

```bash
python3 -m http.server 5173
```

Then open:

```text
http://127.0.0.1:5173
```

Upload an Excel/CSV/JSON/JSONL source, load rows, and process trials with an OpenAI key. Without a key, the app supports manual copy/paste LLM mode per trial.

## Matching-Oriented Criteria

The extractor prompt is optimized for downstream clinical matching agents. For each criterion, the goal is not only cleaner prose, but schema-aligned executable meaning:

- Preserve `original_text_raw` as the verbatim source criterion.
- Write `original_text` as the English, agent-ready clarified criterion.
- Preserve quantitative operator strictness exactly, for example `> 18` is not the same as `>= 18`.
- Encode executable comparisons in `structured_target`.
- Preserve negation with `assertion`, for example a negated inclusion criterion can be `type: "inclusion"` and `assertion: "absent"`.
- Export maps these fields to TrialSchema v1 `source_text`, `clarified_text`, `constraint`, and `assertion`.

Example:

```text
Source: Leeftijd >18 jaar
Clarified: Participant's age at eligibility assessment must be strictly greater than 18 years; a participant exactly 18 years old does not satisfy this criterion.
Constraint: age > 18 years
```

## Tests

Run the static prompt/schema regression checks:

```bash
node tests/prompt-quality.test.mjs
node --check app.js
git diff --check
```

`tests/prompt-quality.test.mjs` checks that the extractor and rewrite prompts keep the matching-critical requirements from representative active trial criteria, including age thresholds, Karnofsky/WHO performance status, PSA thresholds, PSMA scan recency, and assertion polarity.

## Optional Live OpenAI Eval

The live eval calls OpenAI and scores real model output against selected active-trial fixtures. It is intentionally opt-in so normal test runs do not spend API tokens.

```bash
OPENAI_LIVE_EVAL=1 OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-5.5 node tests/live-extraction-eval.mjs
```

If `OPENAI_LIVE_EVAL` is not set to `1`, the script exits safely without calling the API. If your key is saved only in the browser app, the terminal cannot access it; pass it as `OPENAI_API_KEY`.

The live eval checks:

- Model output parses as JSON.
- Extracted criteria preserve strict/inclusive thresholds.
- Quantitative criteria produce the expected `structured_target`.
- Negated criteria preserve `assertion`.
- Sanitized output exports to a TrialSchema v1-shaped envelope.

Use the live eval as the prompt optimization loop: run it, inspect failures, improve prompt/schema mapping, rerun.

## Schema

The TrialSchema v1 JSON Schema lives at:

```text
docs/schemas/trialschema.v1.schema.json
```

The interactive schema reference is:

```text
schema.html
```
