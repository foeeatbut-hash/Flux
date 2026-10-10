# ID проекта, позиций и полей

Задание владельца: убрать UUID из идентичности между Справочником, Каталогом, Тегами, Оборудованием и E3Flux. Выбрана полная замена старых ID в проектных данных, обязательная привязка ID к проекту. Сборки приложения/EXE запрещены ранее, запрет сохраняется.

База origin/main d46259eb; предыдущий PR104 содержит fixes до509f0c62, все4CI зелёные. Новая работа пока в той же ветке поверх предыдущей.

- [x] Аудит: позиции ужеUUID, E3дочерние по тегу, поляmetadata поназванию, XML требуеттег.
- [x] E3 связьпоparentElementId, целевыетестыпройдены.
- [x] СтабильныйIDполя, legacy migration rename, реальныйSQLiteHTTPтест.
- [x] ПроектныеID(PRJ/ EQ/ TAG/ SYS/ MB/ DICT/ FLD/ DI), единыйконкурентныйсчётчик и всеproductioncreatepaths.
- [ ] Read-onlypreview и explicit transactional migration/undo всехсылок кпроектнымID, JSONкодеки; внешняяE3 сверка либо блокировка доverifiedreconciliation.
- [x] XMLtagless explicit selector+fingerprint+rebind/reorder safety.
- [x] UImigration+startupreplay+localWindowscapabilitiespreserved.
- [ ] Types/architecture/targetedSQLite+UI+provider/WindowsCI currentSHA; PR/docs.

Агенты: id_migration_design — allocator/create paths; project_id_migration — backendmigration/tests; xml_position_ids — XMLroutes/UI/newselector/schemaaddfield; stable_field_ids — metadata/readers/rename/tests; e3_parent_ids — finishedE3logic, nowsettingsmigrationUI/localreplay.

Схема: projectIDs PRJ-000001, позиции PRJ-000001-EQ-000001, теги TAG, system SYS, monoblock MB, dictionary DICT, поля FLD/DI; пользовательскиеID/auth/mail не входят в замену связей пятипрограмм. Каталогseed IDs ужеbusiness nonUUID, не менятькодыизделий. ИсториямиграциидержитстарыеID какснимки дляотката, нелегасиlivealiases.

Контрольная точка 54479525: allocator, поля и XML сохранены. SQLite migration 12 и HTTP права 11 прошли. Types/architecture и инфраструктура8 прошли. Финальная проверка undo при новых сущностях, privacy socket, provider SQL ещё идут. Сборки нет.
