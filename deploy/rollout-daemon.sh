#!/usr/bin/env bash
# rollout-daemon.sh <source-dir> <revision>
set -euo pipefail

SOURCE_DIR=${1:?source dir}
REVISION=${2:?revision}
DEPLOY_DIR=${GAIA_DEPLOY_DIR:-/opt/gaia}
SERVICE=${GAIA_SERVICE:-gaia-daemon.service}
BRIDGE_SERVICE=${GAIA_BRIDGE_SERVICE:-gaia-telegram-bridge.service}
PORT=${GAIA_PORT:-8787}
HEALTH_URL=${GAIA_HEALTH_URL:-http://127.0.0.1:${PORT}/}
PUBLIC_HEALTH_URL=${GAIA_PUBLIC_HEALTH_URL:-}
DEPLOY_USER=${GAIA_DEPLOY_USER:-gaia}
DEPLOY_GROUP=${GAIA_DEPLOY_GROUP:-gaia}
HEALTH_RETRIES=${GAIA_HEALTH_RETRIES:-30}

[ "$(id -u)" -eq 0 ] || { echo 'run as root' >&2; exit 1; }
git -C "$SOURCE_DIR" rev-parse --verify "${REVISION}^{commit}" >/dev/null

STAGE=$(mktemp -d "${DEPLOY_DIR}/.deploy-stage.XXXXXX")
BACKUPS=${GAIA_BACKUP_DIR:-${DEPLOY_DIR}/backups}
CURRENT=$(sed -n 's/.*"commit": "\([^"]*\)".*/\1/p' "$DEPLOY_DIR/gaia-source.json" 2>/dev/null | head -1 || true)
CURRENT=${CURRENT:-unknown}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$BACKUPS/${STAMP}-${CURRENT:0:12}"
INSTALLED=0

health() {
  local url=$1 attempt
  for ((attempt = 1; attempt <= HEALTH_RETRIES; attempt++)); do
    if curl --fail --silent --show-error --max-time 10 "$url" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

restore() {
  local status=$?
  trap - ERR
  if [ "$INSTALLED" = 1 ]; then
    echo "rollback: $BACKUP" >&2
    rm -rf "$SOURCE_DIR/node_modules"
    systemctl stop "$SERVICE" || true
    for name in gaia-daemon gaia-telegram-bridge graphql.js gaia-source.json; do
      [ -e "$BACKUP/$name" ] && install -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m "$(stat -c '%a' "$BACKUP/$name")" "$BACKUP/$name" "$DEPLOY_DIR/$name"
    done
    for name in web setups design addons vendor; do
      [ -d "$BACKUP/$name" ] || continue
      rm -rf "$DEPLOY_DIR/$name"
      cp -a "$BACKUP/$name" "$DEPLOY_DIR/$name"
      chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "$DEPLOY_DIR/$name"
    done
    systemctl start "$SERVICE" || true
    health "$HEALTH_URL" || true
    if systemctl is-active --quiet "$BRIDGE_SERVICE"; then systemctl restart "$BRIDGE_SERVICE" || true; fi
  fi
  rm -rf "$STAGE"
  exit "$status"
}
trap restore ERR

mkdir -p "$BACKUP"
for name in gaia-daemon gaia-telegram-bridge graphql.js gaia-source.json web setups design addons vendor; do
  [ -e "$DEPLOY_DIR/$name" ] && cp -a "$DEPLOY_DIR/$name" "$BACKUP/$name"
done

(
  cd "$SOURCE_DIR"
  bun install --frozen-lockfile --cache-dir "$STAGE/bun-cache"
  bun scripts/build-daemon.mjs --out "$STAGE/build" --target bun-linux-x64
)
for name in gaia-daemon gaia-telegram-bridge graphql.js gaia-source.json; do test -f "$STAGE/build/$name"; done
for name in web setups design addons vendor; do test -d "$STAGE/build/$name"; done

systemctl stop "$SERVICE"
INSTALLED=1
for name in gaia-daemon gaia-telegram-bridge; do
  install -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 0755 "$STAGE/build/$name" "$DEPLOY_DIR/$name"
done
for name in graphql.js gaia-source.json; do
  install -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 0644 "$STAGE/build/$name" "$DEPLOY_DIR/$name"
done
for name in web setups design addons vendor; do
  rsync -a --delete --chown="$DEPLOY_USER:$DEPLOY_GROUP" "$STAGE/build/$name/" "$DEPLOY_DIR/$name/"
done

systemctl start "$SERVICE"
health "$HEALTH_URL"
if [ -n "$PUBLIC_HEALTH_URL" ]; then health "$PUBLIC_HEALTH_URL"; fi
if systemctl is-active --quiet "$BRIDGE_SERVICE"; then systemctl restart "$BRIDGE_SERVICE"; fi

trap - ERR
rm -rf "$SOURCE_DIR/node_modules" "$STAGE"
echo "DEPLOYED=true revision=$REVISION backup=$BACKUP"
