# Этап 0, пункты 0.4 + 0.5: целая версия и сверка в маршрутах записи

PR 173, ветка `claude/upbeat-allen-mhr0hp`, база ced50a5. План — `docs/roadmap/offline-work.md`, «0. Целостность записи».
Сверенный перечень мест записи — `stage0-versions-routes.md` рядом (отчёт разведки 14.11.2026).

## Решение руководителя (до кода)

### Перечень
142 входа записи, 132 без сверки версии от клиента (прежнее число 84 не считало
импорт оборудования, каскады удаления, копии Office, загрузки чата, миграцию ID).
Всего / без сверки: Project 5/5; Tag 25/23; EquipmentSystem 9/9; Monoblock 10/10;
ComponentElement 25/24; DocRegister 6/4; DocRegisterItem 14/11; FileNode 36/34;
Dictionary 3/3; DictionaryItem 6/6; TagTemplate 2/2; ConstructorDoc 1/1 (маршрутов
записи нет — только каскад удаления проекта).

### Деление на PR
В один PR не помещается. Части по программам, в порядке ценности данных:

1. **Этот PR.** Колонка версии у всех 11 моделей (0.4 целиком); одно место, которое
   двигает версию на любой записи; одно место сверки; ВДР переведён на него;
   **оборудование — поштучные маршруты** (тип, тег, позиция, удаление позиции,
   resolve/override/accept-field/manual-edit-field, привязка и отвязка тега,
   resolve-conflict, удаление системы) вместе с экраном «Оборудование».
2. Остальные маршруты тегов и ВДР (Tag 23, DocRegister 4, DocRegisterItem 11).
3. Проекты и справочники (Project, Dictionary, DictionaryItem, TagTemplate).
4. Проводник и файлы (FileNode 34: Проводник, копии Office, чат, архивы).
5. Массовые пути и импорт: план хранит версии записей, которые он видел, запись
   отказывает по устаревшему плану (импорт оборудования, import-undo, class
   apply/undo, bulk-metadata, tag-links/apply, e3-attribute-upload, parse-and-import).

Этап 0 после этого PR НЕ закрыт: 0.4 сделан, 0.5 — только часть 1.

### Кто двигает версию — `server/versionBump.ts`
Расширение клиента Prisma (`$extends`, подключается в `server/databaseClient.ts`
рядом с `traceDatabase`): для 12 моделей к `update`, `updateMany`, `upsert`
добавляет `version: { increment: 1 }`, если запись сама не задала `version`.
Так версию двигают все пути, включая массовые, импорт и будущие, — забыть нельзя.
- Явное `version` в данных (в т. ч. `withBump`, сверка) — расширение не трогает.
- Осознанно без роста: `keepVersion(data)` (перенос карточки тега по холсту x/y).
- Мимо расширения идут сырой SQL и вложенные записи (`data: { tags: { update } }`):
  храповик в `scripts/test-architecture.ts` — перечень разрешённых мест.
- Откат, ставящий версию назад (`equipmentXmlSources.ts:547`, `equipmentXmlUndo.ts`),
  нарушает «версия только растёт» — правится в части 5, здесь записать в «Не сделано».

### Одно место сверки — `server/versionGuard.ts`
Обобщение `guardedUpdate` из `vdrWrite.ts`:
- `guardedWrite(prisma, { model, id, expectedVersion, build, staleMessage, after })` —
  транзакция; чтение; не совпала версия клиента → `VersionConflict`; запись
  `updateMany where { id, version: прочитанная }` с ростом версии; `count !== 1` —
  гонка проиграна.
- `guardedDelete(...)` — то же через `deleteMany where { id, version }`.
- `expectedVersionOf(raw)` — целое ≥ 1, ничего или `null` (нечитаемо → 400).
- `sendVersionConflict(res, e)` — 409 `{ error: текст, code: 'VERSION_CONFLICT', current }`.
  Текст — для человека, по-русски, без кода; код — отдельным полем.
- `vdrWrite.guardedUpdate/guardedIssue` остаются именами, внутри — общее место;
  `expectedUpdatedAt` и `expectedRevision` принимаются по-прежнему.

