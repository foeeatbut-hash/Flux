# E3Flux, этап B, часть 2: таблица IO, рецепт блока, признаки новых классов

Задание: docs/e3-integration.md §13 этап B, §5.2–5.4, 5.9. Ветка claude/serene-bell-t9zviy, НЕ пушить.
Сводка файлов владельца: .claude/progress/e3-stage-b-files.md (содержимое файлов в репозиторий не класть).
Не трогать (чужое): e3/attributes.ts, src/lib/equipmentExchange.ts, e3Table.ts, useSchemeData.ts, E3SchemeCard.tsx, src/components/catalog/*, server/routes/e3Attributes.ts.
Коммитить только свои файлы (общая рабочая копия с другим исполнителем).

Ревизия старта: 6e9b98e. Проверки «до»: run-checks e3-solutions — 2 набора, 0 провалов.

## Шаги
- [ ] 1. e3/ioTable.ts (parseIoSheet), типы в solutionTypes, ioTable в книге, sanitize, план загрузки, чтение листа в E3SolutionsImport
- [ ] 2. e3/recipe.ts (buildRecipe), ioRules/recipeOverride, стартовые правила IO
- [ ] 3. Признаки и правила новых классов в solutionDefaults, classMap КОРОБКА, «Добавить недостающее»
- [ ] 4. Сервер (PUT ioRow, ioRule), сервис клиента
- [ ] 5. Интерфейс: раздел «Таблица IO», «Состав блока», ручной состав
- [ ] 6. Проверки: test-e3-io-table, test-e3-recipe, дополнить test-e3-solutions(-http), tsc, храповик
- [ ] 7. Сухой прогон b.xlsx, снимки, документация (e3flux.md, e3-integration.md)

## Список признаков без источника во Flux
(заполняется по ходу)

## На чём остановился
Начало.
