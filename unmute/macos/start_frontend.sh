#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../frontend"

export PATH="/opt/homebrew/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required for the Unmute frontend and is not on PATH." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required for the Unmute frontend and is not on PATH." >&2
  echo "Install pnpm, then rerun macos/start_frontend.sh." >&2
  exit 1
fi

pnpm install
exec pnpm dev
