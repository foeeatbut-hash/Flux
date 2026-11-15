# И1 (сервер): открытые записи, словарь отказов, маршруты оборудования

Задание: ТЗ — `.claude/progress/conflict-details.md` (разделы 2, 3, 4, «Договор исполнителей»).
Ветка: `claude/funny-thompson-6gb0cd`, старт c2fb602. Push: `git push origin HEAD:claude/funny-thompson-6gb0cd`
после `git fetch origin claude/funny-thompson-6gb0cd` и `git rebase FETCH_HEAD`.

## Шаги

- [x] 1. Словарь `src/lib/refusalTexts.ts`, `server/equipmentStale.ts`, набор `test-refusal-texts`
- [x] 2. Таблица `OpenRecord`, `server/openRecords.ts`, маршруты, набор `test-open-records`
- [ ] 3. `versionGuard`: `openCheck`, `RecordOpen`, `sendRecordOpen`, `sendRecordGone`
- [ ] 4. Маршруты оборудования, `tags` в `current`, набор маршрутов
- [ ] 5. Храповик `test-architecture`, манифест наборов

## Проверки «до» (ревизия c2fb602)

Провалены и до правок (среда): `test-presence` (уход объявляется, когда ушёл последний сокет),
`test-schema-databases` (нужен FLUX_SCHEMA_MARIA_FIXTURE_URL), `test-presence-live` (нужны FLUX_USER/PASS).

## Где остановился

Шаги 1–2 готовы (tsc 0; test-refusal-texts 27 проверок; test-open-records 46 проверок, мутации убиты).
Клиенты Prisma пересозданы в этой копии (`npx prisma generate --schema=...` для трёх схем); package.json клиентов помечены skip-worktree, не коммитить.
Дальше — шаг 3 (`versionGuard`).
