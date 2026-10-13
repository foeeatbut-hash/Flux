# office-cell-input
Задание: этап 2 office.md «Ввод в ячейке шапки» — ввод прямо в ячейке (Excel sheets-token-overlay/sheets-collab, Word docs-collab/docs-header-merge), без пункта «Редактировать формулу». Решения владельца: «=» в начале, Backspace 2 нажатия, вставка в позицию курсора. Тесты officeNative*CellActionsScenarios.ts переведены. Ветка office-cell-input, старт 660e7e8. Не пушить.
- [x] 1. Код: overlay (Backspace, initialText, «=»), BeforeSheetEditStart, beginEdit в хосте, Word Backspace/«=»/курсор
- [x] 2. Тесты Excel/Word переведены
- [ ] 3. Сборка редакторов, прогон cells, исправления
- [ ] 4. test-office-*, --office-docs --office-sheets, полный --office-addon-native, документ office.md