### Договор с клиентом
- Клиент шлёт `expectedVersion` (целое) в теле; у `DELETE` — в строке запроса
  `?expectedVersion=`; у массовых — `expectedVersions: { [id]: n }`.
- У Tag поле API `version` остаётся `updatedAt` (ISO-строка) — не трогаем; целая
  версия идёт отдельным именем `expectedVersion`. Колонка в базе у всех — `version`.
- Сервер отдаёт запись с `version`; после успешной записи клиент берёт новую из ответа.
- 409: экран показывает текст, перечитывает запись, правку не теряет молча.

### Старый клиент без версии
Не ломается (как в ВДР): запись сверяется с собственным чтением в транзакции.
Правка полей при проигрыше гонки повторяется (до 4 раз), действие, которое от
повтора меняет смысл (удаление, создание по месту), — отказ 409.

### Чем доказывается
- `scripts/test-version-bump.ts` — настоящая SQLite: каждая из 12 моделей, `update`,
  `updateMany`, `upsert`, внутри `$transaction`; `keepVersion`; явная версия.
  Мутации: расширение не подключено; модель выпала из списка; `updateMany` не покрыт.
- `scripts/test-version-guard.ts` — чужая версия → конфликт с текущей записью;
  две одновременные записи с одной версией → одна прошла; клиент без версии;
  удаление. Мутации: убрать сравнение с версией клиента; убрать условие
  `version` из `updateMany`; убрать рост версии.
- `scripts/test-vdr-concurrency.ts` — без изменений проходит (ВДР не сломан).
- `scripts/test-equipment-version-routes.ts` — каждый маршрут части 1: 409 по
  чужой версии, код отдельным полем, запись не применена; мутация на маршрут.
- Экран «Оборудование» — набор интерфейса в настоящую службу, снимки двух тем.
- Windows CI и `test-schema-databases` (PostgreSQL, MariaDB) — на итоговой голове.

## Ход

- [x] Запись о сбое `test-studio-run-ui` в `studio-next.md` (a-коммит)
- [x] Схема: `version Int @default(1)` у 11 моделей в трёх схемах; клиенты пересобраны;
      `test-equipment-xml-routes-sqlite` — колонка в ручных таблицах. Прошли:
      schema-sync, ddl, schema-runtime, tag-code-key, vdr-concurrency,
      project-delete-sqlite и 11 наборов с ручным CREATE TABLE на SQLite.
      Не запускались здесь (нужна MariaDB): test-catalog-publication,
      -second-review-http, -workspace-http.
- [x] Исполнитель A: versionBump + versionGuard + ВДР на общем месте + наборы + храповик
      (число моделей — 12: у ConstructorDoc колонка тоже есть). Прошли: test-version-bump (169),
      test-version-guard (34), vdr-concurrency (без правок набора), tag-code-key, tag-history-tx,
      op-receipt, architecture (раздел 10), equipment-xml-routes-sqlite, project-delete-sqlite,
      database-client, tsc. Мутации — в отчёте исполнителя A; перенос тега по холсту — на keepVersion.
- [x] Исполнитель B: маршруты оборудования (сервер) + набор. Прошли: test-equipment-version-routes (222 проверки, 14 мутаций убиты + двойной рост версии), version-guard, version-bump, architecture, equipment-xml-routes-sqlite, equipment-param-access, equipment-source-orphan, vdr-concurrency/-permissions/-realtime/-tag-link, op-receipt, tag-code-key, tag-history-tx, tsc.
- [ ] Исполнитель C: экран «Оборудование» (клиент) + набор интерфейса
- [ ] Документы: offline-work.md, страницы программ, plan.md; удалить файлы хода


## Договор A (как сделано)

Исполнителям маршрутов — по этим именам и сигнатурам.

### `server/versionGuard.ts`
- `class VersionConflict extends Error` — `new VersionConflict(message, current = null)`; поле `current` —
  запись, какой она стала (сырая строка Prisma). `name === 'VersionConflict'`.
