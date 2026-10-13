# office-ribbon — этап 1, часть Б (лента Flux, шаблоны, исходная шапка, перенос FluxPanel)

Задание: docs/methodology/03-programs/office.md, раздел «Лента Flux и панель (ТЗ v10)» + «Решения владельца»;
ТЗ docs/office-spec/flux-office-tz-v10.md §3, §4, §13. Ветка claude/custom-table-builder-design-38h1b8, старт 660e7e8. Не пушить.

## Шаги
- [x] 1. Права шаблонов на сервере (общий создаёт любой, правит/удаляет только создатель) + тест
- [ ] 2. «Исходная шапка»: templateId + снимок схемы в части Flux (сервер, state, updateState) + тест
- [ ] 3. Лента Flux в патчах GenOffice (docs/sheets): группы и сообщения flux:open-panel + command
- [ ] 4. Хосты и панель: команды ленты, шаблоны (FluxTemplateControls как окно), переводчик, исходная шапка
- [ ] 5. Перенос «Вставить все», XLSX/CSV/«Книга Flux» в новую панель + сверка со старой
- [ ] 6. Удаление FluxPanel из Word/Excel (OfficeHost, OfficeAppEditor, LocalOfficeEditor), перевод тестов
- [ ] 7. Потолки OfficeHost/OfficeAppEditor в test-architecture.ts, снимки, полные проверки

## Проверки «до»
(идут: /tmp/office-ribbon/tsc-before.log, /tmp/office-ribbon/checks-before.log)

## Остановился
Разведка закончена, код ещё не правился. Решения:
- сообщения ленты: {flux:'office', op:'flux:open-panel', command:'<id>'}; состояние для кнопки «Исходная шапка» хост шлёт событием fluxRibbonState
- снимок шаблона: поле template {templateId,name,appliedAt,anchors} в OfficePackageBindings; state возвращает template.schema
- inject/flux-ribbon.tsx в GenOffice (docs/sheets), сборка GENOFFICE_SRC=/tmp/cx/.cache/genoffice
