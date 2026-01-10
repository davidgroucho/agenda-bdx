#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 \"POST_TEXT\" \"IMAGE_URL\" \"LINK_URL\" [\"LINK_TEXT\"]"
  echo "Requires env: PDSHOST ACCESS_JWT DID"
  exit 1
fi

POST_TEXT="$1"
IMAGE_URL="$2"
LINK_URL="$3"
LINK_TEXT="${4:-ici}"

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

if ! echo "$BLOB_JSON" | python3 - <<'PY'
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if "blob" not in data:
    sys.exit(2)
sys.exit(0)
PY
then
  echo "Upload failed. Response:"
  echo "$BLOB_JSON"
  exit 1
fi

BLOB_REF="$(echo "$BLOB_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["blob"]["ref"]["$link"])')"
BLOB_MIME="$(echo "$BLOB_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["blob"]["mimeType"])')"
BLOB_SIZE="$(echo "$BLOB_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["blob"]["size"])')"

PAYLOAD="$(python3 - <<'PY'
import json, sys
from datetime import datetime

post_text = sys.argv[1]
link_url = sys.argv[2]
link_text = sys.argv[3]
did = sys.argv[4]
blob_ref = sys.argv[5]
blob_mime = sys.argv[6]
blob_size = int(sys.argv[7])

text_bytes = post_text.encode("utf-8")
link_bytes = link_text.encode("utf-8")
start = post_text.rfind(link_text)
facets = []
if start != -1 and link_url:
    byte_start = len(post_text[:start].encode("utf-8"))
    byte_end = byte_start + len(link_bytes)
    facets = [{
        "index": {"byteStart": byte_start, "byteEnd": byte_end},
        "features": [{"$type": "app.bsky.richtext.facet#link", "uri": link_url}],
    }]

record = {
    "$type": "app.bsky.feed.post",
    "text": post_text,
    "createdAt": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    "embed": {
        "$type": "app.bsky.embed.images",
        "images": [{
            "image": {"$type": "blob", "ref": {"$link": blob_ref}, "mimeType": blob_mime, "size": blob_size},
            "alt": "Image de l'evenement",
        }]
    }
}
if facets:
    record["facets"] = facets

payload = {
    "repo": did,
    "collection": "app.bsky.feed.post",
    "record": record,
}
print(json.dumps(payload))
PY
  "$POST_TEXT" "$LINK_URL" "$LINK_TEXT" "$DID" "$BLOB_REF" "$BLOB_MIME" "$BLOB_SIZE")"

curl -sX POST "$PDSHOST/xrpc/com.atproto.repo.createRecord" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_JWT" \
  -d "$PAYLOAD"