- `expectedVersionOf(raw): number | undefined | null` — целое ≥ 1 числом или строкой (`?expectedVersion=`);
  `undefined`/`null`/`''` → `undefined` (клиент без версии); нечитаемое → `null` (маршрут отвечает 400).
- `guardedWrite<R>(prisma, opts): Promise<{ before, after, extra? } | null>`; `null` — записи нет (404).
  `opts`: `model` (имя делегата: `'tag'`, `'componentElement'`…), `id`, `expectedVersion?`,
  `build(current, db) => { data, extra? }` (бросает `VersionConflict`, если по прочитанному запись
  недопустима; читать из базы не через `db` нельзя), `staleMessage(current) => string` (текст 409, по-русски),
  `after?(db, before, after)` (в той же транзакции), а для ВДР ещё `expectedUpdatedAt?`, `matchUpdatedAt?`.
  Версию растит сама (`version: { increment: 1 }` явно, расширение не добавляет второй раз).
  С `expectedVersion` — одна попытка, проигрыш → `VersionConflict` с текущей записью. Без — до 4 попыток
  (поле «поставь эти значения» от повтора смысла не меняет), потом тот же отказ.
- `guardedDelete(prisma, { model, id, expectedVersion?, staleMessage, before? }): Promise<{ before } | null>`;
  `before(db, current)` — каскад/история в той же транзакции до удаления. `deleteMany where { id, version }`;
  без повторов: проигрыш → `VersionConflict`.
- `sendVersionConflict(res, e, present?)` → 409 `{ error: e.message, code: 'VERSION_CONFLICT', current }`;
  `present(record)` — как маршрут обычно отдаёт запись (разбор JSON-полей), применяется к `current`.
- `inTransaction(prisma, fn)` — как был в `vdrWrite.ts` (тот реэкспортирует).
- Маршруту: `const v = expectedVersionOf(req.body.expectedVersion)` → `v === null` → 400;
  `catch (e) { if (e instanceof VersionConflict) return sendVersionConflict(res, e, present); … }`.
  Ответ маршрута отдаёт запись с `version` (в Prisma-строке она уже есть).

### `server/versionBump.ts`
- `VERSIONED_MODELS: readonly string[]` — 12 моделей (Project, Tag, EquipmentSystem, Monoblock,
  ComponentElement, DocRegister, DocRegisterItem, ConstructorDoc, FileNode, Dictionary, DictionaryItem, TagTemplate).
- `withVersionBump(client)` — расширение; подключено в `server.ts` → `createPrismaClient`:
  `traceDatabase(withVersionBump(buildPrismaClient(…)))` — единственное место клиента (запуск и переключение базы).
  Растит `update`, `updateMany`, `updateManyAndReturn`, ветку update у `upsert`; пустой `update: {}` у upsert
  («создай, если нет») версию не двигает. Явный `version` в данных расширение не трогает.
- `keepVersion(data)` — осознанно без роста; метка — служебный ключ `__fluxKeepVersion`, расширение снимает её
  до запроса (символ не годился — Prisma копирует аргументы и теряет символьные ключи). На клиенте без
  расширения Prisma откажет неизвестным полем (громко).
- `bumpedData(data)` — то же дописывание для кода без расширения (использует `guardedWrite`).
- Вложенные записи и сырой SQL расширение не видит — храповик `scripts/test-architecture.ts`, раздел 10
  (перечень мест с причинами: сырой SQL, вложенные записи, версия, поставленная руками; откат/«хватка»
  XML-ревизий помечены «часть 5»).

### `server/vdrWrite.ts`
`VdrConflict` теперь тот же класс, что `VersionConflict` (`export const VdrConflict = VersionConflict`);
`guardedUpdate` — `guardedWrite` с `matchUpdatedAt`; `guardedIssue` пишет под `version` и растит её.
Маршруты ВДР не менялись: ответ по-прежнему `{ error, conflict: true, current }` (код `VERSION_CONFLICT` у них не добавлен).

