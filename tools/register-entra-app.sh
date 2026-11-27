#!/usr/bin/env bash
# One-off: register TrialSchema as a single-page app in Microsoft Entra ID, so users "Sign in with Microsoft" for
# Microsoft 365 Copilot instead of pasting Graph tokens. Writes the client id to config.js and prints the admin-consent
# link for the tenant administrator (the Copilot Chat API scopes need admin consent).
#
#   tools/register-entra-app.sh                       # uses the current `az login` account and tenant
#   SITE_URL=https://example.org/trialschema/ tools/register-entra-app.sh
#
# Needs the Azure CLI and permission to create app registrations in the tenant (or ask IT to run it).
# Idempotent: an existing registration with the same name is updated, not duplicated.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${APP_NAME:-TrialSchema}"
SITE_URL="${SITE_URL:-https://sanderputs.com/trialschema/}"
REDIRECTS=("${SITE_URL%/}/auth.html" "http://127.0.0.1:5173/auth.html" "http://localhost:5173/auth.html")
GRAPH=00000003-0000-0000-c000-000000000000
# Microsoft 365 Copilot Chat API (delegated) + sign-in basics.
SCOPES=(Sites.Read.All Mail.Read People.Read.All OnlineMeetingTranscript.Read.All Chat.Read ChannelMessage.Read.All
        ExternalItem.Read.All openid profile offline_access)

az account show -o none 2>/dev/null || az login --allow-no-subscriptions -o none
tenant=$(az account show --query tenantId -o tsv)

access=""
for s in "${SCOPES[@]}"; do
  id=$(az ad sp show --id "$GRAPH" --query "oauth2PermissionScopes[?value=='$s'].id | [0]" -o tsv)
  [ -n "$id" ] || { echo "Graph scope $s not found" >&2; exit 1; }
  access+="{\"id\":\"$id\",\"type\":\"Scope\"},"
done

appid=$(az ad app list --display-name "$NAME" --query "[0].appId" -o tsv)
if [ -z "$appid" ]; then
  appid=$(az ad app create --display-name "$NAME" --sign-in-audience AzureADMultipleOrgs --query appId -o tsv)
  echo "created app registration $NAME ($appid)"
else
  echo "updating app registration $NAME ($appid)"
fi
objid=$(az ad app show --id "$appid" --query id -o tsv)

uris=$(printf '"%s",' "${REDIRECTS[@]}")
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$objid" \
  --headers "Content-Type=application/json" \
  --body "{\"spa\":{\"redirectUris\":[${uris%,}]},\"requiredResourceAccess\":[{\"resourceAppId\":\"$GRAPH\",\"resourceAccess\":[${access%,}]}]}" -o none

# Public client id (no secret): the browser app needs it to start the sign-in.
sed -i.bak -E "s/microsoftClientId: \"[^\"]*\"/microsoftClientId: \"$appid\"/" config.js && rm -f config.js.bak
echo "config.js: microsoftClientId = $appid"
echo
echo "Ask a tenant administrator to grant consent once (Copilot Chat API scopes need admin consent):"
echo "  https://login.microsoftonline.com/$tenant/adminconsent?client_id=$appid"
echo "Each user also needs a Microsoft 365 Copilot licence. Then publish config.js with the site."
