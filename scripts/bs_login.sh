#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${PDSHOST:-}" ]]; then
  echo "Missing env: PDSHOST"
  exit 1
fi

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 \"HANDLE_OR_EMAIL\" \"APP_PASSWORD\""
  echo "Example: PDSHOST=\"https://bsky.social\" $0 \"you.bsky.social\" \"xxxx-xxxx-xxxx-xxxx\""
  exit 1
fi

IDENTIFIER="$1"
APP_PASSWORD="$2"

SESSION_JSON="$(curl -sX POST "$PDSHOST/xrpc/com.atproto.server.createSession" \
  -H "Content-Type: application/json" \
  -d "{
    \"identifier\": \"${IDENTIFIER//\"/\\\"}\",
    \"password\": \"${APP_PASSWORD//\"/\\\"}\"
  }")"

if ! echo "$SESSION_JSON" | python3 - <<'PY'
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if "accessJwt" not in data or "did" not in data:
    sys.exit(2)
sys.exit(0)
PY
then
  echo "Login failed. Response:"
  echo "$SESSION_JSON"
  exit 1
fi

ACCESS_JWT="$(echo "$SESSION_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["accessJwt"])')"
DID="$(echo "$SESSION_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["did"])')"

echo "export ACCESS_JWT=\"$ACCESS_JWT\""
echo "export DID=\"$DID\""
