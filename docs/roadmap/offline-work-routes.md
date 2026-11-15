# Места записи в 12 синхронизируемых моделей (к пункту 0.5 плана «Работа при недоступном сервере»)

Приложение к `offline-work.md`, «К пункту 0.5: что осталось». Разведка на базе ced50a5 (14–15.11.2026), до части 1: колонка «сверка сейчас» у поштучных маршрутов оборудования устарела — они сверяют версию с PR 173. Строки с пометкой «не проверено» перед работой сверить. Сделанная часть вычёркивается из перечня в том же PR.


База: `ced50a5` (= origin/main на момент разведки). Код не менялся.

Как собрано:
- `rg` по `\.(модель)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b` в `server/ electron/ src/` (без тестов): 135 вызовов.
- Динамические записи, которые этот шаблон не видит: `db[opts.model]` (server/vdrWrite.ts:101, 137), `tx[model]` / `this.tx[model]` (server/projectDelete.ts:42, 47-59 и вызовы `e.where/within`), PK-миграция `$executeRawUnsafe` с именем таблицы из переменной (server/entityIdMigration.ts:370, 381), `UPDATE/DELETE` сырым SQL (server/tagCodeKey.ts:135, server/projectDelete.ts:73).
- Каждый вызов поднят до маршрута функцией `route_of`-поиска по ближайшему `app.<метод>('путь')`; вспомогательные функции привязаны ко всем вызывающим (`rg` по имени).
- «В транзакции»: да — есть `$transaction`, `inTagTransaction`, `inTransaction` или запись через `tx` в этом пути. Нет — записи через `prisma` без общей транзакции.
- «Клиентский файл» — путь из `rg` по строке пути/имени функции в `src/` и `electron/`. Пометка «не найдено» значит, что поиском по пути вызова не нашёл; это не доказательство отсутствия вызова.

Легенда колонки «сверка сейчас»:
- `нет` — без условия по версии.
- `expectedUpdatedAt` — клиент присылает updatedAt, который видел (vdr).
- `version от клиента` — клиент присылает version/expectedVersion, сервер сверяет.
- `expectedRevision` — клиент присылает ревизию, сервер сверяет (vdr, каталог).
- `со своим чтением` — условие на updatedAt/version из чтения в этом же запросе (клиент не участвует).
- `из сохранённого плана` — условие на значения, записанные при предпросмотре (план/предпросмотр в БД).
- `sha/hash от клиента` — клиент присылает хеш документа/файла (для сверки не версии).

Счёт «всего / без сверки от клиента» — число строк (маршрутов и входов, включая миграцию и каскад DELETE проекта) и число строк без `version`/`expectedUpdatedAt`/`expectedRevision`/`sha`, присланных клиентом. Побочное создание Project (resolveProjectId) в счёт не входит, вынесено отдельно.

---

## Project

Всего 5 / без сверки от клиента 5.

| метод и путь | обработчик | операция | запись | сверка сейчас | в транзакции | клиентский файл |
|---|---|---|---|---|---|---|
| POST /api/projects | server/routes/projects.ts:47 | create | server/routes/projects.ts:51 | нет | нет | src/services/dataService.ts:496 ← src/screens/ProjectsManagement.tsx:119 |
| PUT /api/projects/:id | server/routes/projects.ts:73 | update | server/routes/projects.ts:88 | нет | нет | src/services/dataService.ts:504 ← ProjectsManagement.tsx:147 |
| DELETE /api/projects/:id | server/routes/projects.ts:95 | массовая (каскад ~60 моделей) | server/projectDelete.ts:83-213 (project: :213) | нет | да (projects.ts:103 $transaction) | src/services/dataService.ts:525 ← ProjectsManagement.tsx:177 |
| POST /api/seed | server/routes/auth.ts:194 | create | server/routes/auth.ts:201 | нет | нет | src/services/dataService.ts:459 (seedDatabase; вызовов по имени в src не найдено) |
| POST /api/settings/entity-id-migration/apply (undo) | server/routes/entityIdMigration.ts:20 (:29) | массовая, PK-миграция (raw, динамическое имя таблицы) | server/entityIdMigration.ts:385 (undo :431), UPDATE :370, :381 | из сохранённого плана (planToken) | да (tx) | src/components/settings/EntityIdMigrationPanel.tsx:36 |

Побочное создание Project (default «Общий Проект», если проектов нет): `server/context.ts:29-36` (resolveProjectId, create :36). Вызывается 42 раза в 12 файлах: server/routes/desktop.ts:40/83/104, calendar.ts:148/194/225, vdr.ts:335/358/689/717/749/756/772/895, projectData.ts:44/150/162/182/331/339, projectOffice.ts:245/255, translate.ts (9 мест), insight.ts (4), mailLink.ts:187, archives.ts:417, server/projectFields.ts:57, server/officeStore.ts:72/87. Прямые: tags.ts:92 (POST tags), :160 (bulk-import), :276 (capture-apply), :520 (parse-and-import), :604 (GET systems); dictionaries.ts:54 (GET dictionaries), :77 (POST dictionaries); explorer.ts:218 (POST /api/folders). Через ensureDiskProject (server/systemFolders.ts:138-143): explorer.ts:76 из deniedOnDisk (POST /api/folders, PATCH/DELETE /api/folders/:id, POST /api/files, POST /api/files/copy, PATCH/DELETE /api/files/:id), explorer.ts:135 (GET /api/projects/:projectId/folders).

---

## Tag

Всего 25 / без сверки от клиента 23. Версия от клиента есть у двух строк: PUT /api/tags/:id и PATCH /api/tags/:id/procurement.

