#!/bin/sh
# Сборка logic/main.wasm из main.go компилятором TinyGo (https://tinygo.org, проверено на 0.39.0).
# Обычный «большой» Go (GOOS=js) здесь не годится: он требует JS-обёртку wasm_exec с доступом к
# среде браузера, а такие импорты Flux не даёт. TinyGo с целью wasm-unknown не имеет импортов вовсе.
# Память: 1 МиБ в начале, не больше 16 МиБ (предел Flux — 64 МиБ).
set -eu
cd "$(dirname "$0")"
tinygo build -o logic/main.wasm -target=wasm-unknown -scheduler=none -gc=conservative -no-debug \
  -ldflags="-extldflags='--initial-memory=1048576 --max-memory=16777216'" .
