#!/bin/sh
# Сборка logic/main.wasm из Program.cs: .NET 8 SDK + рабочая нагрузка wasi-experimental + wasi-sdk.
# Нужно (один раз):
#   dotnet workload install wasi-experimental
#   скачать wasi-sdk 24 (https://github.com/WebAssembly/wasi-sdk/releases) и указать WASI_SDK_PATH
# Результат ~3,3 МиБ: усечённый (trimmed) .NET-рантайм и программа одним файлом.
# Это «WASI-команда»: вход на stdin, выход на stdout (modules/engine/wasm.ts, вид abi: wasi-command).
set -eu
cd "$(dirname "$0")"
: "${WASI_SDK_PATH:?укажите WASI_SDK_PATH — каталог распакованного wasi-sdk}"
DOTNET_CLI_TELEMETRY_OPTOUT=1 dotnet publish -c Release -o obj/publish
cp obj/Release/net8.0/wasi-wasm/wasm/for-publish/FluxStats.wasm logic/main.wasm
