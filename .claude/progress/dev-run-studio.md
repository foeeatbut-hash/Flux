# dev-run-studio — сторона Studio для «Запустить во Flux»

Ветка пуша: claude/lucid-curie-ffxaso (git push origin HEAD:claude/lucid-curie-ffxaso после rebase). Старт a6fc5056.
Задание: studio/shared/devRun.ts + набор test-studio-dev-run.ts; главный процесс (действия, файлы, аренда, уборка); окно (кнопка, состояние);
проверки и раздел «Запустить во Flux» в docs/methodology/03-programs/studio.md. Чужое: electron/**, src/**, modules/**, scripts/test-modules-dev-run*.ts.
Файл хода в конце НЕ удалять.

## Шаги
- [x] 1 studio/shared/devRun.ts (+ обмен папкой) + scripts/test-studio-dev-run.ts + сертификат с сервера
- [x] 2 главный процесс: действия devRunStart/devRunStop/devRunState, аренда, уборка
- [ ] 3 окно
- [ ] 4 проверки, документация

## Проверки «до»
до: run-checks studio — 23 набора, 1 провал (test-studio-electron-start: нет dist-studio, среда); tsc exit 0. После шага 1: test-studio-dev-run 51 проверка, мутации (userId, автор, подпись, аренда) ловятся.

## Заметки
- /api/studio/certificate отдаёт только статус; для пакета нужен конверт: добавляю поле `certificate` в ответ (server/routes/studioDeveloper.ts).
