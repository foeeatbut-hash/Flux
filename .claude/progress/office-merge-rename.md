# office-merge-rename

Задание: объединение в одно действие (Excel, Word), плашка «оба заполнены», отображаемое имя параметра, тесты в сценариях ячеек. Решения: docs/methodology/03-programs/office.md «Решения владельца» п.4; ТЗ §8.
Ветка office-merge-rename, старт c7cdda3. Не пушить.
Проверки «до»: tsc 0; run-checks office-cell-actions/header/native-schema/model: только cell-actions-ui падал (нет FLUX_CHROME/сервера).

## Шаги
- [x] 1. Модель (binding.label, union.picks/resolved), сервер cleanBinding/cleanPart, schemaFromNativeHeaders переносит метаданные, подписи в inject
- [x] 2. Хост: меню ПКМ, объединение одним действием, плашка, приоритет, переименование (useFluxCellActions, FluxMergeParts, fluxMergeChoice)
- [ ] 3. Юнит-тесты (model, native-schema, template) 
- [ ] 4. Сценарии Sheets/Word (cells) + FLUX_NATIVE_ONLY=cells, снимки /tmp/merge-badge.png /tmp/chip-rename.png
- [ ] 5. Документация office.md, итоговые проверки
