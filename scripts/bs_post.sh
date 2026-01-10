#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 \"POST_TEXT\" \"IMAGE_URL\""
  echo "Requires env: PDSHOST ACCESS_JWT DID"
  exit 1
fi

POST_TEXT="$1"
IMAGE_URL="$2"

if [[ -z "${PDSHOST:-}" || -z "${ACCESS_JWT:-}" || -z "${DID:-}" ]]; then
  echo "Missing env. Set PDSHOST, ACCESS_JWT, and DID."
  exit 1
fi

TMP_IMG="$(mktemp /tmp/bs_image.XXXXXX)"
cleanup() { rm -f "$TMP_IMG"; }
trap cleanup EXIT

curl -L "$IMAGE_URL" -o "$TMP_IMG"

BLOB_JSON="$(curl -sX POST "$PDSHOST/xrpc/com.atproto.repo.uploadBlob" \
  -H "Authorization: Bearer $ACCESS_JWT" \
  -H "Content-Type: image/jpeg" \
  --data-binary @"$TMP_IMG")"

BLOB_REF="$(echo "$BLOB_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["blob"]["ref"]["$link"])')"
BLOB_MIME="$(echo "$BLOB_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["blob"]["mimeType"])')"
BLOB_SIZE="$(echo "$BLOB_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["blob"]["size"])')"

curl -sX POST "$PDSHOST/xrpc/com.atproto.repo.createRecord" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_JWT" \
  -d "{
    \"repo\": \"$DID\",
    \"collection\": \"app.bsky.feed.post\",
    \"record\": {
      \"\$type\": \"app.bsky.feed.post\",
      \"text\": \"${POST_TEXT//\"/\\\"}\",
      \"createdAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
      \"embed\": {
        \"\$type\": \"app.bsky.embed.images\",
        \"images\": [
          {
            \"image\": {
              \"\$type\": \"blob\",
              \"ref\": { \"\$link\": \"$BLOB_REF\" },
              \"mimeType\": \"$BLOB_MIME\",
              \"size\": $BLOB_SIZE
            },
            \"alt\": \"Image de l'evenement\"
          }
        ]
      }
    }
  }"
