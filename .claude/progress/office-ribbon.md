# office-ribbon — этап 1, часть Б (лента Flux, шаблоны, исходная шапка, перенос FluxPanel)

Задание: docs/methodology/03-programs/office.md, раздел «Лента Flux и панель (ТЗ v10)» + «Решения владельца»;
ТЗ docs/office-spec/flux-office-tz-v10.md §3, §4, §13. Ветка claude/custom-table-builder-design-38h1b8, старт 660e7e8. Не пушить.

## Шаги
- [x] 1. Права шаблонов на сервере (общий создаёт любой, правит/удаляет только создатель) + тест
- [x] 2. «Исходная шапка»: templateId + снимок схемы в части Flux (сервер, state, updateState) + тест
- [x] 3. Лента Flux в патчах GenOffice (docs/sheets): группы и сообщения flux:open-panel + command
- [x] 4.(код; проверять в браузере) Хосты и панель: команды ленты, шаблоны (FluxTemplateControls как окно), переводчик, исходная шапка
- [x] 5. Перенос «Вставить все», XLSX/CSV/«Книга Flux» в новую панель + сверка со старой
- [x] 6. Удаление FluxPanel из Word/Excel (OfficeHost, OfficeAppEditor, LocalOfficeEditor), перевод тестов
- [ ] 7. Потолки OfficeHost/OfficeAppEditor в test-architecture.ts, снимки, полные проверки

## Проверки «до»
Чисто (код 0) tsc; run-checks office: без chromium и сервера все *-ui/*-live падают из-за среды (FLUX_CHROME не был задан) — переснять с окружением. Невиновные: test-office-addon-owned-native (6 известных ✗).

## Остановился
Разведка закончена, код ещё не правился. Решения:
- сообщения ленты: {flux:'office', op:'flux:open-panel', command:'<id>'}; состояние для кнопки «Исходная шапка» хост шлёт событием fluxRibbonState
- снимок шаблона: поле template {templateId,name,appliedAt,anchors} в OfficePackageBindings; state возвращает template.schema
- inject/flux-ribbon.tsx в GenOffice (docs/sheets), сборка GENOFFICE_SRC=/tmp/cx/.cache/genoffice

## Сделано после шага 2
- inject/flux-ribbon.tsx + patches (flux-ribbon-docs/-sheets/-body/-import), build.mjs копирует; собрано docs и sheets (GENOFFICE_SRC=/tmp/cx/.cache/genoffice node tools/genoffice/build.mjs docs|sheets) — после правки inject пересобрать оба
- useFluxRibbon.ts (хост), FluxTemplateControls.tsx (окна шаблонов), useOfficeTemplates.ts, fluxTable.ts, FluxExportDialog.tsx; FluxOfficePanel: команды ленты, переводчик, исходная шапка, обновить данные, вставить все
- Хосты: OfficeHost, OfficeAppEditor, LocalOfficeEditor переведены; FluxPanel остаётся для pdf (OfficeAppEditor, LocalOfficeEditor)
## Дальше
- пересобрать genoffice, сверить ленту в браузере (снимки), тесты: сверка старой/новой выгрузки (шаг 5), перевод тестов «Источники и перевод» (шаг 6)
- в test-architecture потолков OfficeHost/OfficeAppEditor НЕТ (лимит 1200) — сообщить в отчёте

## Состояние (после шагов 3-4)
- test-office-explorer-live (guide-server --office-explorer) проходит целиком: лента, шаблоны, исходная шапка, вставить все, выгрузка; test-office-addon-ui (фикстура панели) проходит
- ВАЖНО: чужие файлы inject (sheets-token-overlay, sheets-collab, docs-collab, docs-header-merge) не трогать (их правит другой исполнитель в /tmp/cx2)
- Осталось: шаг 5 сверка старой/новой выгрузки (compare-фикстура), шаг 6 перевод тестов test-windows-file-* и удаление FluxPanel из Word/Excel (код уже удалён из хостов, проверить тесты), шаг 7 проверки и снимки
- Ленту/снимки: /tmp/office-explorer-ribbon-*.png (FLUX_EXPLORER_DARK=1 для тёмной)
