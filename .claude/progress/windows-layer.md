# Окна Flux вместе с окнами Windows (простой вариант)

Задание: `docs/roadmap/windows-layer.md`, решение владельца 11 ноября — простой
вариант, средствами Electron (`setFocusable`), без нативного помощника.
Ветка `claude/admiring-fermat-tad55v` (PR #165). Ревизия старта `1f17ec4e`.

Шаги:
- [x] 1. Модель `workspace/deskFocus.ts`, `electron/windowForeground.ts`
  (`bringToFront`), `electron/deskFocus.ts` (IPC, выключатель, частота),
  `electron/displayPrefs.ts`, проверка `scripts/test-desk-focus-native.ts`
- [ ] 2. Окно: слежение за указателем, выключатель в «Параметры → Мониторы»,
  проверка в Chromium
- [ ] 3. Документы: `shell.md`, `windows-layer.md`, `studio-next.md`

Проверки «до» (наборы shell/displays/security/architecture): все без UI
проходят; UI-наборы (`*-ui`) в этой среде без `FLUX_CHROME` не запускаются.
После шага 1: tsc код 0; test-desk-focus-native 50 сценариев; displays,
display-workspace, security, architecture — зелёные.

Следующее: шаг 2.
