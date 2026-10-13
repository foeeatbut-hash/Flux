# Аудит источников «Менеджмент» и E3Flux

Аудит основан на текущих моделях Prisma, маршрутах и типах экранов. Значения из COM/E3.series не включены: фактический COM-мост ещё не реализован, и доступных результатов живого COM-вызова в репозитории нет.

## Менеджмент

| Поле | Откуда берётся | Тип |
|---|---|---|
| Идентификатор позиции | `Tag.id` | UUID/string |
| Тег | `Tag.identifier` | string |
| Отдел, марка, WBS, среда | `Tag.department`, `brand`, `wbs`, `fluid` | string? |
| Проект и связанное оборудование | `Tag.projectId`, `equipmentId`; связанные `ComponentElement` дают `equipType`, код позиции и тип системы | string / string? / связи |
| Этап закупки | `Tag.metadata.procurement.stage` (JSON); смысл/название берётся из шаблона этапов, включая настройки по умолчанию | string? |
| История отметок этапов | `Tag.metadata.procurement.stageLog`: ключ этапа → `{at, by}` | JSON object; timestamp string и автор string |
| Старые отметки | `orderedAt/orderedBy`, `approvedAt/approvedBy`, `purchasedAt/purchasedBy` в procurement JSON; при чтении переносятся в stageLog | string?, миграционный формат |
| Шаблон этапов | `Tag.metadata.procurement.templateId` | string? |
| Поставщик | `Tag.metadata.procurement.supplier` | string? |
| Количество | `Tag.metadata.procurement.qty` | string? (не число по контракту) |
| Примечание закупки | `Tag.metadata.procurement.note` | string? |
| ВДР: реестр | `DocRegister`: `id`, `projectId`, `name`, `vendor`, `contractor`, `owner`, `poNumber`, номера проекта/документа, `revision`, `revisions`, подписанты | строки; `revisions` JSON string |
| ВДР: строка/документ | `DocRegisterItem`: `id`, `registerId`, `projectId`, номера сторон, `titleEn/titleRu`, `vdrCode`, `revision`, дата/причина выпуска, язык, `equipmentTags`, статус, `docId`, `fileNodeId`, `assigneeId`, замечания, код рассмотрения, срок, `extra`, `meta` | strings, nullable IDs, nullable DateTime, JSON strings |
| История ревизии документа ВДР | `DocRegisterItemRevision`: itemId, revision, date, reason, place, description, authorId | strings, DateTime, nullable ID |

`ProcurementManagement` строит строки из тегов проекта и метаданных `procurement`, а не из отдельной таблицы закупок. Не обнаружено отдельных фактических полей цены, суммы, валюты или заказа закупки; их не следует добавлять в каталог. Стандартные/пользовательские этапы — справочник настроек, а не самостоятельная история событий; история хранится только в `stageLog`.

## E3Flux

| Поле | Откуда берётся | Тип |
|---|---|---|
| Позиция проекта: ID, код, имя, тип/класс, тег и характеристики | `ComponentElement` (`id`, `itemCode`, `name`, `equipType`, `equipClass/equipKind`, `specs`, `overrides`) и связи с `Monoblock`/`EquipmentSystem`; тег — связанный `Tag` | strings, nullable JSON strings, relations |
| Типовое решение | Книга `e3_solutions` в `AppSetting.value` JSON: `E3Solution.id`, mainClass/subclass, short, name, description, pdf/e3p, twoLevel, inCad, items, symbols, note, features, featuresConfirmed, removed, recipeOverride | E3Solution strings/boolean/object/array |
| Признаки решения | `E3SolutionBook.features`: id, mainClass, title, values, kind (`ov/profile/layout`), hint, absent | strings, string array, enum, optional string |
| Правила/словарь | `E3SolutionBook.rules`, `dictionary`, `classMap` | JSON rules/record of strings/string arrays |
| Таблица сигналов IO | `E3SolutionBook.ioTable`: `E3IoRow.id`, group, name, code, DI/DO/AI/AO counts, notes, optional component, edited | strings, integer counts, notes object, optional strings/boolean |
| Правила подбора строк IO | `E3SolutionBook.ioRules`: правила связи решения/признаков со строками IO и количеством изделий/сигналов | JSON-объекты типизированного каталога |
| Профиль автоматизации проекта | `AppSetting` key `e3_profile:<projectId>`: answers keyed by feature id, version, updatedAt/by | JSON; answers string или threshold object |
| Раскладка схемы проекта | `AppSetting` key `e3_layout:<projectId>`: format, placed keyed by solution ID, off flags | JSON; coordinates numbers |
| Связанный проект E3 / результат выгрузки | `E3Project` (имя, путь, версия E3, partsDb, key) и `E3Binding` (elementId, sheet, designation, state, sentVersion); `E3Export` — журнал планирования/выгрузки | strings, integers, JSON strings/relations |
| Атрибуты E3 | Каталог атрибутов из `e3/attributes.ts`, хранимый как каталог приложения: name/title/carrier/class, service/fromFlux, script/comment, source/sourceByClass, classes, conflict | strings/boolean/typed source/arrays |

