# Codex 01. Источники «Менеджмент» и E3Flux для Flux Office

## Зачем

В ленте «Flux» (Word и Excel) кнопки источников «Менеджмент» и «E3Flux» сейчас
серые с подписью «Скоро». Нужно, чтобы по ним можно было выбрать позиции и
вставлять их поля в шапку и заполнять таблицу — так же, как сейчас работают
«Оборудование» и «Теги».

## Что сделать

1. Аудит (ТЗ §2, §9): какие данные реально есть в проекте.
   - Менеджмент: закупки, поставщик, количество, этап, история этапов, ВДР и
     документы — только поля, которые фактически хранятся
     (`server/routes/tagProcurement.ts`, `src/screens/ProcurementManagement.tsx`,
     `src/screens/VdrPanel.tsx`, схема Prisma). Ничего не выдумывать.
   - E3Flux: схема, типовые решения, атрибуты, устройства, сигналы/I-O — если
     доступны (`docs/e3-integration.md`, экраны и маршруты E3Flux).
   Итог аудита — таблица «поле → откуда берётся → тип» в
   `docs/codex/task-01-audit.md`.
2. Сервер: эти поля через тот же единый контракт, что у Оборудования и Тегов
   (fieldKey, sourceId, entityId, entityType, revision, unit, displayName,
   value): каталог полей, выборка строк, фильтры, сортировка. Найти, как это
   устроено для `equipment`/`tags` (`src/components/office/fluxData.ts`,
   серверные маршруты `office/catalog`, `project-data`), и добавить источники
   `management` и `e3flux` рядом. Сопоставление по ID/тегу, а не по номеру
   строки; неоднозначности — явной ошибкой.
3. Права: только то, что пользователь может видеть в соответствующей
   программе (как сейчас проверяется доступ к Менеджменту и E3Flux).
4. Клиент: минимально — в `fluxData.ts` источники перестают выдавать ошибку
   «Источник … не поддерживается». Сами кнопки ленты включит руководитель.
5. Тесты: модульный набор `scripts/test-office-sources.ts` (каталог и выборка
   обоих источников на одноразовой базе, права, пустые/неоднозначные данные,
   1000+ строк без зависания).

## Не трогать

`tools/genoffice/**`, `src/components/office/FluxOfficePanel.tsx`,
`useFluxCellActions.tsx`, `FluxCellActionsDialog.tsx`, `useFluxRibbon.ts`,
`src/screens/OfficeHost.tsx`, `src/components/office/OfficeAppEditor.tsx`,
`LocalOfficeEditor.tsx`, `scripts/officeNative*`,
`scripts/test-office-addon-native-live.ts`.

## Проверки перед PR

- `npx tsc --noEmit -p .`
- `node --import tsx scripts/test-office-sources.ts`
- `node --import tsx scripts/test-office-api.ts` и `scripts/test-office-model.ts`
- `node --import tsx scripts/test-guide-server.ts --office-addon-api`
- `npm run check:coverage`

## Готово, когда

Аудит записан; оба источника отдают каталог полей и строки через тот же
контракт; права проверяются на сервере; тесты зелёные и записаны в PR.
