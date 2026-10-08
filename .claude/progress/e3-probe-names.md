# e3-probe-names — проба E3 «по списку названий» и выгрузка названий из Flux

Ветка claude/serene-bell-t9zviy, старт 66d77be, PR #100 открыт. Коммитить, НЕ пушить.
Задание (кратко): 1) Flux: кнопка «Скачать названия для пробы» -> e3-names.txt (чистая функция в e3/solutionWorkbook.ts + проверка в test-e3-solutions);
2) проба -NamesFile (lib/names.ps1), только чтение, без Y: символ+габарит / компонент / подсхема; names-report.json, сводка, время на имя;
3) -PlaceSample N (с Y): временный лист, поставить первые N найденных, картинка листа, удалить лист;
4) fake-e3 + scripts/test-e3-probe.ts + README «Проверка по списку названий»; 5) проверки: test-e3-probe, test-e3-solutions, tsc, храповик.

## Шаги
- [x] 1 Flux: функция solutionNames + кнопка + проверка
- [ ] 2 lib/names.ps1 + -NamesFile в e3-probe.ps1
- [ ] 3 -PlaceSample N
- [ ] 4 fake-e3, test-e3-probe, README
- [ ] 5 проверки и отчёт

## До правок
test-e3-probe (pwsh 7.4.6 скачан в /tmp/e3-probe-names/pwsh, FLUX_PWSH + DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1): пройдено 155, провалено 0.