| метод и путь | обработчик | операция | запись | сверка сейчас | в транзакции | клиентский файл |
|---|---|---|---|---|---|---|
| POST /api/projects/:projectId/tags | server/routes/tags.ts:84 | create | tags.ts:101 | нет (код: assertFreeTagCode + codeKey unique) | да (tags.ts:100) | src/components/registry/useQuickCreate.ts:177 |
| POST /api/projects/:projectId/tags/bulk-import | tags.ts:153 | массовая update+create | tags.ts:203, 218, 236 | нет (по коду в режиме update) | да (tags.ts:167) | src/components/TagImportWizard.tsx:161 → src/services/dataService.ts:602 |
| POST /api/projects/:projectId/tags/capture-apply | tags.ts:261 | массовая update+create | tags.ts:338, 359 | нет | да (tags.ts:282) | src/components/CaptureReview.tsx:250 → dataService.ts:621 |
| POST /api/projects/:projectId/tags/capture-undo | tags.ts:395 | массовая deleteMany+update | tags.ts:416, 423 | нет | да (tags.ts:405) | src/components/CaptureReview.tsx:282 → dataService.ts:636 |
| PUT /api/tags/bulk-metadata | tags.ts:455 | массовая (writeTags) | tagWrite.ts:188 через writeTags :244 | нет (version не передаётся) | да (tagWrite.ts:244) | src/screens/ProcurementManagement.tsx:421, :455; src/screens/Registry.tsx:1628 |
| PUT /api/tags/:id | tags.ts:486 | update (условный: where updatedAt) | tagWrite.ts:188 | version от клиента (tags.ts:488 → tagWrite.ts:173 sameVersion :126) | да (tagWrite.ts:221) | src/components/registry/tagWrite.ts:131 (send, version :86-90) ← useRegistryTags.ts:95 |
| PATCH /api/tags/:id/procurement | server/routes/tagProcurement.ts:34 | update (writeTag) | tagWrite.ts:188 | version от клиента (tagProcurement.ts:36, 41) | да | src/components/registry/tagWrite.ts:142 (saveProcurement :139) |
| DELETE /api/tags/:id | tags.ts:755 | delete | tags.ts:762 | нет | да (tags.ts:760) | src/components/registry/useTagTreeOps.ts:59; src/screens/Registry.tsx:770 |
| POST /api/tags/generate | tags.ts:811 | create | tags.ts:835 | нет | да (tags.ts:834) | src/services/dataService.ts:655 (generateTag; вызовов по имени не найдено) |
| POST /api/builder/batches/:id/undo | server/routes/builder.ts:291 | delete (массовая) | builder.ts:325 | нет | да (builder.ts:304) | src/services/catalogService.ts:129 |
| POST /api/builder/lists/:id/tag-apply | builder.ts:427 | create (массовая) | builder.ts:467 | нет | да (builder.ts:443) | src/services/catalogService.ts:133 |
| POST /api/equipment/component/:id/tag | server/routes/equipmentEdit.ts:244 | create (tag) + update (родительский тег, linkParentTag) | equipmentEdit.ts:312; linkParentTag :475 | нет | да (:311, :474) | src/screens/Equipment.tsx:593 |
| POST /api/equipment/component/:id/position | equipmentEdit.ts:197 → createPosition (:325) → linkParentTag | update (metadata родителя) | equipmentEdit.ts:475 | нет | да (:474) | src/screens/Equipment.tsx:561 |
| POST /api/equipment/monoblock/:id/position | equipmentEdit.ts:214 → createPosition → linkParentTag | update (metadata родителя) | equipmentEdit.ts:475 | нет | да | src/screens/Equipment.tsx:561 |
| POST /api/vdr/tag-links/apply | server/routes/vdr.ts:754 → server/equipmentTags.ts:196 applyTagLinks | create | equipmentTags.ts:244 | нет | да (inTagTransaction :243) | не найдено поиском (VdrPanel.tsx:170 — только GET) |
| POST /api/equipment/import-to-category | server/routes/equipmentCore.ts:71 → server/equipmentImport.ts:93 importEquipmentToDB | update (linkTagsByComposition :466) + create через applyTagLinks (:341) | equipmentImport.ts:466 | нет | да только теговая часть (:465); общей tx нет | src/components/EquipmentImportPreview.tsx:269 |
| POST /api/equipment/source-import/apply | server/routes/equipmentSourceImport.ts:203 → importEquipmentToDB (:275) | как выше | как выше | нет | да (внешняя $transaction :255) | не проверено |
| POST /api/equipment/import-draft | server/routes/equipmentDraft.ts:316 → importEquipmentToDB (:361, :386) | как выше | как выше | нет | да (:361 $transaction) | src/components/EquipmentImportPreview.tsx:261 |
| POST /api/import-jobs (фоновый разбор) | server/routes/importJobs.ts:47 → queueImport (:100); разбор server/importJobs.ts:190 (drainImportJobs), запуск :311 по таймеру | как выше (importJobs.ts:260) | как выше | нет | нет (prisma без общей tx) | src/components/EquipmentImportPreview.tsx:308 |
| POST /api/equipment/projects/:projectId/sources/:sourceId/candidates/:candidateId/decisions | server/routes/equipmentXmlSources.ts:498 | update (claim по identifier) + create | equipmentXmlSources.ts:692 (claim), :718 (create) | из сохранённого плана (identifier источника) | да (tx) | не проверено (EquipmentXmlSourcePanel.tsx:347/366/384 — пути базы) |
| POST /api/equipment/projects/:projectId/catalog-classes/apply | server/routes/equipmentClasses.ts:20-28 → server/equipmentClasses.ts:81 applyEquipmentClasses | массовая updateMany | equipmentClasses.ts:96 | из сохранённого плана (equipmentId + updatedAt, :96) | да (tx) | src/components/docflow/EquipmentClassActions.tsx:20 |
| POST /api/equipment/projects/:projectId/catalog-classes/undo | equipmentClasses.ts:28 → undoEquipmentClasses (:106) | массовая updateMany | equipmentClasses.ts:115 | из сохранённого плана (updatedAt) | да (tx) | EquipmentClassActions.tsx:20 |
| PUT /api/dictionaries/items/:itemId | server/routes/dictionaries.ts:123 | updateMany (rename-миграция metadata) | dictionaries.ts:166 | со своим чтением (before-значения :130-145) | да (tx) | src/components/dictionary/useTagDict.ts:180 (метод не сверен) |
| DELETE /api/projects/:id (каскад) | projectDelete.ts:172 (e.where('tag')) | deleteMany | projectDelete.ts:172 | нет | да | см. DELETE /api/projects/:id |
| POST /api/settings/entity-id-migration/apply (undo) | entityIdMigration.ts:385 / :431 | PK-миграция (raw) | entityIdMigration.ts:370, 381 | из сохранённого плана (planToken) | да | src/components/settings/EntityIdMigrationPanel.tsx:36 |

Замечание: DELETE /api/projects/:id, миграция и import-undo отличаются по `tx`. Прежний счёт 15/13 не включал импорт оборудования, класс-план и decisions; здесь они учтены, потому что пишут `tag` напрямую.

---

## EquipmentSystem

Всего 9 / без сверки от клиента 9.