### Для тестов маршрутов
Клиент без расширения (`new PrismaClient`) версию не растит нигде, кроме `guardedWrite`/`guardedIssue`:
наборы, проверяющие рост версии у маршрута, собирают клиента `withVersionBump(raw)`.


## Договор B (как сделано)

Общее для всех маршрутов ниже. Версия — целое `version` записи; клиент берёт её из того, что отдал сервер
(`GET /api/projects/:projectId/systems` отдаёт `version` у установки, моноблока и позиции: там `include`, колонки не режутся),
и после успеха берёт новую из ответа.
- Версия идёт в теле как `expectedVersion`; у `DELETE` — в строке запроса `?expectedVersion=N`.
- Нечитаемая (не целое ≥ 1) — 400 `{ error }`, запись не тронута. Версии нет (старый клиент) — работает как раньше.
- Чужая — 409 `{ error: текст по-русски, code: 'VERSION_CONFLICT', current: сырая строка записи }`; ничего не записано
  (в том числе не заведён тег). Тексты — `server/equipmentStale.ts`. Кто и когда изменил — в текст не входит: у позиции `updatedAt` не
  ведётся, у установки и моноблока колонки нет, автора правки не хранит ни одна модель.
- Сравнение — одно место `assertExpectedVersion` (`server/versionGuard.ts`); `guardedWrite`/`guardedDelete` зовут его сами.

| Маршрут | Версия какой записи | Где клиент её берёт | Что в успешном ответе |
|---|---|---|---|
| PUT `/api/equipment/component/:id/class` | позиция | `component.version` | `{ ok, equipClass, equipKind, version }` |
| POST `/api/equipment/component/:id/tag` | позиция | `component.version` | `{ ok, identifier, created, corrected, parentTag, version }` |
| DELETE `/api/equipment/component/:id?expectedVersion=` | позиция | `component.version` | `{ ok, name, itemCode, freedTags, moved? }`; нет записи — `{ ok, alreadyGone }`. Дети при перевешивании растут на 1 |
| POST `/api/equipment/component/:id/position` | владелец-позиция (не растёт) | `component.version` владельца | `component: { id, itemCode, name, role, version: 1 }` — версия новой позиции |
| POST `/api/equipment/monoblock/:id/position` | моноблок (не растёт) | `monoblock.version` | то же |
| POST `/api/equipment/component/:id/resolve`, `…/override` | позиция | `component.version` | `{ success, component }` (с новой `version`) |
| POST `/api/components/:id/accept-field`, `…/manual-edit-field` | позиция | `component.version` | `{ success, component }` |
| POST и DELETE `/api/components/:componentId/tags/:tagId` | позиция (DELETE — `?expectedVersion=`) | `component.version` | `{ component }` с `tags` и новой `version` |
| POST `/api/components/:componentId/resolve-conflict` | позиция | `component.version` | `{ component }` |
| DELETE `/api/systems/:id?expectedVersion=` | установка | `system.version` | `{ success, freedTags, detachedSources }`; нет записи — `{ success, alreadyGone }` |

Особенности:
- Создание «по месту» сверяет версию владельца ДО заведения тега и позиции и владельца не двигает (версия растёт только у новой — 1);
  сверка не атомарна с самим созданием: создание ничего не перезаписывает.
- Привязка/отвязка тега: версию растит запись под `updateMany where version`, связь ставится следом в той же транзакции через `keepVersion` (двойного роста нет).
- resolve/override/accept-field/manual-edit-field: старое состояние каталога по-прежнему 409 без кода («Источник карточки изменился»); сверка версии — в `writeEditableEquipmentParam(…, expectedVersion)`; проигрыш гонки (P2025) теперь тоже `VERSION_CONFLICT`, а не текст без кода.
- Ответы ВДР (`conflictReply`) получили `code: 'VERSION_CONFLICT'`; `conflict: true`, `current` прежние. Не помечены: 409 «ревизия не выпущена» и «план устарел» (не версионные).
- Новое в `server/routes/tags.ts`: нет позиции → 404 (раньше 500) у привязки/отвязки/resolve-conflict.
