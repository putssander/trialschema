// Microsoft sign-in session: config, silent refresh before expiry, sign-out on a failed refresh. Token endpoint mocked.
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = new Map();
let tokenCalls = [];
let refreshOk = true;
const idToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

const context = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, atob, btoa,
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
  document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } },
  window: { TRIALSCHEMA_CONFIG: { microsoftClientId: "11111111-2222-3333-4444-555555555555" } },
  location: { href: "https://sanderputs.com/trialschema/?x=1#y" },
  Blob: class {}, File: class {},
  async fetch(url, opts) {
    tokenCalls.push({ url, body: String(opts.body) });
    if (!refreshOk) return { ok: false, status: 400, json: async () => ({ error: "invalid_grant", error_description: "AADSTS700082: The refresh token has expired.\r\nTrace ID: 1" }) };
    return { ok: true, status: 200, json: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, id_token: idToken({ tid: "tenant-1", preferred_username: "a@b.org" }) }) };
  },
};
vm.createContext(context);
vm.runInContext(readFileSync(join(root, "app.js"), "utf8"), context);

assert.equal(context.msConfig().clientId, "11111111-2222-3333-4444-555555555555");
assert.equal(context.msRedirectUri(), "https://sanderputs.com/trialschema/auth.html");
assert.equal(context.b64url(new Uint8Array([251, 255, 0])), "-_8A", "base64url without padding");
assert.match(vm.runInContext("MS_SCOPE", context), /https:\/\/graph\.microsoft\.com\/Sites\.Read\.All .*offline_access/);

// Fresh token: no network.
store.set("trialschema.ms.session", JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_at: Date.now() + 3600e3, tenant: "tenant-1" }));
assert.equal(await context.msAccessToken(), "a1");
assert.equal(tokenCalls.length, 0);

// Expiring within five minutes: refresh against the user's tenant, keep the session.
store.set("trialschema.ms.session", JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_at: Date.now() + 60e3, tenant: "tenant-1" }));
assert.equal(await context.msAccessToken(), "new-access");
assert.equal(tokenCalls[0].url, "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
assert.match(tokenCalls[0].body, /grant_type=refresh_token/);
assert.match(tokenCalls[0].body, /refresh_token=r1/);
assert.equal(JSON.parse(store.get("trialschema.ms.session")).username, "a@b.org");

// Refresh refused: session cleared, clear message.
refreshOk = false;
store.set("trialschema.ms.session", JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_at: Date.now() - 1, tenant: "tenant-1" }));
await assert.rejects(context.msAccessToken(), /AADSTS700082: The refresh token has expired\. Sign in again\./);
assert.equal(store.has("trialschema.ms.session"), false);

console.log("Microsoft sign-in checks passed.");
