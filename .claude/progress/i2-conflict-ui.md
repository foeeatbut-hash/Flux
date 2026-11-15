# И2 (клиент): отказ с изменениями коллеги

Задание: решение в `conflict-details.md` (разделы 1–4, «Договор исполнителей»). Ветка пуша: `claude/funny-thompson-6gb0cd`. Старт: c2fb602. Порты 3421 / 5181, scratch `/tmp/i2-conflict-ui/`.

- [x] 1. `recordChanges.ts`, `changeRules.ts`, `test-record-changes` (23 проверки, 3 мутации убивают)
- [x] 2. `versionedWrite` (gone, open), `ConflictNotice`, `openRecords.ts` + хук `components/useOpenRecords.ts`; наборы test-open-records-client (25), test-conflict-notice (18), test-equipment-version-client (60)
- [ ] 3. Экран «Оборудование»
- [ ] 4. Набор `test-equipment-version-ui`
- [ ] 5. Страница `equipment.md`

Остановился: после шага 2. Дальше шаг 3 (экран). И1 ещё не запушил (refusalTexts, tags в current, маршрут).
