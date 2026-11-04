# Документооборот — ход работ

Проект: `docs/docflow-integration.md` (решение владельца 4.11.2026 в начале,
этапы — раздел 7, ответы по умолчанию — раздел 8). План: `docs/plan.md`, раздел 8.

## Разведка (4.11.2026, HEAD 3464bce)

- Модели: `DocRegister` / `DocRegisterItem` / `DocRegisterItemRevision` /
  `DocStandard` — `prisma/schema.prisma:118-217`. У строки `equipmentTags` JSON
  (по коду, не id), `fileNodeId` мёртв. `DocFileLink`, `DocRegisterItemTag`,
  `ProjectMilestone`, `DocKitRule` не существуют.
- Маршруты: `server/routes/vdr.ts` — registers :313-398, `revision-up` :368,
  items :405-510, `issue-revision` :629-675 (без транзакции и сверки версии),
  import :688, export :835. Экран `src/screens/VdrPanel.tsx`, Менеджмент `?tab=vdr`.
- Свойства Flux у Windows-файлов — локально:
  `electron/filesystem/state.ts:21,63` (`windows-files-state.json`:
  tags, projectIds, revision, responsible, history), контракт
  `electron/filesystem/contracts.ts:45-48`, запись `service.ts:999-1003`;
  диалог `src/components/explorer/PropertiesWindow.tsx`.
- Права `vdr.manage`, `vdr.standards` — `src/lib/permissions.ts:90-92`.
- Согласования, трансмиттала, комментариев к файлу по ВДР нет.

## Очередь

1. [x] Этап 0 (сделано, ветка claude/determined-bardeen-dfpbuf, не запушено): сверка версий в `issue-revision`, `revision-up`, `PUT` реестра —
   транзакция + ожидаемая версия от клиента, чужая — 409 (offline-work.md 0.1).
2. [x] Этап A (теги; не запушено): `DocRegisterItemTag` по id, миграция `equipmentTags` с планом, права `vdr.*`, обратный показ у тега. Остались: «Документы» в строке оборудования, ссылки `/explorer?file=`.
3. [ ] Общие свойства Flux на сервере + этап E.

## Этап 0 — итог

- `server/vdrWrite.ts`: `guardedUpdate` (правка под `updatedAt`, повтор для
  клиента без версии), `guardedIssue` (выпуск под ревизией, без повтора),
  `VdrConflict`. Маршруты в `server/routes/vdr.ts`: `issue-revision`,
  `registers/:id/revision-up`, `PUT registers/:id`, `PUT items/:id`.
- Тело запроса: `expectedRevision` (выпуски), `expectedUpdatedAt` (правки).
  409 → `{ error, conflict: true, current: { item | register } }`.
- Решения: старый клиент без версии — правка полей сливается с повтором,
  выпуск проигравшему гонку — 409; `PUT` реестра не принимает `revisions` и
  отличную от текущей `revision` (409); `PUT` строки без версии с отличной
  `revision` — 409. Запись истории реестра получила поле `by`.
- Известное ограничение: версия записи — `updatedAt` (мс); две записи в одну
  миллисекунду неразличимы. Целая версия (`version`) — пункт 0.4 roadmap.
- Клиент: `VdrPanel.tsx` — `conflictOf`, `seen` в карточке, `openedAt` в
  реквизитах реестра. `fillEnglishTitles` и `bulkAssign` версию не шлют
  (одно поле, слияние).
- Набор: `scripts/test-vdr-concurrency.ts` (39 проверок, SQLite).
- Дальше: этап A.

## Этап A — итог (4.11.2026)

- Живой прогон этапа 0 сделан: два окна, выпуск A → B в первом, во втором 409 и
  перечитанная карточка (рев. B); снимки в scratchpad `vdr-live-2/3-*.png`.
- Схема: `DocRegisterItemTag` (3 prisma-схемы, `server/localSchema.ts`, PG
  `ensureTables`, очистка в `projectDelete.ts`), `@@unique` вместо `@@id`.
  Клиенты Prisma пересозданы в `prisma-clients/*` (в git не входят).
- `server/vdrTags.ts`: код → тег строго (`tagCodeKey`), неоднозначное и
  «All items» не связывается, `syncItemTags` (на каждую запись `equipmentTags`),
  `renameTagInVdr` (хук в `tagWrite.ts`), план/применение/отмена.
- Маршруты: `GET /api/vdr/tag-links`, `POST …/apply` (по отпечатку плана),
  `POST …/undo`; `GET items` отдаёт `tagLinks`, `unmatchedTags`;
  `by-tag?tagId=` (код — для старых клиентов).
- Права: `server/vdrPermissions.ts` (таблица для `server.ts` и проверки),
  `projectEntityAccess.ts` — реестр и строка в адресе/теле находят проект;
  удаление стандарта — по `vdr.standards`, а не «только админ».
- Клиент: `src/components/vdr/TagLinkPlanDialog.tsx` + кнопка в `VdrPanel.tsx`;
  `TagVdrDocs` (по `tagId`) подключён в `TagCardModal`.
- ВСТАВИТЬ ПОСЛЕ ПРИЁМКИ ИМПОРТА XML: в карточку оборудования —
  `<TagVdrDocs tagId={tag.id} identifier={tag.identifier} projectId={projectId} />`
  (`src/components/registry/TagVdrDocs.tsx`; рядом с блоком тегов позиции).
- Наборы: `test-vdr-tag-link` (34), `test-vdr-permissions` (36),
  `test-vdr-concurrency` (39), `test-insight`, `test-project-delete-sqlite`.