| метод и путь | обработчик | операция | запись | сверка сейчас | в транзакции | клиентский файл |
|---|---|---|---|---|---|---|
| POST /api/projects/:projectId/excel/parse-and-import | server/routes/tags.ts:508 → server/excelParser.ts:679 importParsedDataToDB | create | excelParser.ts:708 | нет | нет (нет $transaction в файле) | src/services/dataService.ts:741 (parseAndImportBimFile; вызовов по имени не найдено) |
| POST /api/equipment/import-to-category | server/routes/equipmentCore.ts:71 → equipmentImport.ts:93 | update :152, create :155 | equipmentImport.ts:152, :155 | нет | нет | src/components/EquipmentImportPreview.tsx:269 |
| POST /api/equipment/source-import/apply | equipmentSourceImport.ts:203 | как выше | как выше | нет | да (:255) | не проверено |
| POST /api/equipment/import-draft | equipmentDraft.ts:316 | как выше | как выше | нет | да (:361) | EquipmentImportPreview.tsx:261 |
| POST /api/import-jobs (фон) | routes/importJobs.ts:47 → importJobs.ts:260 | как выше | как выше | нет | нет | EquipmentImportPreview.tsx:308 |
| POST /api/equipment/import-undo | server/routes/equipmentUndo.ts:97 | update :176 (name), delete :222 | equipmentUndo.ts:176, :222 | нет | нет (prisma, .catch) | src/screens/Equipment.tsx:440; src/components/e3flux/E3AttributeUpload.tsx:66 |
| DELETE /api/systems/:id | server/routes/tags.ts:636 | delete | tags.ts:673 | нет | да (prisma.$transaction, tags.ts:652) | src/screens/Equipment.tsx:658 |
| DELETE /api/projects/:id (каскад) | projectDelete.ts:164 | deleteMany | projectDelete.ts:164 | нет | да | см. DELETE /api/projects/:id |
| POST /api/settings/entity-id-migration/apply (undo) | entityIdMigration.ts:385 / :431 | PK-миграция (raw) | entityIdMigration.ts:370, 381 | из сохранённого плана | да | EntityIdMigrationPanel.tsx:36 |

Прежний счёт 6/6. Разница: parse-and-import, import-jobs (фон) и миграция.

---

## Monoblock

Всего 10 / без сверки от клиента 10.

| метод и путь | обработчик | операция | запись | сверка сейчас | в транзакции | клиентский файл |
|---|---|---|---|---|---|---|
| POST /api/projects/:projectId/excel/parse-and-import | tags.ts:508 → excelParser.ts:679 | create | excelParser.ts:729 | нет | нет | не найдено (см. ES) |
| POST /api/equipment/import-to-category | equipmentCore.ts:71 → equipmentImport.ts:93 | create | equipmentImport.ts:170, :175 | нет | нет | EquipmentImportPreview.tsx:269 |
| POST /api/equipment/source-import/apply | equipmentSourceImport.ts:203 | create | equipmentImport.ts:170, :175 | нет | да (:255) | не проверено |
| POST /api/equipment/import-draft | equipmentDraft.ts:316 | create | как выше | нет | да (:361) | EquipmentImportPreview.tsx:261 |
| POST /api/import-jobs (фон) | routes/importJobs.ts:47 → importJobs.ts:260 | create | как выше | нет | нет | EquipmentImportPreview.tsx:308 |
| POST /api/equipment/projects/:projectId/sources/:sourceId/candidates/:candidateId/decisions | equipmentXmlSources.ts:498 | create | equipmentXmlSources.ts:703 | из сохранённого плана | да | не проверено |
| POST /api/equipment/import-undo | equipmentUndo.ts:97 | delete | equipmentUndo.ts:212 | нет | нет (.catch) | Equipment.tsx:440 |
| DELETE /api/systems/:id | tags.ts:636 | deleteMany | tags.ts:672 | нет | да (tags.ts:652) | Equipment.tsx:658 |
| DELETE /api/projects/:id (каскад) | projectDelete.ts:163 | deleteMany | projectDelete.ts:163 | нет | да | см. DELETE /api/projects/:id |
| POST /api/settings/entity-id-migration/apply (undo) | entityIdMigration.ts:385 / :431 | PK-миграция | entityIdMigration.ts:370, 381 | из сохранённого плана | да | EntityIdMigrationPanel.tsx:36 |

Прежний счёт 7/7. Разница: parse-and-import, import-jobs, миграция.

---

## ComponentElement

Всего 25 / без сверки от клиента 24. Версия от клиента есть у PUT catalog-source (equipmentCatalog.ts:51-55).

Версия растёт (`withBump`/`BUMP`/ручной +1) или нет — колонка «рост версии» дана в последней колонке строки.

