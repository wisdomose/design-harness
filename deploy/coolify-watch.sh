#!/usr/bin/env bash
# Redeploys Design Harness in Coolify when a new image is published.
#
# GitHub Actions pushes ghcr.io/wisdomose/design-harness:latest, but the
# Coolify API only accepts calls from this server's Tailscale address, so
# Actions can't trigger the deploy. This runs on the server from cron
# (every 2 minutes), compares the image digest with the last one deployed,
# and asks Coolify to redeploy when it changed. A digest only counts as
# deployed once Coolify reports that deployment finished: a failed one (an
# image pull cut off half way, say) is retried on the next run, up to
# MAX_ATTEMPTS times per digest.
#
#   */2 * * * * APP_UUID=<coolify app uuid> /path/to/coolify-watch.sh
#
# The Coolify token is read from ~/.config/coolify/api-token at run time;
# nothing secret lives in this file.
set -euo pipefail

IMAGE=${IMAGE:-wisdomose/design-harness}
TAG=${TAG:-latest}
APP_UUID=${APP_UUID:?set APP_UUID to the Coolify application uuid}
API=${COOLIFY_API:-http://100.97.237.89:8000/api/v1}
TOKEN_FILE=${COOLIFY_TOKEN_FILE:-$HOME/.config/coolify/api-token}
STATE_DIR=${STATE_DIR:-$HOME/.local/state/design-harness}
LOG=$STATE_DIR/coolify-watch.log
MAX_ATTEMPTS=${MAX_ATTEMPTS:-5}

mkdir -p "$STATE_DIR"
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

# One run at a time: a slow run must not overlap the next cron tick.
exec 9> "$STATE_DIR/lock"
flock -n 9 || exit 0

# Calls the Coolify API, keeping the token out of the process list by
# passing the header on stdin.
coolify() {
  curl -fsS -X "$1" -H @- -H "Accept: application/json" "$API$2" \
    <<< "Authorization: Bearer $(cat "$TOKEN_FILE")"
}

# Public image: anonymous pull token, then the manifest digest.
pull_token=$(curl -fsS "https://ghcr.io/token?scope=repository:$IMAGE:pull" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
digest=$(curl -fsSI \
  -H "Authorization: Bearer $pull_token" \
  -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
  "https://ghcr.io/v2/$IMAGE/manifests/$TAG" |
  awk -F': ' 'tolower($1) == "docker-content-digest" { print $2 }' | tr -d '\r')

if [[ -z $digest ]]; then
  log "could not read the digest of $IMAGE:$TAG"
  exit 1
fi

last=$(cat "$STATE_DIR/last-digest" 2>/dev/null || true)
attempts_digest=""
attempts=0
if [[ -f $STATE_DIR/attempts ]]; then
  read -r attempts_digest attempts < "$STATE_DIR/attempts"
fi
[[ $attempts_digest == "$digest" ]] || attempts=0

# A deploy asked for on an earlier run: wait for it, then record it or let
# it be retried below.
if [[ -f $STATE_DIR/pending ]]; then
  read -r pending_digest pending_uuid < "$STATE_DIR/pending"
  status=$(coolify GET "/deployments/$pending_uuid" |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("status", ""))') || status=unreadable
  case $status in
    queued | in_progress)
      exit 0
      ;;
    finished)
      echo "$pending_digest" > "$STATE_DIR/last-digest"
      last=$pending_digest
      rm -f "$STATE_DIR/pending"
      log "deployed $IMAGE:$TAG @ $pending_digest"
      ;;
    unreadable)
      log "could not read the status of deployment $pending_uuid (will check again)"
      exit 1
      ;;
    *)
      rm -f "$STATE_DIR/pending"
      log "deployment $pending_uuid of $pending_digest ended '$status'"
      if [[ $pending_digest == "$digest" ]] && ((attempts >= MAX_ATTEMPTS)); then
        log "giving up on $digest after $attempts attempts; push a new image or redeploy by hand"
      fi
      ;;
  esac
fi

[[ $digest == "$last" ]] && exit 0
# A digest that keeps failing is not redeployed every two minutes forever;
# a new image starts the count again.
((attempts >= MAX_ATTEMPTS)) && exit 0

if response=$(coolify POST "/deploy?uuid=$APP_UUID&force=false") &&
  uuid=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["deployments"][0]["deployment_uuid"])' <<< "$response"); then
  attempts=$((attempts + 1))
  echo "$digest $uuid" > "$STATE_DIR/pending"
  echo "$digest $attempts" > "$STATE_DIR/attempts"
  log "deploy requested for $IMAGE:$TAG @ $digest ($uuid, attempt $attempts of $MAX_ATTEMPTS)"
else
  log "deploy request failed for $digest (will retry)"
  exit 1
fi
