# office-undo (этап 1 из 2)
Задание: «назад/вперёд» (кнопки и Ctrl+Z / Ctrl+Shift+Z) работают в Word и Excel после любого действия Flux. Запись схемы больше не переоткрывает редактор. Этап 2 (отмена шага Flux возвращает схему) — НЕ делать. Не пушить.
Ветка claude/custom-table-builder-design-38h1b8; старт 008a45d, переложено на origin bbb818c (ветку дважды двигали снаружи).

Шаги:
- [x] 1. Сервер: fluxPartOnly, перенос части Flux при сохранении редактора, rebase сеансов officeHostApps, scripts/test-office-flux-part.ts
- [x] 2. Клиент: нет reopen после схемы/строк, хеш из ответа записи, курсор в ячейку сразу
- [x] 3. Редактор Sheets (inject): метки Flux вне истории, undo/redo не блокируются защитой, Ctrl+Shift+Z
- [x] 4. Тесты native: убраны переоткрытия, добавлены Ctrl+Z/redo после привязки (Excel, Word), правый щелчок в Word-формуле
- [ ] 5. Проверки: tsc, test-office-*, guide-server (api/files/native/docs/sheets/collab), vite

Проверки «до»: /tmp/nat40.log — 4 провала (fallback source-only; Ctrl+Z обеих колонок; Word Ctrl+Z; диалог в formula).
Остановился: шаг 5. Осталось: полный native (/tmp/nat41.log), docs/sheets/collab, итоговый отчёт; перед финалом git rm этого файла.
