**Решение руководителя (16.11.2026): вариант A.** Расширение Prisma (`query`) не умеет писать в транзакцию вызывающего: опыт на PostgreSQL — запись через клиент из замыкания пережила откат транзакции (на SQLite она откатывалась лишь потому, что у адаптера одно соединение). Поэтому: обёртка над `$transaction` кладёт клиент транзакции в AsyncLocalStorage, хук пишет журнал через него; одиночный запрос хук сам оборачивает в транзакцию; пакетные `$transaction([...])` переведены на интерактивные; запись по внешнему клиенту внутри открытой транзакции или пакетная форма с версионной моделью — громкая ошибка.

# Строка 6: журнал изменений; «кто создал и когда»; «кто изменил» в отказе

Решения руководителя (владелец не на связи). Основа — `docs/roadmap/offline-work.md`,
«1. Журнал изменений на сервере» (1.1–1.3, 1.5) и «Решения владельца (15 ноября
2026)», п. 8: автор и время создания берутся из журнала, отдельные колонки
автора не заводятся.

## Что делаем
1. **Таблица `ChangeFeed`** (общая база и локальная SQLite; создаётся тем же
   путём, что `OpenRecord`/`OpReceipt` — посмотреть `server/openRecords.ts`,
   `server/ddl.ts`, `schema-sync.ts`): `seq` (растущий номер), `projectId`
   (может быть пустым), `model` (имя модели схемы), `recordId`, `version`,
   `kind` (`create` / `update` / `delete`), `userId`, `userName`, `at` (время
   сервера).
2. **Кто пишет** — расширение клиента Prisma рядом с `server/versionBump.ts`
   (новый `server/changeFeed.ts`, подключается в `createPrismaClient`): всякий
   create/createMany/update/updateMany/upsert/delete/deleteMany по
   `VERSIONED_MODELS` оставляет строку журнала **в той же транзакции**, что и
   сама запись (откат записи — нет и строки). `updateMany`/`deleteMany`
   сначала выбирают id. Запись с `keepVersion` в журнал не идёт. Кто —
   из запроса: `AsyncLocalStorage`, которую заполняет общее звено `/api/*`
   (`req.authUser`); вне запроса — пусто («система»).
   Если расширение Prisma не может писать в транзакцию вызывающего — не
   городить обход: остановиться и сообщить руководителю с точной причиной.
3. **Мимо расширения** (сырой SQL, вложенные записи, каскад базы): каскад
   удаления проекта и пункта справочника пишет строки удаления детей явно
   (id выбраны до удаления); остальные места — перечень в отчёте, руководитель
   внесёт в храповик `test-architecture`.
4. **Очистка**: строки старше 90 дней удаляются при старте сервера, кроме
   строк `create` (по ним показывается автор).
5. **«Кто изменил» в отказе**: `sendVersionConflict` добавляет в ответ
   `changedBy: { userId, name, at } | null` — последняя строка журнала по
   записи (`current`). Клиент: `ConflictNotice` получает необязательную строку
   «Изменил: Иванов И. И., 16.11.2026 12:30» (текст — из `refusalTexts.ts`).
6. **«Кто создал и когда»**: `GET /api/record-origin?model=&id=` →
   `{ createdBy: { userId, name } | null, createdAt | null }` — из строки
   `create` журнала, а если её нет — из колонок `createdAt`/`createdById`
   записи, где они есть. Общий маленький компонент
   `src/components/ui/RecordOrigin.tsx` («Создал: …, 16.11.2026») ставится в
   карточки: проект, тег, позиция оборудования, строка ВДР, пункт справочника.
7. Живые обновления у коллег из журнала (1.4) — НЕ в этой строке; остаётся в
   плане.

## Чем доказывается
- `scripts/test-change-feed.ts` (SQLite): каждая операция по каждой из 12
  моделей оставляет строку; откат транзакции — строки нет; `updateMany` и
  `deleteMany` — по строке на запись; `keepVersion` — нет строки; автор из
  контекста запроса. Мутации: не писать при updateMany; писать вне транзакции;
  не брать автора.
- `scripts/test-change-feed-routes.ts`: отказ несёт `changedBy`; `record-origin`
  отдаёт автора. Мутация: убрать `changedBy`.
- Интерфейс: дополнение `test-project-version-ui` (строка «Изменил» в отказе,
  «Создал» в карточке), обе темы.

## Ход (исполнитель G)
Ветка: claude/youthful-ride-rwzb0t, старт f8d283b.
- [x] G1: таблица ChangeFeed в трёх схемах + автонумерация в schema-sync + localSchema
- [x] G2: server/changeFeed.ts (ALS + обёртка $transaction + хук), changeFeedScope/Read, подключение в server.ts
- [x] G3: changedBy в VersionConflict/sendVersionConflict (дополняют guardedWrite/guardedDelete), GET /api/record-origin
- [x] G4: scripts/test-change-feed.ts (SQLite + временный PG): 277 проверок; мутации M1 (updateMany), M2 (вне транзакции), M3 (автор) — набор падает
- [x] G5: scripts/test-change-feed-routes.ts (отказ с changedBy, record-origin, каскад пункта справочника)
- [x] G6: поправить test-version-bump (regexp server.ts) и прогнать наборы из задания, tsc; отчёт
Особенности: PrismaPromise ленив — `await` внутри ALS-контекста обязателен (runWithActor и обёртка $transaction дожидаются сами);
пакетные $transaction([...]) в chat.ts/builder.ts не трогают версионные модели — не переводил, хук бросит ошибку при появлении версионной записи.
prisma-clients: в рабочей копии настоящие копии (не симлинки), package.json не коммитить.
- [x] H: клиент (ConflictNotice «Изменил», RecordOrigin в карточках проекта, тега, позиции, строки ВДР, пункта справочника) + наборы test-record-origin-client (44) и test-project-version-ui (55)

G завершён (сервер). Для храповика test-architecture п.10: regexp server.ts теперь `withChangeFeed(buildPrismaClient(...), (c) => traceDatabase(withVersionBump(c)))`.
