#!/bin/sh
# Сборка logic/main.wasm из src/main.c.
# Нужно: clang 18 с целью wasm32 (Ubuntu: apt install clang lld wasi-libc libclang-rt-dev-wasm32).
# Результат кладётся в logic/main.wasm и лежит в репозитории: CI Flux его не пересобирает.
# Память: 1 МиБ в начале, не больше 16 МиБ (предел Flux — 64 МиБ), стек 64 КиБ.
set -eu
cd "$(dirname "$0")"
clang --target=wasm32-wasi -mexec-model=reactor -O2 -g0 \
  -Wl,--strip-all -Wl,-z,stack-size=65536 -Wl,--initial-memory=1048576 -Wl,--max-memory=16777216 \
  -o logic/main.wasm src/main.c
