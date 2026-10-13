# Codex 01 — аудит полей источников Office

Аудит основан на `prisma/schema.prisma`, `server/routes/tagProcurement.ts`,
`src/screens/ProcurementManagement.tsx`, `src/screens/VdrPanel.tsx`,
`docs/e3-integration.md`, экранах и маршрутах E3Flux. В источники Office
попадают только сохранённые значения или результаты существующего расчёта.
Значения из COM/E3.series не включены: доступного чтения текущего проекта E3
через COM-мост в этом контракте нет; выгрузки и демонстрационные данные не
считаются живым состоянием устройств.

## Менеджмент

### Закупки

| Поле Office | Откуда берётся | Тип |
|---|---|---|
| `tag.identifier` | `Tag.identifier`; ключ строки — `Tag.id` | строка |
| `procurement.stage` | `Tag.metadata.procurement.stage` (стабильный ID этапа) | строка |
| `procurement.stageName` | ID этапа + `AppSetting.procurement_stages[].label`; подпись не хранится в теге | строка |
| `procurement.stageSince` | `Tag.metadata.procurement.stageLog[stage].at`; старые `orderedAt`/`approvedAt`/`purchasedAt` мигрируются на чтении экраном | дата ISO |
| `procurement.stageHistory` | `Tag.metadata.procurement.stageLog`: ID этапа, дата и автор; сериализованный список | JSON-строка |
| `procurement.supplier` | `Tag.metadata.procurement.supplier` | строка |
| `procurement.qty` | `Tag.metadata.procurement.qty`; числовой текст нормализуется в число, остальные значения сохраняются текстом | число или строка |
| `procurement.note` | `Tag.metadata.procurement.note` | строка |
| `procurement.templateId` | `Tag.metadata.procurement.templateId` | строка-ID |

Этапы и шаблоны этапов являются настройками программы (`AppSetting`), а не
копируются в закупку. Прошлые значения закупки доступны в `TagChange` как
история изменений; Office каталог предоставляет текущий этап и сохранённые
отметки этапов, не реконструирует отсутствующие события.

### ВДР и документы

Одна строка Office соответствует `DocRegisterItem.id`. Реестр связан с ней по
`registerId`. `equipmentTags` содержит обозначения тегов; сопоставление идёт по
точному `Tag.identifier` без учёта регистра. Если обозначение неоднозначно в
проекте, чтение возвращает 409 вместо выбора первой строки.

| Поле Office | Откуда берётся | Тип |
|---|---|---|
| `vdr.register`, `vdr.vendor`, `vdr.contractor`, `vdr.owner` | `DocRegister.name/vendor/contractor/owner` | строка |
| `vdr.poNumber`, `vdr.ownerProjectNo`, `vdr.contractorProjectNo`, `vdr.materialRequisition`, `vdr.equipmentTitle` | Поля `DocRegister` | строка |
| `vdr.registerContractorDocNo`, `vdr.registerOwnerDocNo`, `vdr.registerVendorDocNo` | Номера самого реестра в `DocRegister` | строка |
| `vdr.registerRevision`, `vdr.registerRevisions` | Текущая ревизия и JSON-история `DocRegister` | строка, JSON-строка |
| `vdr.preparedBy`, `vdr.checkedBy`, `vdr.approvedBy`, `vdr.managerId`, `vdr.preparedById`, `vdr.checkedById`, `vdr.approvedById` | Подписи и ответственный в `DocRegister`; введённое имя не подменяется ID | строка, ID |
| `vdr.contractorNo`, `vdr.ownerNo`, `vdr.vendorNo` | Номера документа в `DocRegisterItem` | строка |
| `vdr.titleRu`, `vdr.titleEn`, `vdr.code`, `vdr.revision` | Названия, VDR-код и ревизия `DocRegisterItem` | строка |
| `vdr.issueDate`, `vdr.reasonForIssue`, `vdr.language` | Выпуск документа `DocRegisterItem` | дата, строка |
| `vdr.status`, `vdr.remarks`, `vdr.reviewCode`, `vdr.dueDate`, `vdr.assigneeId` | Статус, замечания, код рассмотрения, срок и назначенный сотрудник в `DocRegisterItem` | строка, дата, ID |
| `vdr.docId`, `vdr.fileNodeId`, `vdr.tags` | Связи на документ Конструктора, файл замечаний и обозначения тегов `DocRegisterItem` | ID, строка |
| `vdr.itemRevisionHistory` | Строки `DocRegisterItemRevision` для конкретного документа | JSON-строка |
| `vdr.extra.<ключ>`, `vdr.meta.<ключ>` | JSON `DocRegisterItem.extra/meta`, включая пользовательские колонки | фактическое скалярное значение/JSON-строка |

