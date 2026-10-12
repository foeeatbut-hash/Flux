# office-native-fix
Цель: scripts/test-guide-server.ts --office-addon-native проходит целиком. Ветка claude/custom-table-builder-design-38h1b8, старт 142b6b8.
- [x] 1. sheetCell/loadSheetAddress/clickCell: evaluate получал элемент вместо аргумента (тест)
- [x] 2. Sheets: get-header-schema слушаем до готовности книги (продукт)
- [x] 3. Word undo: UndoManager отключался регистрацией плагина (продукт)
- [x] 4. Sheets overlay формулы: холст по префиксу id, вставка метки, ввод в inline-вёрстке, защита метки от ввода (продукт)
- [ ] 5. Остались: формула с двумя алиасами (Enter -> состояние/A1), клик по таблице Word после повторного открытия, плавающий Word preview
Последний прогон /tmp/nat22.log: 10 провалов.
- [ ] 5. Остаток последнего полного прогона (/tmp/nat22.log, 10 ✗): формула с двумя алиасами после Enter (состояние, повторное открытие, XML) и каскад stale preview / merge / Ctrl+Z; клик по таблице Word после повторного открытия; «Word changes remain in preview» (нестабильно). Первая причина не установлена — разбирать узким сценарием.
