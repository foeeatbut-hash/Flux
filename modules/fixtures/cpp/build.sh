#!/bin/sh
# Сборка logic/main.wasm из src/main.cpp.
# Нужно: clang 18 с целью wasm32 и libc++ для неё
#   (Ubuntu: apt install clang lld wasi-libc libclang-rt-dev-wasm32 libc++-18-dev-wasm32 libc++abi-18-dev-wasm32).
# Исключения и RTTI выключены: размер в разы меньше, а Flux всё равно остановит расчёт по ловушке.
set -eu
cd "$(dirname "$0")"
clang++ --target=wasm32-wasi -mexec-model=reactor -std=c++20 -O2 -g0 -fno-exceptions -fno-rtti \
  -Wl,--strip-all -Wl,-z,stack-size=65536 -Wl,--initial-memory=1048576 -Wl,--max-memory=16777216 \
  -o logic/main.wasm src/main.cpp