| метод и путь | обработчик | операция | запись | сверка сейчас | в транзакции | клиентский файл | рост версии |
|---|---|---|---|---|---|---|---|
| PUT /api/equipment/component/:id/class | server/routes/equipmentEdit.ts:170 | update | equipmentEdit.ts:177 | нет | нет | src/components/equipment/TypeChip.tsx:41 | да (withBump) |
| POST /api/equipment/component/:id/tag | equipmentEdit.ts:244 | update (+ linkParentTag) | equipmentEdit.ts:255 | нет | нет | Equipment.tsx:593 | да (withBump) |
| POST /api/equipment/component/:id/position | equipmentEdit.ts:197 → createPosition :325 | create | equipmentEdit.ts:369 | нет (новая позиция) | нет | Equipment.tsx:561 | version: 1 при создании |
| POST /api/equipment/monoblock/:id/position | equipmentEdit.ts:214 → createPosition | create | equipmentEdit.ts:369 | нет | нет | Equipment.tsx:561 | version: 1 |
| DELETE /api/equipment/component/:id | equipmentEdit.ts:49 | update (:81 отвязка тегов), updateMany (:87 перевешивание детей), delete (:92) | equipmentEdit.ts:81, 87, 92 | нет | да (tx) | не проверено | НЕТ (:81, :87) |
| POST /api/equipment/component/:id/resolve | server/routes/equipmentCore.ts:141 → writeEditableEquipmentParam (server/equipmentParamAccess.ts:25) | update where version | equipmentParamAccess.ts:36; equipmentCore.ts:166-168 | со своим чтением (version из comp, equipmentCore.ts:167) | да (Serializable, equipmentParamAccess.ts:31) | src/screens/Equipment.tsx:610 | да (withBump) |
| POST /api/equipment/component/:id/override | equipmentCore.ts:182 → writeEditable… | update where version | equipmentCore.ts:199 | со своим чтением | да | src/screens/Equipment.tsx:618 | да |
| POST /api/components/:id/accept-field | equipmentCore.ts:207 → writeEditable… | update where version | equipmentCore.ts:237-239 | со своим чтением | да | не найдено поиском | да |
| POST /api/components/:id/manual-edit-field | equipmentCore.ts:255 → writeEditable… | update where version | equipmentCore.ts:282-284 | со своим чтением | да | не найдено поиском | да |
| POST /api/components/:componentId/tags/:tagId | server/routes/tags.ts:698 | update (connect) | tags.ts:715 | нет (проверка занятости тега) | нет | не найдено поиском | да (withBump) |
| DELETE /api/components/:componentId/tags/:tagId | tags.ts:733 | update (disconnect) | tags.ts:737 | нет | нет | не найдено поиском | да (withBump) |
| POST /api/components/:componentId/resolve-conflict | tags.ts:787 | update (флаги) | tags.ts:794 | нет | нет | не найдено поиском | НЕТ |
| DELETE /api/systems/:id | tags.ts:636 | update (:664 отвязка), deleteMany (:671) | tags.ts:664, 671 | нет | да (tags.ts:652) | src/screens/Equipment.tsx:658 | НЕТ (:664) |
| PUT /api/equipment/component/:id/catalog-source | server/routes/equipmentCatalog.ts:44 | updateMany where version | equipmentCatalog.ts:112-114 | version от клиента (expectedVersion, :51-52; expectedRevision :55) | не проверено | src/components/equipment/CatalogSourcePanel.tsx:264 (expectedVersion: version :275) | да (withBump) |
| POST /api/projects/:projectId/e3-attribute-upload/apply | server/routes/e3AttributeUpload.ts:90 | update | e3AttributeUpload.ts:103 | нет | да (tx) | не проверено | да (withBump) |
| POST /api/projects/:projectId/excel/parse-and-import | tags.ts:508 → excelParser.ts:679 | update (:793, :808, :865), create (:824), delete (:876) | excelParser.ts:793-876 | нет | нет | не найдено (см. ES) | :793 ручной version+1 (не атомарно); :808, :865 НЕТ; :824 create |
| POST /api/equipment/import-to-category | equipmentCore.ts:71 → equipmentImport.ts:93 | create (:203), update (:306) | equipmentImport.ts:203, 306 | нет | нет | EquipmentImportPreview.tsx:269 | :306 только если changed (BUMP); markRemoved/restoreRemoved (equipmentLifecycle.ts:32, :61) withBump; transferTags (:94) НЕТ |
| POST /api/equipment/source-import/apply | equipmentSourceImport.ts:203 | как выше | как выше | нет | да (:255) | не проверено | как выше |
| POST /api/equipment/import-draft | equipmentDraft.ts:316 | как выше | как выше | нет | да (:361) | EquipmentImportPreview.tsx:261 | как выше |
| POST /api/import-jobs (фон) | routes/importJobs.ts:47 → importJobs.ts:260 | как выше | как выше | нет | нет | EquipmentImportPreview.tsx:308 | как выше |
| POST /api/vdr/tag-links/apply | vdr.ts:754 → equipmentTags.ts:196 applyTagLinks | update | equipmentTags.ts:286 | нет | не проверено | не найдено поиском | только если не fresh (:286) |
| POST /api/equipment/import-undo | equipmentUndo.ts:97 | update (:149, :172-:191 withBump; :197 delete) + applyCatalogSourceUndo (equipmentCatalogUndo.ts:77, withBump) + applyXmlRevisionUndo (equipmentXmlUndo.ts:220) | equipmentUndo.ts:149-197; equipmentXmlUndo.ts:220 | из сохранённого плана undo (equipmentXmlUndo.ts:220: where version = target.newVersion) | да (tx в xml-undo/catalog-undo); inline-запись в equipmentUndo.ts не в tx | src/screens/Equipment.tsx:440 | да, кроме ветки без изменений (equipmentXmlUndo.ts:218: version = newVersion) |
| POST /api/equipment/projects/:projectId/sources/:sourceId/candidates/:candidateId/decisions | equipmentXmlSources.ts:498 | updateMany (откат, :547; применение, :696), create (:724) | equipmentXmlSources.ts:547, 696, 724 | из сохранённого плана (expectedVersions предпросмотра, :208, :243) | да | не проверено | :547 откат: version = oldVersion (вниз, без роста); :696 withBump при changed |
| DELETE /api/projects/:id (каскад) | projectDelete.ts:162 (componentElement within monoblockIds) | deleteMany | projectDelete.ts:162 | нет | да | см. DELETE /api/projects/:id | — |
| POST /api/settings/entity-id-migration/apply (undo) | entityIdMigration.ts:385 / :431 | PK-миграция | entityIdMigration.ts:370, 381 | из сохранённого плана | да | EntityIdMigrationPanel.tsx:36 | — |

Итог по версии (раздел 3 ниже): НЕ растёт версия в DELETE /api/equipment/component/:id (:81, :87), в resolve-conflict (tags.ts:794), в DELETE /api/systems/:id (:664), в transferTags (equipmentLifecycle.ts:94), в excelParser.ts:808 и :865 (флаги конфликта), в ветке без изменений equipmentXmlUndo.ts:218. Прежний счёт 21/19.

---

## DocRegister

Всего 6 / без сверки от клиента 4 (с DELETE проекта без него 5/3, это прежний счёт).

| метод и путь | обработчик | операция | запись | сверка сейчас | в транзакции | клиентский файл |
|---|---|---|---|---|---|---|
| POST /api/vdr/registers | server/routes/vdr.ts:355 | create | vdr.ts:364 | нет | нет | src/components/vdr/VdrPanel.tsx:349 |
| PUT /api/vdr/registers/:id | vdr.ts:387 → vdrWrite.ts:90 guardedUpdate (db[model].updateMany :101) | update | vdrWrite.ts:101 | expectedUpdatedAt (vdr.ts:389, 403) | да (inTransaction, vdrWrite.ts:94) | VdrPanel.tsx:890 (тело body; поле expectedUpdatedAt не проверено) |
| POST /api/vdr/registers/:id/revision-up | vdr.ts:426 → guardedIssue (vdrWrite.ts:120, :137) | update | vdrWrite.ts:137 | expectedRevision (vdr.ts:438) | да | VdrPanel.tsx:335 |
| DELETE /api/vdr/registers/:id | vdr.ts:462 | delete | vdr.ts:471 | нет | нет | не проверено |
| POST /api/vdr/import | vdr.ts:891 | create (:917), update (:1037) | vdr.ts:917, 1037 | нет | нет | src/components/vdr/VdrPanel.tsx:307 |
| DELETE /api/projects/:id (каскад) | projectDelete.ts:140 | deleteMany | projectDelete.ts:140 | нет | да | см. Project |

