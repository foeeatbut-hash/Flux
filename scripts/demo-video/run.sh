#!/usr/bin/env bash
# Пересборка презентационного видео одной командой: сервер, запись, mp4.
# Переменные: DEMO_OUT_DIR (куда класть результат), DEMO_PORT, DEMO_FAST=1 (черновик без видео).
set -euo pipefail
cd "$(dirname "$0")/../.."
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
exec node_modules/.bin/tsx scripts/demo-video/record.ts
