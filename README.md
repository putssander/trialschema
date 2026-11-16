# TrialSchema

TrialSchema is a static, browser-only BYOK app for turning clinical-trial eligibility text into an agent-ready JSON export for patient matching. The app keeps provider credentials (OpenAI key or Microsoft Graph access token) in browser `localStorage`; there is no backend.

## Schema Goal

TrialSchema is designed to tell a matching agent five things clearly:

- What to check: each eligibility criterion is split into one patient-level rule with a clinical `concept`, source text, clarified text, and assertion polarity.
- Where to look: `routing_profile` defines available document types, the default scan set, and the general visit order; each criterion can override that with `routing.primary` and `routing.fallback`.
- How to evaluate: `constraint`, `assertion`, `rank`, and `enabled` tell the agent whether the rule is a comparison, range, code set, existence check, boolean, or LLM-judgement fallback.
- When evidence counts: optional criterion `timing` distinguishes the current state at screening, any history, and an explicit lookback before screening. Missing timing means unspecified.
- Which trials to consider first: `care_path_catalog` and trial-level `care_path_ids` provide normalized care paths, such as `breast_cancer` or `heart_failure`, for first-pass matching before criteria evaluation.
- Care-path ids and labels are English even when source spreadsheet values are Dutch or otherwise local. Source values are kept as aliases. The built-in `cross_care_path` option covers broad values such as `Zorglijn overstijgend`; they should normalize to one cross-domain/cross-care-path bucket, not to every disease-specific care path.

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

Upload an Excel/CSV/JSON/JSONL source, load rows, and process trials with an OpenAI key or a Microsoft Graph access token for Microsoft 365 Copilot Chat API beta. Without a selected-provider credential, the app supports manual copy/paste LLM mode per trial and per criterion.

For Copilot token mode, choose **Copilot token** in the header and paste a short-lived delegated Microsoft Graph bearer token for a work account with a Microsoft 365 Copilot add-on license. The token must include all Microsoft 365 Copilot Chat API delegated scopes: `Sites.Read.All`, `Mail.Read`, `People.Read.All`, `OnlineMeetingTranscript.Read.All`, `Chat.Read`, `ChannelMessage.Read.All`, and `ExternalItem.Read.All`. The app does not attach OneDrive or SharePoint files; it sends the TrialSchema prompt text and requests JSON back.

### Microsoft 365 Copilot Token Testing

Token paste is intended for early testing only. Normal end users should eventually use a built-in **Sign in with Microsoft** flow, because Microsoft Graph access tokens are short-lived and awkward to obtain manually.

For a test token:

