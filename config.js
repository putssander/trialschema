// Site settings for the hosted app, set once by the maintainer (not by users).
// microsoftClientId: the Entra app registration for "Sign in with Microsoft" (Microsoft 365 Copilot). It is public
// by design (single-page app, no secret). Written by tools/register-entra-app.sh; empty = pasted-token test mode.
window.TRIALSCHEMA_CONFIG = {
  microsoftClientId: "",
};
