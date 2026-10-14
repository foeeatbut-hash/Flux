# Переводчик Flux Office — дорожка Таблицы (Univer)

Ветка __trs (/tmp/trs), старт 9028592. Спека: docs/codex/task-02-translator.md, контракт: .claude/progress/translator-02.md.
GenOffice-исходники — свой каталог /tmp/trs-gosrc (GENOFFICE_SRC), dist/ собран vite build.

## Шаги
- [x] 1. translation-sheets.ts: чистое ядро (readSheets, planSheetsApply)
- [x] 2. translation-sheets-live.ts: Univer, группа «назад», имена, откат, new-file; установка моста
- [x] 3. patches.mjs: flux-translation-sheets, __fluxSheets.save; build.mjs
- [ ] 4. (в работе) Живые сценарии translator-sheets
- [ ] 5. Регрессия: cells, tsc, test-architecture, test-translation-placement

## Заметки
- Сборка: GENOFFICE_SRC=/tmp/trs-gosrc node tools/genoffice/build.mjs sheets; затем cp -r public/genoffice/sheets dist/genoffice/sheets (index.html должен совпасть).
- Univer: __tempBatchingUndoRedo дописывает undo операций группы в ПРЯМОМ порядке (вставка столбца откатывается раньше значений) — в place() куски по операциям складываются в обратном порядке.
- Любая запись в «назад» чистит «вперёд» — withoutHistory сохраняет и возвращает redo-стек.
- new-file по договору с хостом: apply ставит правки, ответ copyRequest {saved:false} + stepId; Save-As делает хост и затем rollback(stepId).
- Запуск живого набора: bash /tmp/trs-work/run.sh (после bash /tmp/trs-work/rebuild.sh).
- Сделано в сценариях: чтение + adjacent-column + Ctrl+Z/Ctrl+Shift+Z. Остальное — шаг 4.