Ревизии ВДР не являются содержимым файла. Office отдаёт только хранящиеся
идентификаторы/названия/состояния и ссылки на документ или файл, не читает их
байты как поля строки.

## E3Flux

| Поле Office | Откуда берётся | Тип |
|---|---|---|
| `element.itemCode`, `element.name`, `element.tag` | `ComponentElement` и связанные `Tag`; привязка E3 делается по `ComponentElement.id` | строка |
| `e3.project` | `E3Project.name`, связанный с `Project.id` через `fluxProjectId` | строка |
| `e3.version`, `e3.partsDb`, `e3.path` | Сохранённые версия, база изделий и путь в `E3Project` | строка |
| `e3.solutionId`, `e3.solutionName`, `e3.solutionClass` | `E3Binding.solutionId` и запись `E3Solution` из настройки `e3_solutions` | строка |
| `e3.designation`, `e3.sheet`, `e3.state`, `e3.sentVersion`, `e3.manualSolution` | Поля `E3Binding` | строка, да/нет |
| `e3.attr:<владелец>|<имя>` | Записанные значения `E3Binding.sentAttrsJson`; каталог имён и подписей — `AppSetting.e3_attributes` | строка |
| `e3.override:<владелец>|<имя>` | Ручные значения `E3Binding.overridesJson` | строка |
| `e3.devices` | Выход `buildRecipeFor`: сохранённое решение и его правила/ручной состав из `e3_solutions` и таблицы IO | список изделий, строка |
| `e3.di`, `e3.do`, `e3.ai`, `e3.ao` | Сумма соответствующих сигналов по выходу `buildRecipeFor` | число |
| `e3.io:<id строки IO>|di/do/ai/ao` | Количество изделий строки IO в рецепте × значения DI/DO/AI/AO из `E3SolutionBook.ioTable` | число |

E3Flux выдаёт позиции, у которых в проекте есть `E3Binding`; необвязанные
элементы оборудования не становятся строками E3Flux. E3 bindings являются
записью связи с выгрузкой; несколько привязок одной позиции в проектах E3
внутри одного проекта Flux считаются неоднозначностью и дают 409. Повторяющийся
ID решения в каталоге также даёт 409. Текущие атрибуты устройства в E3 на сервере не читаются: Office
показывает записанные Flux значения `sentAttrs` и ручные `overrides`. Разбор
реального файла E3, его провода и текущее состояние устройств не доступны через
сохранённый API-мост и не выдаются за данные проекта.

## Права

Оба Office-маршрута проверяют доступ участника к проекту тем же
`canSeeProject`, что и проектные данные; неучастнику общий проектный guard
отказывает до выдачи полей/строк. Чтение E3 каталога атрибутов и типовых
решений в самой программе разрешено вошедшему сотруднику; `e3.export` защищает
изменение профиля/раскладки и запись в E3, а не чтение. Поэтому Office чтение
E3 ограничено участием в связанном проекте и не требует права на выгрузку.

## Проверка контракта

`node --import tsx scripts/test-office-sources.ts` запускает отдельный API с
одноразовой SQLite-базой, явным членством пользователя в обоих фикстурных
проектах и синтетическими данными закупок, ВДР и E3. Проверяются каталог,
поля и строки, numeric-фильтрация/сортировка на 1000+ строк, исключения до
пагинации, пустой проект, неоднозначные сопоставления, права и изменение
ревизии при обновлении привязки или позиции. Нативная Windows/Office-среда этим
набором не проверяется.
