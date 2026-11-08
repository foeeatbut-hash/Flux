#!/bin/sh
# Сборка logic/main.wasm из src/lib.rs.
# Нужно: rustup target add wasm32-unknown-unknown (Rust 1.80 и новее). Зависимостей нет — сеть не нужна.
# Память: 1 МиБ в начале, не больше 16 МиБ (предел Flux — 64 МиБ), стек 64 КиБ.
set -eu
cd "$(dirname "$0")"
RUSTFLAGS="-C link-arg=--initial-memory=1048576 -C link-arg=--max-memory=16777216 -C link-arg=-zstack-size=65536" \
  cargo build --release --target wasm32-unknown-unknown --offline
cp target/wasm32-unknown-unknown/release/flux_stats.wasm logic/main.wasm
