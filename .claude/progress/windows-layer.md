# Окна Flux вместе с окнами Windows (простой вариант)

Задание: `docs/roadmap/windows-layer.md`, решение владельца 11 ноября — простой
вариант, средствами Electron (`setFocusable`), без нативного помощника.
Ветка `claude/admiring-fermat-tad55v` (PR #165). Ревизия старта `1f17ec4e`.

Шаги:
- [x] 1. Модель `workspace/deskFocus.ts`, `electron/windowForeground.ts`
  (`bringToFront`), `electron/deskFocus.ts` (IPC, выключатель, частота),
  `electron/displayPrefs.ts`, проверка `scripts/test-desk-focus-native.ts`
- [x] 2. Окно: слежение за указателем (`src/lib/deskPointer.ts`, метка
  `data-flux-desk` на области стола), выключатель в «Параметры → Мониторы»,
  стенд `desk-focus-ui` и проверка `test-desk-focus-ui.ts` (21, обе темы)
- [x] 3. Документы: `shell.md`, `windows-layer.md`, `studio-next.md`

Проверки «до» (наборы shell/displays/security/architecture): все без UI
проходят; UI-наборы (`*-ui`) в этой среде без `FLUX_CHROME` не запускаются.
После шага 1: tsc код 0; test-desk-focus-native 50 сценариев; displays,
display-workspace, security, architecture — зелёные.

Шаг 2: tsc 0; test-desk-focus-ui 21 проверка; снимки /tmp/windows-layer/shots.
Chromium в среде: /opt/pw-browsers/chromium-1243/chrome-linux64/chrome, Vite на 5231.
test-desktop-creation-ui падает и без моих правок (заголовок «Проводник» не появляется) — не мое.

Шаг 3 готов; осталось удалить файл хода финальным коммитом.