1. Open [Microsoft Graph Explorer](https://developer.microsoft.com/graph/graph-explorer) and sign in with the same work account that has Microsoft 365 Copilot API access.
2. Switch to the `beta` endpoint, choose `POST`, and run `/copilot/conversations` with request body `{}`.
3. Copy the returned conversation `id`, then run `POST /copilot/conversations/{id}/chat` with a smoke-test body:

   ```json
   {
     "message": { "text": "Reply with OK." },
     "locationHint": { "timeZone": "Europe/Amsterdam" }
   }
   ```

4. If prompted, use **Modify permissions** or **Consent to permissions**. Tenant admin consent may be required for the Copilot Chat API delegated permission set. Re-copy the token after any consent change.
5. If Graph Explorer exposes an **Access token** panel/menu, copy the bearer token only after both the conversation create and chat calls work, then paste it into TrialSchema's **Copilot token** field.
6. If token copy is unavailable in your Graph Explorer experience, use Postman or move straight to MSAL sign-in; end users should not be asked to perform this manual token step.

If TrialSchema can create a Copilot conversation but the chat call returns `Microsoft Graph HTTP 403`, the `/copilot/conversations` permission check was not enough. Test `POST /copilot/conversations/{id}/chat` with the same account in Graph Explorer. That usually means the user or tenant can reach the Copilot API surface but is still missing one or more required delegated scopes, admin consent, the Microsoft 365 Copilot add-on license, or tenant API entitlement for the chat action. TrialSchema first sends the strict no-web-grounding payload and retries once without the optional web-context block, while still keeping the required `locationHint.timeZone`, so payload compatibility issues are easier to separate from permission failures.

If the chat response contains `It looks like you don't have a valid license`, Graph permissions are not the blocker. Assign or activate the Microsoft 365 Copilot add-on license for the exact signed-in work account, then obtain a fresh Graph token.

If Graph Explorer itself returns `UnknownError` on `POST /copilot/conversations`, the failure is upstream of TrialSchema and happens before any trial prompt is sent. Save the response `request-id`, `client-request-id`, and `date`; those are the values a tenant admin or Microsoft support needs to trace Copilot Chat API availability for that tenant/user.

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

## Evidence Timing (v1.1)

Criteria may include `timing`, independently of their clinical constraint and assertion:

```json
"timing": {
  "scope": "window",
  "lookback": { "value": 5, "unit": "years", "code": "a" },
  "description": "in de afgelopen 5 jaar"
}
```

`current` means the state at screening; `ever` means any history up to screening. Only `window` permits and requires `lookback`, with a positive numeric value and a matching unit/code pair: hours/h, days/d, weeks/wk, months/mo, years/a. `description` is optional and may retain Dutch source wording. Windows always count back from screening. Other anchors, future periods, minimum washouts, and complex timelines stay in the criterion text/guidance with timing omitted. Absence of timing means unspecified, never current by default. Evidence timing concerns the event/measurement date, not simply the document date; do not discard history sections.

The extractor handles English and Dutch cues such as “history of”, “in de voorgeschiedenis”, “eerder”, “momenteel”, “in de afgelopen 5 jaar”, and “niet ouder dan 60 dagen”. Timing supplements the constraint: creatinine clearance ≥ 50 mL/min within 14 days keeps the laboratory threshold and adds a 14-day window.

In **2 Clarify**, edit scope, lookback, and source wording, then **Save timing**. For existing trials, **Suggest timing** can use the selected LLM provider or a copied prompt and pasted JSON response. It fills only missing, unreviewed timing. Existing values and manual choices, including a saved “Unspecified”, are never overwritten; suggestions pending during text edits are skipped. Review applied suggestions before exporting. The manual-review flag is workspace state in the criterion's `extensions["org.trialschema.workspace"].timing_reviewed`, so it survives export/re-import.

Exports now use `format_version: "1.1"`. Existing 1.0 exports remain valid against the updated schema at the same major-version URL. Strict validators pinned to the old schema need an update to accept the new optional field. TrialGPT's loader/matcher integration is a separate downstream change.

## Workspace Preservation

Exports keep agent-facing data and UI workflow state separate:

- `trials[]` contains only processed, structured trials for matching agents. Processed inactive trials remain here with their criteria intact and `enabled: false`.
- Unprocessed source rows are preserved under `extensions["org.trialschema.workspace"].pending_trials`, so they can be processed later without polluting `trials[]`.
- UI archive choices are preserved under `extensions["org.trialschema.workspace"].archived_trial_ids`. Archiving moves a trial out of the main worklist, but does not automatically change `enabled`.

When a previous export is merged with a newer source file, reviewed structured trials, inactive toggles, archive choices, and pending raw rows are preserved so users do not have to repeat prior work.

## Criteria from public registries

```bash
node ingestion/fetch_registries.mjs NCT05350722 NL-OMON52643 2024-510578-25-00   # add --lang nl for Dutch text
```

Fetches the eligibility criteria from ClinicalTrials.gov (API v2), the Dutch register onderzoekmetmensen.nl (public
pages; an official API is available on request via ltr@ccmo.nl) and EU CTIS, and writes
`ingestion/ignore/registry-<date>.json`. Upload that file in the app and run the extraction as usual. `--previous
<earlier file>` lists what changed. The Dutch register and CTIS block browser requests, so this runs outside the app.

## Review document and checks

```bash
npm install                                                              # once (docx library for the tools)
node tools/check-criteria.mjs export.json --structure                    # structure, no model
node tools/check-criteria.mjs export.json --endpoint URL --model M       # faithfulness, any OpenAI-compatible server
node tools/check-criteria.mjs export.json --prompts prompts.md           # copy-paste into Copilot / ChatGPT / Claude
node tools/review-docx.mjs export.json --previous older.json --review findings.json
```

`review-docx` writes `trialschema_<fingerprint>.docx`: an overview, then per trial the source, the original criteria,
the current setup, what changed and open review points. Generate it for every export and archive it next to the JSON.

## Tests

Run the static prompt/schema regression checks:

```bash
node tests/inactive-export.test.mjs
node tests/workspace-roundtrip.test.mjs
node tests/prompt-quality.test.mjs
node tests/timing.test.mjs
node tests/registry-fetch.test.mjs
uv run --with jsonschema python tests/timing-schema.test.py
node --check app.js
git diff --check
```

`tests/prompt-quality.test.mjs` checks that the extractor and rewrite prompts keep the matching-critical requirements from representative active trial criteria, including age thresholds, Karnofsky/WHO performance status, PSA thresholds, PSMA scan recency, and assertion polarity. `tests/timing.test.mjs` checks timing validation, import/export, prompt rules, and protection of manual edits. `tests/timing-schema.test.py` validates actual exports and invalid timing cases against the JSON Schema.

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
- Timing preserves Dutch history cues, explicit current state, and independent laboratory recency, while omitting unsupported anchors and unspecified timing.
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