---

## DocRegisterItem

Всего 14 / без сверки от клиента 11.

| метод и путь | обработчик | операция | запись | сверка сейчас | в транзакции | клиентский файл |
|---|---|---|---|---|---|---|
| POST /api/vdr/items | server/routes/vdr.ts:498 | create | vdr.ts:509 | нет | нет | src/components/docflow/AddToRegistryDialog.tsx:48 |
| PUT /api/vdr/items/:id | vdr.ts:524 → guardedUpdate (vdrWrite.ts:101) | update | vdrWrite.ts:101 | expectedUpdatedAt (vdr.ts:528, 537) | да | src/components/vdr/VdrPanel.tsx:260 (expectedUpdatedAt в теле); VdrPanel.tsx:291 шлёт без него (без сверки) |
| DELETE /api/vdr/items/:id | vdr.ts:611 | delete | vdr.ts:618 | нет | нет | не проверено |
| POST /api/vdr/items/:id/issue-revision | vdr.ts:801 → guardedIssue (vdrWrite.ts:137) | update | vdrWrite.ts:137 | expectedRevision (vdr.ts:813, 831) | да | src/components/vdr/VdrPanel.tsx:657 |
| POST /api/vdr/items/:id/revision-up | vdr.ts:881 (307-редирект на issue-revision) | как выше | как выше | expectedRevision (тело переносится) | да | не проверено |
| POST /api/vdr/import | vdr.ts:891 | update (:972), create (:976) | vdr.ts:972, 976 | нет | нет | VdrPanel.tsx:307 |
| PUT /api/tags/:id (смена identifier) | tags.ts:486 → tagWrite.ts:193 renameTagInVdr (server/vdrTags.ts:122) | updateMany (equipmentTags JSON) | vdrTags.ts:122 | version от клиента (тот же запрос тега) | да (tx) | src/components/registry/tagWrite.ts:131 |
| POST /api/docflow/links | server/routes/docflowLinks.ts:36 → createLink (server/docflowLinks.ts:117) → applyReturn (:189) | update | docflowLinks.ts:200 | нет | не проверено | src/lib/docflowApi.ts:68 |
| POST /api/docflow/issue/apply | server/routes/docflowIssue.ts:30 → server/docflowIssue.ts:136 applyIssue | updateMany (updatedAt своего чтения, revision/status из плана) | docflowIssue.ts:153 | со своим чтением + из плана | да | src/lib/docflowIssueApi.ts:14 |
| POST /api/docflow/issue/undo | docflowIssue.ts:31 → undoIssue (:180) | updateMany (updatedAt из сохранённого результата) | docflowIssue.ts:195 | из сохранённого плана | да | src/lib/docflowIssueApi.ts:15 |
| POST /api/docflow/kits/apply | server/routes/docflowKits.ts:23 → server/docflowKitRows.ts:129 applyKitRows | create | docflowKitRows.ts:139 | нет | да (tx) | src/lib/docflowKitApi.ts:19 |
| POST /api/docflow/kits/undo | docflowKits.ts:24 → undoKitRows (:154) | deleteMany (updatedAt из плана, status DRAFT) | docflowKitRows.ts:163 | из сохранённого плана | да (tx) | src/lib/docflowKitApi.ts:20 |
| POST /api/docflow/create-files/complete | server/routes/docflowCreateFiles.ts:28 → server/docflowCreateFiles.ts:66 completeCreateFiles | updateMany (updatedAt своего чтения) + createLink (:86) | docflowCreateFiles.ts:84 | со своим чтением | да (tx) | src/lib/docflowCreateApi.ts:12 (база) |
| DELETE /api/projects/:id (каскад) | projectDelete.ts:138-139 | deleteMany | projectDelete.ts:138 | нет | да | см. Project |

Замечание: DELETE /api/vdr/registers/:id не удаляет строки реестра кодом (нет в grep); каскад, если есть, в схеме БД.

---

## FileNode

Всего 36 / без сверки от клиента 34 (клиент присылает sha в PUT /api/office/files/:id/content и hash в PUT /api/project-data/files/:id/office-state).

