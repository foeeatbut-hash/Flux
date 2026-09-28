#!/usr/bin/env bash
# Подготовка облачной сессии Claude Code: зависимости и клиенты Prisma.
#
# Зачем: контейнер каждой сессии чистый, и без этого первые 20–30 минут уходят
# на то, чтобы tsc перестал сыпать «Cannot find module». Повторный запуск
# почти мгновенный: npm ci и prisma generate идут, только если изменились
# package-lock.json или схемы — это помечается отпечатком в node_modules.
#
# Electron ставится без бинарника: через прокси облака загрузка обрывается, а
# для проверок он не нужен (exe собирается в GitHub Actions, skill flux-release).
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}"

stamp() { cat "$@" | sha256sum | cut -c1-16; }

lock=$(stamp package-lock.json)
if [ "$(cat node_modules/.flux-lock 2>/dev/null)" != "$lock" ]; then
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund --loglevel=error >/dev/null
  echo "$lock" > node_modules/.flux-lock
  rm -f node_modules/.flux-prisma
fi

schemas=$(stamp prisma/schema.prisma prisma/schema.postgresql.prisma prisma/schema.mariadb.prisma)
if [ "$(cat node_modules/.flux-prisma 2>/dev/null)" != "$schemas" ] || [ ! -f prisma-clients/client-sqlite/index.js ]; then
  for s in schema.prisma schema.postgresql.prisma schema.mariadb.prisma; do
    npx prisma generate --schema="prisma/$s" >/dev/null 2>&1
  done
  echo "$schemas" > node_modules/.flux-prisma
fi

echo "Flux: зависимости и клиенты Prisma готовы."
