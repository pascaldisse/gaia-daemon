#!/bin/bash
# Manual/foreground entry point for the durable cloudflared tunnel.
# The launchd agent (com.gaia.cloudflared) invokes tunnel-up.mjs directly
# with an absolute bun path; this wrapper is for running it by hand.
set -euo pipefail
cd "$(dirname "$0")/.."
exec bun scripts/tunnel-up.mjs
