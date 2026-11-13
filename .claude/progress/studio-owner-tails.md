# studio-owner-tails

Задание: два хвоста окна Studio владельца (docs/roadmap/studio-next.md «Осталось от рабочего окна Studio»).
1. Пробный запуск страницы у владельца: flux.openFile выдаёт файл, flux.dialogs показывает настоящие диалоги; общий код с разработчиком вынесен.
2. Окно «Лицензии» перевести в оформление Studio внутри раздела, без отдельного старого окна; поведение не менять. Ключ лицензии и tools/license-generator.html в репозиторий не попадают.
3. Наборы, снимки в обеих темах, studio.md, убрать строки из studio-next.md.

Ветка: claude/flux-stage-1-pjmxgt. Ревизия старта: 3bb4472d (rebase на 8c3fa356).

- [x] Шаг 1: общий код (studio/shell/programFile.ts, studio/renderer/work/programDialog.ts), trialPickFile, TrialDialog, серверные случаи в test-studio-owner-console.ts (110 проверок зелёные)
- [x] Шаг 1б: UI-случай диалогов и файла (кадр-проба вместо flux-module://), 300 проверок UI, снимки в обеих темах
- [ ] Шаг 2: раздел «Лицензии» в консоли, удалить старое окно
- [ ] Шаг 3: документы, снимки

Проверки «до»: tsc 0 ошибок после шага 1.
