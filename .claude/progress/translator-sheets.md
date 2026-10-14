# Переводчик Flux Office — дорожка Таблицы (Univer)

Ветка __trs (/tmp/trs), старт 9028592. Спека: docs/codex/task-02-translator.md, контракт: .claude/progress/translator-02.md.
GenOffice-исходники — свой каталог /tmp/trs-gosrc (GENOFFICE_SRC), dist/ собран vite build.

## Шаги
- [ ] 1. translation-sheets.ts: чистое ядро (readSheets, planSheetsApply)
- [ ] 2. translation-sheets-live.ts: Univer, группа «назад», имена, откат, new-file; установка моста
- [ ] 3. patches.mjs: flux-translation-sheets, __fluxSheets.save; build.mjs
- [ ] 4. Живые сценарии translator-sheets
- [ ] 5. Регрессия: cells, tsc, test-architecture, test-translation-placement

## Заметки
- Сборка: GENOFFICE_SRC=/tmp/trs-gosrc node tools/genoffice/build.mjs sheets; затем cp -r public/genoffice/sheets dist/genoffice/sheets (index.html должен совпасть).