| метод и путь | обработчик | операция | запись | сверка сейчас | в транзакции | клиентский файл |
|---|---|---|---|---|---|---|
| POST /api/files | server/routes/explorer.ts:410 | create | explorer.ts:455 | нет | нет | src/lib/dropUpload.ts:186 |
| POST /api/files/copy | explorer.ts:462 | create (:534), update (:516), applyScopeRecursive (:527 → explorer.ts:50) | explorer.ts:516, 534 | нет | нет | не найдено поиском |
| PATCH /api/files/:id | explorer.ts:553 | update | explorer.ts:575 | нет | нет | не найдено поиском |
| DELETE /api/files/:id | explorer.ts:588 | update (мягкое удаление) | explorer.ts:600 | нет | нет | src/lib/dropUpload.ts:212 |
| POST /api/files/:id/restore | explorer.ts:361 | update | explorer.ts:368 | нет | нет | не найдено поиском |
| DELETE /api/projects/:projectId/trash | explorer.ts:392 | deleteMany | explorer.ts:402 | нет | да (tx) | не найдено поиском |
| POST /api/desktop/move | server/routes/desktop.ts:101 | update (:128), applyScopeRecursive (explorer.ts:50) | desktop.ts:128 | нет | нет | src/services/dataService.ts:808 ← src/store/desktopStore.ts:319 |
| GET /api/desktop (побочно) | desktop.ts:34 → ensureOfficeOnDesk (server/systemFolders.ts:99) → migrateOfficeFolderToDesk (:60) | updateMany (:70) | systemFolders.ts:70 | нет (миграция по ключу) | нет | GET |
| POST /api/files/:id/chunk | server/routes/fileChunks.ts:82 | updateMany (updatedAt своего чтения) | fileChunks.ts:112 | со своим чтением (:111) | да (tx) | src/lib/dropUpload.ts:127 |
| POST /api/files/:id/done | fileChunks.ts:129 | updateMany (:145), update (:167) | fileChunks.ts:145, 167 | со своим чтением (:144) | да (tx) | src/lib/dropUpload.ts:141 |
| PUT /api/office/files/:id/content | server/routes/officeFiles.ts:323 → writeOfficeFile (:96) | updateMany claim (:185), update (:207) | officeFiles.ts:185, 207 | sha от клиента (x-base-sha256 → baseSha, :331) + updatedAt своего чтения | да (tx) | src/screens/OfficeHost.tsx:180; src/screens/MdFileHost.tsx:47 |
| POST /api/office/files/:id/copy | officeFiles.ts:346 → copyOfficeFile (:254) → createFileFromBytes (server/officeStore.ts:98) | create | officeStore.ts:111 | нет | да (tx) | src/screens/OfficeHost.tsx:235 |
| POST /api/office/files/new | officeFiles.ts:379 → createFileFromBytes (:417) | create | officeStore.ts:111 | нет | да | src/lib/officeFiles.ts:47 |
| POST /api/office/files/:id/as-xlsx | server/routes/officeConvert.ts:43 → createFileFromBytes (:67) | create | officeStore.ts:111 | нет | да | src/screens/SheetCopyEntry.tsx:23 |
| POST /api/office/files/:id/english | server/routes/officeEnglish.ts:90 → writeOfficeFile (:113), createFileFromBytes (:123) | update, create | officeFiles.ts:185, 207; officeStore.ts:111 | со своим чтением (baseSha = sha своего чтения, officeEnglish.ts:114) | да | не найдено поиском |
| POST /api/office/files/:id/versions/:vid/restore | server/routes/officeVersions.ts:53 → writeOfficeFile (:59) | update | officeFiles.ts:185, 207 | со своим чтением (baseSha = sha своего чтения, officeVersions.ts:60) | да | не найдено поиском |
| POST /api/project-data/files/:id/update | server/routes/projectData.ts:556 → writeOfficeFile (:613) | update | officeFiles.ts:185, 207 | со своим чтением (baseSha = sha, projectData.ts:612) | да | src/screens/OfficeHost.tsx:457; src/components/office/OfficeAppEditor.tsx:425; src/components/office/FluxPanel.tsx:512 |
| PUT /api/project-data/files/:id/office-state | server/routes/projectOffice.ts:287 → writeOfficeFile (:298) | update | officeFiles.ts:185, 207 | hash от клиента (req.body.baseHash, projectOffice.ts:290) | да | не проверено |
| socket office:ipc, копия | server/officeHostApps.ts:181 → copyOfficeFile (:201) | create | officeStore.ts:111 | нет | да | через Socket.IO (клиент: не проверено) |
| socket office:ipc, сохранение | server/officeHostApps.ts:181 → writeOfficeFile (:220, :227) | update | officeFiles.ts:185, 207 | baseSha = s.sha из серверной сессии | да | через Socket.IO |
| POST /api/vdr/registers/:id/export | server/routes/vdr.ts:1045 → createFileFromBytes (:1125) | create | officeStore.ts:111 | нет | да | src/components/vdr/VdrPanel.tsx:322 |
| POST /api/office/revisions/:fileId/issue | server/routes/officeRevisions.ts:180 → claimOfficeDocument (server/officeRevisions.ts:153) | updateMany (updatedAt своего чтения) | officeRevisions.ts:155 | со своим чтением | да (tx, :205) | src/components/office/FluxRevisionPanel.tsx:71 |
| POST /api/office/revisions/:fileId/draft | officeRevisions.ts:225 | updateMany (:259, сравнение с source :258), create (:263) | officeRevisions.ts:259, 263 | со своим чтением | да (tx) | src/components/office/FluxRevisionPanel.tsx:86 |
| POST /api/file-sharing/publications | server/routes/fileSharing.ts:14 | create (:26), update (:38) | fileSharing.ts:26, 38 | нет | да (tx) | src/services/fileSharingService.ts:73 |
| POST /api/chat/upload/start | server/routes/chatUploads.ts:59 → dropUpload (:53) | create (:75), deleteMany (:55) | chatUploads.ts:75, 55 | нет | нет | src/lib/chatFileTransfer.ts:40 |
| POST /api/chat/upload/:id/done | chatUploads.ts:115 | update | chatUploads.ts:138 | нет | нет | src/lib/chatFileTransfer.ts:63 |
| DELETE /api/chat/upload/:id | chatUploads.ts:106 → dropUpload | deleteMany | chatUploads.ts:55 | нет | нет | src/lib/chatFileTransfer.ts:73 |
| POST /api/chat/upload | server/routes/chat.ts:378 | create | chat.ts:399 | нет | нет | не проверено |
| DELETE /api/chat/messages/:id | chat.ts:347 → releaseChatFiles (server/services/chatFiles.ts:72) | deleteMany | services/chatFiles.ts:80 | нет | нет | не проверено |
| DELETE /api/chat/groups/:id | chat.ts:700 → releaseChatFilesSafe (chat.ts:45) → releaseChatFiles | deleteMany | services/chatFiles.ts:80 | нет | нет | src/store/chatStore.ts:438 |
| DELETE /api/chat/conversation | chat.ts:842 → releaseChatFilesSafe (:856, :867) | deleteMany | services/chatFiles.ts:80 | нет | нет | не проверено |
| POST /api/archives/create | server/routes/archives.ts:196 → createInHome (:605) | create | archives.ts:613 | нет | нет | src/screens/Archives.tsx:213 |
| POST /api/archives/:id/edit-apply | archives.ts:305 → createInHome (:359) | create | archives.ts:613 | нет | нет | src/screens/Archives.tsx:189 |
| POST /api/archives/:id/extract | archives.ts:379 → createExtracted (:619) | create | archives.ts:668 | нет | нет | не проверено |
| POST /api/mail/attachments/:id/to-explorer | server/routes/mailLink.ts:83 | create | mailLink.ts:115 | нет | нет | src/services/mailService.ts:277 |
| DELETE /api/projects/:id (каскад) | projectDelete.ts:125 (fileNode within fileIds), :126 (folder) | deleteMany | projectDelete.ts:125 | нет | да | см. Project |

Не входит в счёт: services/chatFiles.ts:119 cleanOrphanChatFiles — в server/ нет ни одного вызова (только scripts/test-chat-*.ts). Мёртвый код по поиску.

---

## Dictionary

Всего 3 / без сверки от клиента 3.

