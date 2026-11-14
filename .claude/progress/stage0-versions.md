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
- [ ] Исполнитель A: versionBump + versionGuard + ВДР на общем месте + наборы
- [ ] Исполнитель B: маршруты оборудования (сервер) + набор
- [ ] Исполнитель C: экран «Оборудование» (клиент) + набор интерфейса
- [ ] Документы: offline-work.md, страницы программ, plan.md; удалить файлы хода
