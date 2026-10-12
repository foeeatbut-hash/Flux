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
- [x] 2. Оболочка: сеанс локальной книги переносит часть Flux при записи и принимает запись хоста (rebase)
- [x] 3. Клиент: источник файла в fluxData/FluxOfficePanel, общий хук моста (useOfficeFluxBridge, OfficeHost/OfficeAppEditor на нём), LocalOfficeEditor (useLocalFluxBridge)
- [x] 4a. Живой сценарий scripts/test-office-explorer-live.ts (guide-server --office-explorer): проходит
- [ ] 4b. Проверки до/после (tsc, test-office-*, guide-server api/files/native, vite build, check:coverage), документ office.md

## Проверки «до»
- tsc: код выхода 0
- native (guide-server --office-addon-native): 5 ✗ — Word Ctrl+Z; Word typing; Word formula persist; issued XLSX read-only; issued grid copy
  (в задании 6: «две проверки выпущенного XLSX», «три Word-формулы»; у меня на старте — см. native-before)
## Остановился
Шаги 1-4a готовы и закоммичены. Осталось: базовый прогон проверок в worktree /tmp/cx-base (2f1a3e9) и сравнение, native-before.txt: 5 ✗; обновить office.md; check:coverage; отчёт. Негативные прогоны (без carry в сеансе, без carry в окне, без rebase) тест ловит.
