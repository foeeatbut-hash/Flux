# ci-flaky — нестабильные проверки CI
Ветка пуша: claude/flux-stage-1-pjmxgt (локально ci-flaky). Старт: dae160c0 (затем 8c7b2b4f). Порты 3220/5220.
Задание: docs/roadmap/studio-next.md, «Очередь до выпуска», п.3.
## Шаги
- [x] 1. test-modules-restart-ui: причина — ошибка теста: страница отдаётся мимо Vite без preamble плагина React ("can't detect preamble"), iframe не появляется. Исправлено добавлением preamble (как в test-feedback-module-ui).
- [ ] 2. Молчаливые пропуски наборов -> docs/testing/ + падение CI
- [ ] 3. test-metrics / Taskbar.tsx — диагностика
- [ ] 4. Диагностика office-native Backspace и Windows chrome-error (FLUX_LOAD_*)
## Заметки
Chromium в контейнере: /opt/pw-browsers/chromium-1243/chrome-linux64/chrome