`E3IoRow.component` — необязательная ручная справка об изделии; это не COM-идентификатор и не установленный факт о подключённом устройстве. Доступная IO-таблица описывает каталогные типы и количества сигналов; фактические точки/каналы из открытого E3.series данным репозиторием не читаются. Не выдавать экспортированные/подставные данные `FLUX_E3_FAKE` за живые данные COM.

## Выводы для реализации источников

- Для `management` естественная единица строки — тег (`Tag.id` как entityId, `Tag.identifier` как displayName/ключ сопоставления). Отдавать только конкретные поля выше; procurement значения читать из JSON `metadata`, этап отображать по настроенному шаблону, историю не превращать в придуманную плоскую сущность.
- Для ВДР лучше отдельные entityType для реестра и строки документа; у строки ключом служит `DocRegisterItem.id`, а `equipmentTags` — JSON-массив идентификаторов тегов для привязки, не номер строки.
- Для `e3flux` разрешены данные позиции Flux, связанный каталог решений/IO и проектные profile/layout/bindings, если они нужны контракту. ID решения (`E3Solution.id`) и ID позиции (`ComponentElement.id`) — устойчивые ключи. IO-строки используют `E3IoRow.id`; матчить их по отображаемому номеру строки нельзя.
- Авторизация выборки обязана ограничивать `Tag`/`ComponentElement`, ВДР и E3-проект текущим `projectId` с проверкой `canSeeProject(userId, projectId, isPrivilegedUser(user))`, как project-scoped E3-маршруты. Для тегов существующая запись проходит общий project-entity access guard (`writeTag`/`server/routes/tagProcurement.ts`) и требует `tags.manage`; чтение источника не должно требовать права изменения, но обязано применить проектную видимость. Важное различие: `resolveProjectId()` в `server/context.ts` только разрешает/создаёт projectId и не является проверкой доступа. GET ВДР-маршрутов вызывают этот resolver, но сами не вызывают `canSeeProject`, поэтому офисный источник должен добавить свою проверку. Каталоги типовых решений/атрибутов глобальны, поэтому не фильтровать их по projectId; профиль, раскладка и E3-связи — только после проверки участия в проекте. Проверку прав каталога офисных источников (`office/catalog`, `project-data`) сохранить как внешний барьер и не считать её заменой проектной фильтрации.

Маршруты-источники: закупки `PATCH /api/tags/:id/procurement`; ВДР `/api/vdr/registers`, `/api/vdr/items`; типовые решения/IO `/api/catalog/e3-solutions` и project-scoped E3 profile/layout/exports в `server/routes/e3Solutions.ts`/`e3Exports.ts`. Важно: общие справочники типовых решений и атрибутов имеют существующий read-доступ каталога; E3-проектные маршруты дополнительно проверяют участие в проекте.

## Поля включённого контракта

Каталог `/api/project-data/office/catalog` перечисляет точные fieldKey и типы.
В `management` закупки выбираются `entity=procurement`, ВДР — `entity=vdr`
(ключи `vdr.*`, виды `register`/`document`). В `e3flux` применяется `entity=e3`,
ключи `e3.*`, виды `binding`/`solution`/`attribute`/`io`. Профиль, раскладка
в браузере, правила рецептов и журнал выполнения экспорта аудитом найдены,
но не выдаются как параметры оборудования: их назначение — управление
построением и выгрузкой схемы. История этапов отдаётся исходным JSON;
legacy-даты отдельно, без выдуманного объединённого этапа.