| метод и путь | обработчик | операция | запись | сверка сейчас | в транзакции | клиентский файл |
|---|---|---|---|---|---|---|
| POST /api/projects/:projectId/dictionaries | server/routes/dictionaries.ts:68 → safeItems (:85) | create (с вложенными items) | dictionaries.ts:96 | нет | да (tx) | src/screens/DictionaryEditor.tsx:75 |
| DELETE /api/projects/:id (каскад) | projectDelete.ts:144 | deleteMany | projectDelete.ts:144 | нет | да | см. Project |
| POST /api/settings/entity-id-migration/apply (undo) | entityIdMigration.ts:385 / :431 | PK-миграция (raw) | entityIdMigration.ts:370, 381 | из сохранённого плана | да | EntityIdMigrationPanel.tsx:36 |

Прежний счёт 1/1: в нём не было каскада и миграции.

---

## DictionaryItem

Всего 6 / без сверки от клиента 6.

| метод и путь | обработчик | операция | запись | сверка сейчас | в транзакции | клиентский файл |
|---|---|---|---|---|---|---|
| POST /api/projects/:projectId/dictionaries/:dictionaryId/items | server/routes/dictionaries.ts:108 | create | dictionaries.ts:114 | нет | да (tx) | DictionaryEditor.tsx:98/109/174/185/390; src/components/dictionary/useTagDict.ts:86, useMarkingDict.ts:80, usePresets.ts:45 |
| PUT /api/dictionaries/items/:itemId | dictionaries.ts:123 | updateMany (where по before-значениям code/nameRu/parentId) | dictionaries.ts:142 | со своим чтением (:130-145) | да (tx) | src/components/dictionary/useTagDict.ts:180 (метод не сверен) |
| DELETE /api/dictionaries/items/:itemId | dictionaries.ts:184 | deleteMany | dictionaries.ts:198 | нет | нет | не проверено |
| POST /api/projects/:projectId/dictionaries (вложенные items) | dictionaries.ts:68 → safeItems (:85) | create | dictionaries.ts:96 | нет | да | DictionaryEditor.tsx:75 |
| DELETE /api/projects/:id (каскад) | projectDelete.ts:143 | deleteMany | projectDelete.ts:143 | нет | да | см. Project |
| POST /api/settings/entity-id-migration/apply (undo) | entityIdMigration.ts:385 / :431 | PK-миграция (raw) | entityIdMigration.ts:370, 381 | из сохранённого плана | да | EntityIdMigrationPanel.tsx:36 |

---

## TagTemplate

Всего 2 / без сверки от клиента 2.

| метод и путь | обработчик | операция | запись | сверка сейчас | в транзакции | клиентский файл |
|---|---|---|---|---|---|---|
| PUT /api/projects/:projectId/tag-template | server/routes/dictionaries.ts:34 | upsert | dictionaries.ts:38 | нет | нет | src/services/dataService.ts:666 (saveTagTemplate, метод POST) — вызовов по имени в src не найдено |
| DELETE /api/projects/:id (каскад) | projectDelete.ts:145 | deleteMany | projectDelete.ts:145 | нет | да | см. Project |

Несоответствие: клиентский `saveTagTemplate` шлёт `POST /projects/:id/tag-template` (src/services/dataService.ts:666-668), сервер принимает только `PUT` (dictionaries.ts:34). Метода POST для этого пути нет (rg по server/).

---

## ConstructorDoc

Всего 1 / без сверки от клиента 1. Маршрутов записи нет (раздел 1).

| метод и путь | обработчик | операция | запись | сверка сейчас | в транзакции | клиентский файл |
|---|---|---|---|---|---|---|
| DELETE /api/projects/:id (каскад) | projectDelete.ts:97 (ids), :129 (ConstructorDocVersion), :130 (ConstructorDoc) | deleteMany | projectDelete.ts:130 | нет | да | см. Project |

Вероятный второй путь: PK-миграция (server/entityIdMigration.ts:21, JSON_COLUMNS включает ConstructorDoc.bindings). ConstructorDoc не входит в MODEL_TABLES (:9-12); меняется ли JSON-колонка, не проверено.

---

## Итог

| модель | всего | без сверки от клиента | прежний счёт (всего/без) |
|---|---|---|---|
| Project | 5 | 5 | 3/3 (без seed и миграции) |
| Tag | 25 | 23 | 15/13 |
| EquipmentSystem | 9 | 9 | 6/6 |
| Monoblock | 10 | 10 | 7/7 |
| ComponentElement | 25 | 24 | 21/19 |
| DocRegister | 6 | 4 | 5/3 (без каскада DELETE проекта) |
| DocRegisterItem | 14 | 11 | 14/11 |
| FileNode | 36 | 34 | 18/17 |
| Dictionary | 3 | 3 | 1/1 |
| DictionaryItem | 6 | 6 | 3/3 |
| TagTemplate | 2 | 2 | 1/1 |
| ConstructorDoc | 1 | 1 | — |
| Итого | 142 | 132 | — |

Клиентская версия/хеш/expectedRevision есть в 10 строках: Tag PUT tags/:id и PATCH procurement (2), ComponentElement catalog-source (1), DocRegister PUT и revision-up (2), DocRegisterItem PUT items, issue-revision, revision-up (3), FileNode PUT office/content и PUT office-state (2).

---

## 1. ConstructorDoc: маршруты записи

Поиск `rg -n -i "constructorDoc" server electron src shared` (с учётом `scripts/`):
- server/projectDelete.ts:97, 129, 130 — каскад при удалении проекта (DELETE /api/projects/:id).
- server/entityIdMigration.ts:21 — только имя колонки в JSON_COLUMNS.
- server/localSchema.ts:18, 35, 37, 40, 49, 51 — DDL SQLite (CREATE TABLE ConstructorDoc / ConstructorDocVersion и индексы).
- server/projectEntityAccess.ts:67 — строка-ключ для проверки доступа, не запись.
- src/lib/sectionAliases.ts:23 (`/constructor` → `/sheet`), src/handbook/names.ts:41-42 — подписи. Маршрутов, которые пишут ConstructorDoc, нет. Таблица заполнена только в scripts/test-entity-id-migration-sqlite.ts:102 (фикстура).

## 2. Tag: version = updatedAt

