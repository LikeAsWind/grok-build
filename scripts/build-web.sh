#!/usr/bin/env bash
# Build the Grok web UI frontend and embed it into the Rust binary.
# Usage: ./scripts/build-web.sh [--release]
set -euo pipefail

RELEASE=false
if [ "${1:-}" = "--release" ]; then
  RELEASE=true
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="$SCRIPT_DIR/../web"
CARGO_DIR="$SCRIPT_DIR/.."

echo "==> Installing JS deps..."
cd "$WEB_DIR"
bun install --frozen-lockfile

echo "==> Building frontend..."
bun run build

echo "==> Building Rust binary with web-ui feature..."
cd "$CARGO_DIR"
if [ "$RELEASE" = true ]; then
  cargo build --release --features "xai-grok-pager-bin/web-ui"
  echo "==> Release binary: target/release/xai-grok-pager"
else
  cargo build --features "xai-grok-pager-bin/web-ui"
  echo "==> Debug binary: target/debug/xai-grok-pager"
fi

echo "==> Done. Run with: grok web"
