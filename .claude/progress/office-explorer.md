# office-explorer: новая панель Flux в Проводнике (этап 1, часть А)

Задание: docs/methodology/03-programs/office.md, раздел «Лента Flux и панель…»,
«Файлы Проводника: что требуется от сервера», «Решения владельца»;
docs/office-spec/audit-v10.md. Часть А: серверные маршруты по содержимому файла,
адаптер «источник файла» в FluxOfficePanel/fluxData, LocalOfficeEditor с
FluxOfficePanel (docx/xlsx, выбор проекта, прежняя панель — ссылкой),
общий хук моста, «Выпустить» скрыт для файлов Проводника, живой сценарий.

Ветка claude/custom-table-builder-design-38h1b8, ревизия старта 2f1a3e9. Не пушить.

## Шаги
- [x] 1. Сервер: office/fluxPart.ts (общий перенос части Flux), маршруты office-local/*, test-office-local.ts
- [ ] 2. Оболочка: сеанс локальной книги переносит часть Flux при записи и принимает запись хоста (rebase)
- [ ] 3. Клиент: источник файла в fluxData/FluxOfficePanel, общий хук моста, LocalOfficeEditor
- [ ] 4. Живой сценарий для Проводника (docx и xlsx), проверки, документ

## Проверки «до»
- tsc: код выхода 0
- native (guide-server --office-addon-native): 5 ✗ — Word Ctrl+Z; Word typing; Word formula persist; issued XLSX read-only; issued grid copy
  (в задании 6: «две проверки выпущенного XLSX», «три Word-формулы»; у меня на старте — см. native-before)
## Остановился
Шаг 1 готов, дальше шаг 2.