Сервер:
- server/tagWrite.ts:126-130 `sameVersion(version, updatedAt)`; :173 сверка (`stale`), конфликт при изменении полей или не-раскладочных ключей; :179 раскладка не меняет updatedAt; :188 `tx.tag.update({ where: { id, updatedAt } })` (условная запись).
- server/routes/tags.ts:486-494 — PUT /api/tags/:id принимает `version` из тела; :488 приводит к строке.
- server/routes/tagProcurement.ts:36, 41 — PATCH procurement, тот же механизм.
- server/routes/tags.ts:470 — bulk-metadata отдаёт `versions` (updatedAt) и сам версию не сверяет.
Клиент:
- src/components/registry/tagWrite.ts:68 `versionOf(tag)` = `later(tag.updatedAt, known)`; :86-90 шлёт `version` в `send()`; :71 `rememberVersions`; :131 PUT, :142 PATCH.
- Без version: src/screens/ProcurementManagement.tsx:421, 455; src/screens/Registry.tsx:1628 (bulk-metadata).
- Колонка Tag.updatedAt на SQLite добавлена вручную: server/localSchema.ts:279 (ALTER, если колонки нет).

## 3. ComponentElement: рост version

Растёт (withBump/BUMP или bumpElementsOfTags): equipmentVersion.ts:16-29 (BUMP); equipmentCore.ts:168, 199, 239, 284; equipmentEdit.ts:179, 255; tags.ts:717, 739; e3AttributeUpload.ts:103; equipmentCatalog.ts:114; equipmentCatalogUndo.ts:79; equipmentUndo.ts:154-191; equipmentXmlUndo.ts:218; equipmentXmlSources.ts:696 (только при changed); equipmentLifecycle.ts:32, 61; equipmentImport.ts:306 (только при changed); equipmentTags.ts:286 (кроме fresh); excelParser.ts:793 (ручной +1); tagWrite.ts:191 (смена identifier → bumpElementsOfTags).

Без роста (записи, которые должны бы менять позицию):
- equipmentEdit.ts:81 (отвязка тегов), :87 (перевешивание детей).
- tags.ts:664 (отвязка при удалении системы), :671 (deleteMany монoблоков).
- tags.ts:794 (resolve-conflict, только флаги).
- excelParser.ts:808, :865 (флаги конфликта и ORPHANED_TAG).
- equipmentLifecycle.ts:94 (transferTags: перенос тегов).
- equipmentXmlSources.ts:547 — откат: `version: snapshot.oldVersion` (версия вниз, без роста).
- equipmentXmlUndo.ts:218, ветка без изменений: `version: target.newVersion`.

## 4. Наборы проверок с ручным CREATE TABLE по 12 моделям

`rg -ln "CREATE TABLE" scripts/ server/ electron/` (файлы):
- server/localSchema.ts — ConstructorDoc (:18), DocRegister (:54), DocRegisterItem (:68).
- server/routes/vdr.ts — DocRegister (:37), DocRegisterItem (:53) (pg-fallback в ensureTables :29).
- scripts/test-equipment-xml-routes-sqlite.ts:27-32 — Project, Tag, EquipmentSystem, Monoblock, ComponentElement (ручные DDL-фикстуры).
- scripts/test-catalog-publication.ts:61 — Project (MariaDB, IF NOT EXISTS).
- Общие генераторы по prisma-схеме (все модели, включая 12): server/ddl.ts, server/schema-sync.ts:464/472, scripts/test-office-flux-part.ts:50 (`CREATE TABLE "${model.name}"`), scripts/test-schema-sync.ts, scripts/test-schema-runtime.ts, scripts/test-startup-database-bootstrap.ts (какие модели внутри — не проверено).

## 5. Синхронизация схемы на старте

Для удалённой базы (MariaDB/PostgreSQL) и локального SQLite по prisma-схеме:
- server.ts:330 → server/schema-sync.ts:417 `ensureRemoteSchema`: ALTER ADD COLUMN (`sql(false/true)`, :406-411), CREATE TABLE IF NOT EXISTS (:464, :472), уникальные ключи (`ensureUniqueKeys` :358, CREATE UNIQUE INDEX :373; дубли — лог и пропуск, schema-sync.ts:362-369), индексы связей (:531).
- server/databaseBootstrap.ts:40 → тот же `ensureRemoteSchema` для SQLite.
- Ручные ALTER для SQLite (server/localSchema.ts:12 `ensureSchemaColumns`, вызовы databaseBootstrap.ts:52 и server/routes/system.ts:93): DocRegister (:267), DocRegisterItem (:274), Tag.updatedAt (:279), Folder.system (:286), FileNode.refId (:291), User.* (:298-314). Tag.codeKey здесь НЕ добавляется.
- Tag.codeKey (#172, коммит ced50a5): колонка и `@@unique([projectId, codeKey])` добавлены в prisma/schema*.prisma. Колонка и ключ создаются общим путём ensureRemoteSchema (ALTER :406, ключ :373). Заполнение старых тегов — schema-sync.ts:511-512 → server/tagCodeKey.ts:135 (сырой UPDATE Tag SET codeKey). Отдельного ручного ALTER для codeKey нет (rg codeKey: server/tagCodeKey.ts, server/schema-sync.ts, server/routes/tags.ts, server/tagWrite.ts, server/equipmentTags.ts; localSchema.ts :11-15 — только OpReceipt).
- server/ddl.ts:202-277 `ensureTables` — ALTER ADD COLUMN для TableSpec модулей; для 12 моделей спец нет (rg `table: 'Tag'` и т.п. — пусто).

## 6. Клиент: общая точка запросов

- src/config/env.ts:111 — `window.fetch` переопределён: все `fetch` в браузерном контексте идут через него (изначальный — `originalFetch`, :96).
- Для /api: :150-151 заголовок X-Flux-Auth-Transport для логина; :156-161 для не-GET/HEAD/OPTIONS выставляется X-Flux-CSRF и X-Flux-Op-Id — случайный UUID на каждый вызов, если заголовка нет (:159-160).
- Ни один вызов в src/ не передаёт свой X-Flux-Op-Id (rg: только env.ts:158-160 и комментарии). Поэтому повтор того же логического запроса (двойной клик, повтор после сбоя) получает новый ключ, и защита server/opReceipt.ts не срабатывает.
- Счёт вызовов `fetch(`: src/ — 360 (без env.ts), electron/ — 2. Общая обёртка на уровне сервиса: src/services/dataService.ts:408 `request()` (fetch :426) и src/config/env.ts; обходов через `originalFetch` нет: единственное использование — env.ts:171, внутри самой обёртки.
- Вызовы без пути через window.fetch: electron (процесс main) и Socket.IO (office:ipc) — ключа повтора нет.
