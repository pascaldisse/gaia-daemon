#!/usr/bin/env bash
# Poll origin; build only commits not already deployed. Optional Space rollout shares this timer.
set -euo pipefail

REPO_URL=${GAIA_REPO_URL:-https://github.com/pascaldisse/gaia-daemon.git}
REPO_DIR=${GAIA_REPO_DIR:-/opt/gaia-source}
BRANCH=${GAIA_BRANCH:-main}
DEPLOY_DIR=${GAIA_DEPLOY_DIR:-/opt/gaia}
LOCK_FILE=${GAIA_AUTO_DEPLOY_LOCK:-/run/lock/gaia-auto-deploy.lock}

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo 'another auto-deploy is running'; exit 0; }

current_daemon_revision() {
  sed -n 's/.*"commit": "\([^"]*\)".*/\1/p' "$DEPLOY_DIR/gaia-source.json" 2>/dev/null | head -1 || true
}

if [ ! -e "$REPO_DIR/.git" ]; then
  [ ! -e "$REPO_DIR" ] || { echo "not a git checkout: $REPO_DIR" >&2; exit 1; }
  git clone --origin origin "$REPO_URL" "$REPO_DIR"
fi
git -C "$REPO_DIR" fetch --prune origin "$BRANCH"
git -C "$REPO_DIR" submodule update --init --recursive
TARGET=$(git -C "$REPO_DIR" rev-parse "origin/$BRANCH")
CURRENT=$(current_daemon_revision)
if [ "$TARGET" = "$CURRENT" ]; then
  echo "gaia-daemon: current $CURRENT"
else
  git -C "$REPO_DIR" checkout --detach "$TARGET"
  GAIA_DEPLOY_DIR="$DEPLOY_DIR" "$REPO_DIR/deploy/rollout-daemon.sh" "$REPO_DIR" "$TARGET"
fi

[ "${GAIA_SPACE_AUTO_DEPLOY:-0}" = 1 ] || exit 0
SPACE_REPO_DIR=${GAIA_SPACE_REPO_DIR:-/opt/gaia-space-repo}
SPACE_REPO_URL=${GAIA_SPACE_REPO_URL:-https://github.com/pascaldisse/gaia-space.git}
SPACE_BRANCH=${GAIA_SPACE_BRANCH:-master}
SPACE_REVISION_FILE=${GAIA_SPACE_REVISION_FILE:-/opt/gaia-space/REVISION}
SPACE_ROLLOUT=${GAIA_SPACE_ROLLOUT:-deploy/rollout.sh}
SPACE_STAGE_ROOT=${GAIA_SPACE_STAGE_ROOT:-/var/tmp}

if [ ! -e "$SPACE_REPO_DIR/.git" ]; then
  [ ! -e "$SPACE_REPO_DIR" ] || { echo "not a git checkout: $SPACE_REPO_DIR" >&2; exit 1; }
  git clone --origin origin "$SPACE_REPO_URL" "$SPACE_REPO_DIR"
fi
git -C "$SPACE_REPO_DIR" fetch --prune origin "$SPACE_BRANCH"
SPACE_TARGET=$(git -C "$SPACE_REPO_DIR" rev-parse "origin/$SPACE_BRANCH")
SPACE_CURRENT=$(cat "$SPACE_REVISION_FILE" 2>/dev/null || true)
if [ "$SPACE_TARGET" = "$SPACE_CURRENT" ]; then
  echo "gaia-space: current $SPACE_CURRENT"
  exit 0
fi

git -C "$SPACE_REPO_DIR" checkout --detach "$SPACE_TARGET"
SPACE_STAGE=$(mktemp -d "$SPACE_STAGE_ROOT/gaia-space-release.XXXXXX")
cleanup_space_stage() { rm -rf "$SPACE_STAGE"; }
trap cleanup_space_stage EXIT
(
  cd "$SPACE_REPO_DIR"
  bun install --frozen-lockfile
  bunx vite build --mode web
  cargo build --manifest-path src-tauri/Cargo.toml --release --no-default-features --bin space-server
  install -d "$SPACE_STAGE/static"
  rsync -a --delete dist-web/ "$SPACE_STAGE/static/"
  install -m 0755 src-tauri/target/release/space-server "$SPACE_STAGE/space-server"
  bash "$SPACE_ROLLOUT" "$SPACE_STAGE" "$SPACE_TARGET"
)
echo "gaia-space: deployed $SPACE_TARGET"
