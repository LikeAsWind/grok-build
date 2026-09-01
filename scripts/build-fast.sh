#!/usr/bin/env bash
# Bash counterpart of scripts/build-fast.ps1.
# Linux/macOS: sets up sccache + mold linker + parallel codegen pipeline.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Locate sccache
SCCACHE_BIN=""
for cand in "$HOME/.cargo/bin/sccache" /usr/local/bin/sccache; do
    if [[ -x "$cand" ]]; then SCCACHE_BIN="$cand"; break; fi
done

if [[ -n "$SCCACHE_BIN" ]]; then
    export RUSTC_WRAPPER="$SCCACHE_BIN"
    export SCCACHE_CLIENT_SIDE=1
    if [[ -d /tmp/sccache ]]; then
        export SCCACHE_DIR=/tmp/sccache
    else
        export SCCACHE_DIR="$HOME/.cache/sccache"
    fi
    mkdir -p "$SCCACHE_DIR"
    echo "[build-fast] sccache: $SCCACHE_BIN" >&2
    echo "[build-fast] cache:   $SCCACHE_DIR" >&2
else
    echo "[build-fast] sccache not found. Install with: cargo install sccache --locked" >&2
    echo "[build-fast] Continuing WITHOUT rust cache (slow)." >&2
fi

# CARGO_INCREMENTAL is incompatible with sccache (sccache wraps rustc and cannot
# share incremental metadata between cache misses and hits). When sccache is active,
# force full recompile through sccache. When sccache is absent, use cargo default
# incremental compilation.
if [[ -n "$SCCACHE_BIN" ]]; then
    export CARGO_INCREMENTAL=0
else
    export CARGO_INCREMENTAL=1
fi

CMD="${1:-check}"
shift || true
JOBS_FLAG=""
if [[ -n "${JOBS:-}" ]]; then JOBS_FLAG="-j$JOBS"; fi

cd "$PROJECT_ROOT"
START=$(date +%s)
echo "[build-fast] cargo $CMD $*" >&2

case "$CMD" in
    check)    cargo check --workspace --all-targets $JOBS_FLAG "$@" ;;
    build)    cargo build --workspace $JOBS_FLAG "$@" ;;
    test)     cargo test --workspace $JOBS_FLAG "$@" ;;
    nextest)
        if command -v cargo-nextest >/dev/null 2>&1; then
            cargo nextest run --workspace $JOBS_FLAG "$@"
        else
            echo "[build-fast] cargo-nextest not installed; falling back to cargo test" >&2
            cargo test --workspace $JOBS_FLAG "$@"
        fi
        ;;
    clippy)   cargo clippy --workspace --all-targets $JOBS_FLAG "$@" ;;
    bench)    cargo bench --workspace $JOBS_FLAG "$@" ;;
    fmt)      cargo fmt --all "$@" ;;
    info)
        rustc --version
        cargo --version
        if [[ -n "$SCCACHE_BIN" ]]; then
            $SCCACHE_BIN --version
            $SCCACHE_BIN -s 2>/dev/null | head -10
        else
            echo "sccache: NOT INSTALLED" >&2
        fi
        ;;
    clean)
        echo "[build-fast] Refusing cargo clean target/ wholesale; kills deps cache." >&2
        echo "[build-fast] Use cargo clean -p <crate> for surgical cleanup." >&2
        exit 1
        ;;
    *) echo "Unknown cmd: $CMD (use check|build|test|nextest|clippy|bench|fmt|info|clean)"; exit 1 ;;
esac

END=$(date +%s)
ELAPSED=$((END - START))
printf "[build-fast] done in %d:%02d\n" $((ELAPSED / 60)) $((ELAPSED % 60)) >&2
