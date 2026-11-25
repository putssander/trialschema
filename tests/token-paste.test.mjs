// Copilot token paste: the token is found in whatever was copied, checked locally, and an expired one stops cleanly.
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let fetched = 0;
const context = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, atob, btoa,
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } },
  window: {}, Blob: class {}, File: class {},
  fetch: async () => { fetched++; return { ok: true, json: async () => ({ id: "c" }) }; },
};
vm.createContext(context);
vm.runInContext(readFileSync(join(root, "app.js"), "utf8"), context);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const SCOPES = "Sites.Read.All Mail.Read People.Read.All OnlineMeetingTranscript.Read.All Chat.Read ChannelMessage.Read.All ExternalItem.Read.All";
const now = Date.now();
const token = (claims) => `eyJ${b64({ alg: "RS256" }).slice(3)}.${b64(claims)}.sig_part-1`;
const good = token({ aud: "https://graph.microsoft.com", upn: "a.user@example.org", scp: SCOPES, exp: Math.floor(now / 1000) + 45 * 60 });
assert.ok(good.startsWith("eyJ") && good.split(".")[1].startsWith("eyJ"));

// Found in every usual form of copy.
for (const pasted of [good, `Bearer ${good}`, `Authorization: Bearer ${good}`, JSON.stringify({ access_token: good }),
  `curl -H "Authorization: Bearer ${good}" https://graph.microsoft.com/v1.0/me`]) {
  assert.equal(context.extractGraphToken(pasted), good);
}
assert.equal(context.extractGraphToken("not a token"), "");

// Status: account and minutes left; problems named.
assert.match(context.copilotTokenStatus(good, now).text, /^a\.user@example\.org · 4[45] min left$/);
const expired = token({ aud: "https://graph.microsoft.com", scp: SCOPES, exp: Math.floor(now / 1000) - 60 });
assert.equal(context.copilotTokenStatus(expired, now).text, "token expired: paste a new one");
const partial = token({ aud: "https://graph.microsoft.com", scp: "Mail.Read", exp: Math.floor(now / 1000) + 3600 });
assert.match(context.copilotTokenStatus(partial, now).text, /^missing permission: Sites\.Read\.All/);
assert.equal(context.copilotTokenStatus(token({ aud: "https://management.azure.com", exp: Math.floor(now / 1000) + 3600 }), now).text,
  "token is not for Microsoft Graph");
assert.equal(context.copilotTokenStatus("abc", now).text, "not a Microsoft token");

// An expired token is not a credential, and Graph is never called with it.
vm.runInContext(`state.llmProvider = "copilot"; state.copilotToken = ${JSON.stringify(expired)};`, context);
assert.equal(context.hasLLMCredentials(), false);
await assert.rejects(context.graphFetchJson("https://graph.microsoft.com/beta/copilot/conversations", { body: {} }), /expired at .* paste it/);
assert.equal(fetched, 0);
vm.runInContext(`state.copilotToken = ${JSON.stringify(good)};`, context);
assert.equal(context.hasLLMCredentials(), true);

console.log("Token paste checks passed.");
