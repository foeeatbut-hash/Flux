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

# prisma generate переписывает в prisma-clients/*/package.json хеш в поле
# name, хотя схема та же. Файлы лежат в git, и без отката каждая сессия
# заканчивается «незакоммиченными правками», которых никто не делал. Откатывать
# только когда отличие — одно это поле: настоящую правку не трогать.
for f in prisma-clients/client-*/package.json; do
  git diff --quiet -I '"name": "prisma-client-' -- "$f" 2>/dev/null && git checkout -q -- "$f" 2>/dev/null || true
done

# Бинарник Electron — для наборов, которые запускают настоящее окно
# (feedback-capture, office-electron-live). Установщик npm качает архив одним
# куском и на обрыве сдаётся; curl докачивает с места обрыва, а контрольная
# сумма сверяется с официальным списком, так что битый архив не встанет.
# Не вышло — не беда: сессия работает, падают только эти наборы.
electron_ver=$(node -p "require('./node_modules/electron/package.json').version")
if [ "$(cat node_modules/electron/dist/version 2>/dev/null)" != "$electron_ver" ]; then
  (
    set +e
    base="https://github.com/electron/electron/releases/download/v$electron_ver"
    zip="electron-v$electron_ver-linux-x64.zip"
    tmp=$(mktemp -d)
    for _ in 1 2 3 4 5 6; do curl -sSL -C - --max-time 300 -o "$tmp/$zip" "$base/$zip" && break; sleep 2; done
    want=$(curl -sSL --max-time 60 "$base/SHASUMS256.txt" | grep " \*$zip\$" | cut -d' ' -f1)
    got=$(sha256sum "$tmp/$zip" 2>/dev/null | cut -d' ' -f1)
    if [ -n "$want" ] && [ "$want" = "$got" ]; then
      rm -rf node_modules/electron/dist
      unzip -q "$tmp/$zip" -d node_modules/electron/dist
      [ -f node_modules/electron/dist/electron.d.ts ] && mv node_modules/electron/dist/electron.d.ts node_modules/electron/
      printf electron > node_modules/electron/path.txt
    else
      echo "Flux: Electron не скачался — наборы с настоящим окном упадут." >&2
    fi
    rm -rf "$tmp"
  )
fi

# Редакторы Flux Office (public/genoffice) в git не лежат — их собирает
# tools/genoffice/build.mjs из исходников GenOffice, около четырёх минут. Без
# них Блокнот, Таблица и Документ открываются окном «Редактор не установлен», и
# test-flow падает на заметке. Сборка идёт в фоне, чтобы не держать начало
# сессии; ход — в /tmp/flux-genoffice.log, готовность — появление каталога.
if [ ! -f public/genoffice/markdown/index.html ] && ! pgrep -f "genoffice/buil[d].mjs" >/dev/null; then
  setsid nohup node tools/genoffice/build.mjs all >/tmp/flux-genoffice.log 2>&1 </dev/null &
  echo "Flux: редакторы Office собираются в фоне (~4 мин, /tmp/flux-genoffice.log)."
fi

echo "Flux: зависимости и клиенты Prisma готовы."
