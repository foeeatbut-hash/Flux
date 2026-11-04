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

1. [ ] Этап 0: сверка версий в `issue-revision`, `revision-up`, `PUT` реестра —
   транзакция + ожидаемая версия от клиента, чужая — 409 (offline-work.md 0.1).
2. [ ] Этап A: `DocRegisterItemTag` по id, миграция `equipmentTags`, права `vdr.*`.
3. [ ] Общие свойства Flux на сервере + этап E.
