#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing command: $1" >&2; exit 1; }
}

if [[ -z "${PDSHOST:-}" ]]; then
  echo "Missing env: PDSHOST" >&2
  exit 1
fi

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 \"HANDLE_OR_EMAIL\" \"APP_PASSWORD\"" >&2
  echo "Example: PDSHOST=\"https://bsky.social\" $0 \"you.bsky.social\" \"xxxx-xxxx-xxxx-xxxx\"" >&2
  exit 1
fi

require_cmd curl
require_cmd python3

IDENTIFIER="$1"
APP_PASSWORD="$2"

set +e
RESPONSE="$(curl -sSX POST "$PDSHOST/xrpc/com.atproto.server.createSession" \
  -H "Content-Type: application/json" \
  -d "{
    \"identifier\": \"${IDENTIFIER//\"/\\\"}\",
    \"password\": \"${APP_PASSWORD//\"/\\\"}\"
  }" -w "\n__HTTP_STATUS__:%{http_code}")"
curl_exit=$?
set -e

if [[ $curl_exit -ne 0 ]]; then
  echo "Login failed. Curl error:" >&2
  echo "$RESPONSE" >&2
  exit 1
fi

SESSION_JSON="${RESPONSE%$'\n__HTTP_STATUS__:'*}"
HTTP_STATUS="${RESPONSE##*$'\n__HTTP_STATUS__:'}"
if [[ -z "$SESSION_JSON" ]]; then
  echo "Login failed. Empty response (HTTP $HTTP_STATUS)." >&2
  echo "Raw response: $RESPONSE" >&2
  exit 1
fi

if ! python3 - <<'PY' "$SESSION_JSON"
import sys, json
raw = sys.argv[1]
try:
    data = json.loads(raw)
except Exception:
    raise SystemExit(1)
if "accessJwt" not in data or "did" not in data:
    raise SystemExit(1)
print(f'export ACCESS_JWT="{data["accessJwt"]}"')
print(f'export DID="{data["did"]}"')
PY
then
  echo "Login failed. Response:" >&2
  echo "$SESSION_JSON" >&2
  exit 1
fi
