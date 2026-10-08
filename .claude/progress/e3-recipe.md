# E3Flux, этап B, часть 2: таблица IO, рецепт блока, признаки новых классов

Задание: docs/e3-integration.md §13 этап B, §5.2–5.4, 5.9. Ветка claude/serene-bell-t9zviy, НЕ пушить.
Сводка файлов владельца: .claude/progress/e3-stage-b-files.md (содержимое файлов в репозиторий не класть).
Не трогать (чужое): e3/attributes.ts, src/lib/equipmentExchange.ts, e3Table.ts, useSchemeData.ts, E3SchemeCard.tsx, src/components/catalog/*, server/routes/e3Attributes.ts.
Коммитить только свои файлы (общая рабочая копия с другим исполнителем).

Ревизия старта: 6e9b98e. Проверки «до»: run-checks e3-solutions — 2 набора, 0 провалов.

## Шаги
- [x] 1. e3/ioTable.ts (parseIoSheet), типы в solutionTypes, ioTable в книге, sanitize, план загрузки (чтение листа в E3SolutionsImport — ещё нет, в шаге 5)
- [x] 2. e3/recipe.ts (buildRecipe), ioRules/recipeOverride, стартовые правила IO (e3/ioDefaults.ts)
- [x] 3. Признаки и правила новых классов (solutionDefaults + solutionRules), classMap КОРОБКА, «Добавить недостающее» (e3/solutionMissing.ts)
- [x] 4. Сервер (PUT io-row, io-rule, defaults/plan|apply), сервис клиента
- [x] 5. Интерфейс: раздел «Таблица IO» (E3IoPanel, E3IoRowDialog, E3IoRuleDialog), «Состав блока» в E3SelectionDialog, ручной состав в E3SolutionDialog, «Добавить недостающее» в Признаках, чтение листа в E3SolutionsImport
- [x] 6. Проверки: test-e3-io-table, test-e3-recipe, test-e3-solutions(-http) дополнены, tsc 0, test-architecture проходит
- [ ] 7. Сухой прогон b.xlsx, снимки, документация (e3flux.md, e3-integration.md)

## Список признаков без источника во Flux
(заполняется по ходу)

## Решения по ходу
- Правило IO ссылается на строку не по id, а по {группа, часть наименования, обозначение}; рецепт: e3/recipe.ts, правила: book.ioRules.
- Ручной состав: E3Solution.recipeOverride (строки роль|строка IO|число).
- Подбор: ответ решения «любой» подходит к любому вопросу (типоразмер узла).
- Правила признаков берут источники из словаря САПР (server/vezaDict.ts): «Группы нагрева», «Схема обвязки», «Типоразмер узла», подпозиции КОРОБКА/ДАТЧИК/ОСНАЩЕНИЕ, вид позиции.
- Наборы: test-e3-io-table, test-e3-recipe, test-e3-solutions проходят.

## На чём остановился
Шаги 1–6 сделаны. Дальше шаг 7: сухой прогон b.xlsx (скрипт в scratchpad), снимки Playwright (раздел «Таблица IO», «Состав блока»), документация e3flux.md и e3-integration.md, список признаков без источника.
