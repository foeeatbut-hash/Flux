# Studio, этап 4а — две сборки и перенос Flux Owner без потерь

Задание: ветка studio/stage-4a от origin/main, один PR-черновик в main. Решение владельца 9.11.2026
(docs/roadmap/modules.md в ветке PR #147). Две сборки из одного кода: FluxStudio.exe (разработчик,
кода владельца физически нет) и FluxStudio-Владелец.exe (по ручному запуску). Таблица переноса Flux Owner в PR.
Базовая ревизия: e3cd01c2. Проверки «до»: owner npm test — 4 набора зелёные; check:verification
в этой рабочей копии падает на симлинке public/genoffice (среда, не код).

Шаги:
- [x] 1. Перенос tools/flux-owner -> studio/owner, общий studio/shared/database-runtime.cjs; пути, манифест
- [x] 2. Серверный вход Studio (server/routes/studio.ts) + набор
- [x] 3. Оболочка разработчика (main/preload/renderer, studio/shell) + сборка (scripts/build-studio.cjs)
- [x] 4. Сборка владельца: owner подключается как раздел, окно владельца открывается из оболочки
- [ ] 5. Проверка бандла разработчика + мутация; снимки окон
- [ ] 6. Workflows (build-studio, build-studio-owner dispatch), verification manifest, удалить build-owner.yml
- [ ] 7. Документы и таблица переноса; PR; CI

Остановились: шаги 1-4 и проверка бандла (scripts/check-studio-bundle.ts, test-studio-*) готовы, tsc зелёный. Дальше: снимки окон (тест UI), workflows, manifest, документы, PR. Локально клиент prisma-sqlite пересобран в рабочей копии (общий устарел): запуск через node -r scratchpad/prisma-local.cjs
