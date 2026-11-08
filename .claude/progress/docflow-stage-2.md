# Документооборот — этап 2б

Ветка docflow/stage-2b, от origin/main fbaa7505 (2а принят, PR #143 влит).
Новый PR пока не создан. В этой ветке нужен один черновик в main, шаги 4 и 5.
Без force-push; перед каждым push fetch и merge origin/main. После каждого
шага — сборка и проверки, отдельный русский коммит. В конце обновить PR,
все CI на последнем SHA должны быть green, включая Windows и office-native.

## Шаги

- [x] Шаг 4 реализован и проверен в рабочей копии, сейчас контрольный коммит.
- [x] Обе правки приёмки 2а включены: Windows device names/конец сегмента и
  лимит 200 только preview (applied/undone сохраняют TTL отмены 30 дней).
- [ ] Шаг 5: выпуск, возвраты, календарные сроки, сведения и история.
- [ ] Итоговые docs/PR, полный применимый check, все платформенные CI.

## Что сделано в шаге 4

Три CatalogFamily схемы: projectId, basedOnFamilyId/Revision, baseDataJson,
overridesJson; unique(projectId,basedOnFamilyId), индекс projectId, runtime DDL.
Позиция хранит закреплённую основу и разницу, dataJson — действующий документ.
server/projectCatalogData.ts и projectCatalogPlans.ts, routes/projectCatalog.ts:
GET /api/catalog/project и POST plan/apply/undo. catalog.project в FEATURES и
DEFAULT_DENIED, не выдан должностям (включая Разработчика); обычные права админа
сохраняются. Membership/existence/refs/CAS/SQL unique/undo на сервере.
Общий readCatalog строго projectId:null; все общие чтения/записи/revisions/
assets/usage/learn/workspace/import/archive/restore/publish защищены от project ID.
Оборудование читает правильный проект, source project/common и default project,
снимки сохранены, повторное чтение внутри TX, enrichment по проектам.
Перенос includeCatalog+token (также отдельно от sections), снимки и атомарная
отмена с config, детерминированные target ID, remap family references,
монотонные версии и защита использованных моделей; лимит 1000 позиций.

ProjectCatalog/ProjectFamilyEditor + обычный CatalogScreen, параметры (включая
десятичное значение default), характеристики, diff/reset/update, проектный слой.
Подготовка общего черновика — обычный PUT общего редактора с новым ID после
локального предпросмотра. catalog.project не даёт catalog.edit; scope виден.
Нормальный discard с revision, публикация отдельно; общий опубликованный и
проектная позиция не меняются. Снимки только в CI artifact, PNG не в git.

## Проверено

48 HTTP/SQLite проверок каталога проекта; global-boundary, catalog-copy,
settings (34), приемка name31/links65/create115/classes36; 11 итоговых CLI
наборов прошли. Реальная security-db-stage2 расширена шагом4, SQLite green;
MariaDB/PostgreSQL новый сценарий ещё не запускался, включён в существующий CI.
UI каталога green: 32 замера (4 состояния x 2 темы x 2 ширины x normal/opaque),
панель40/list32/поля32, разные реальные цвета/сплошной фон. Equipment UI green,
4 снимка 1440/1024 обе темы. Narrow просмотрен лично, wide проверен дополнительно.
Fixture Equipment теперь явно сканирует src Tailwind, иначе utility-классы
терялись. FLUX_CHROME=/usr/bin/chromium из runtime, не старый /opt path.
Последние build, build:electron, tsc8192, check:verification8/8, architecture и
coverage зелёные; build/tsc повторены после последнего proposal/UI изменения.
Логи /tmp/flux-stage2b-step4-*.log. Evidence docs/stand/docflow-stage-2b/README.md.

Мутации red с восстановлением: общий фильтр/ID guard, transfer token, equipment
TX fresh read; project right/CAS/override/SQLunique/undo-version/param-default;
UI autoapply, десятичный ввод (2505 вместо250.5), project ID вместо global ID.
Root логи /tmp/flux-project-mutant-*.log; restored API48 и UI green.
Документы шага4 обновлены, §13 и весь абзац Готово сохранены побайтно.

## Перед продолжением

Завершить контрольный коммит шага4 (git status, diff --stat; package.json
prisma-clients восстановить/не добавлять). Fetch+merge main, push branch и
создать draft PR; запись ниже обновить точным SHA и URL. Затем шаг5.
До конца работы этот файл сохранять; после сдачи удалить.
Сейчас исходники стабильны, все браузеры и сборки остановлены.

## Важная разведка шага 5 — реализация ещё НЕ начата

Рабочий файл — локальный capability: у сервера нет абсолютного пути. Mutable
DocFileLink.sha256 — последнее наблюдение, не независимое чтение диска.
Проводник хешировал только изменение размера/пропажу: same-size замена
пропускается. Старые /issue-revision и /revision-up обходят будущие проверки;
их надо направить в новый контракт, а не оставить старый выпуск.
RevisionRules отсутствует в normalizeDocflowConfig: добавить схему, настройки,
перенос и проверку следующей ревизии на сервере. История DocRegisterItemRevision
без immutable hash/linkId; новые nullable поля/unique issuedKey нужны на 3 СУБД.
Unique issuedKey=hash(item+revision) защитит новые выпуски, не ломая потенциальные
старые повторы истории. planId — ключ повторного запроса. Двое — второй409;
историю и строку одной TX, ошибка второй вставки откатывает всю пачку.
Undo массового выпуска обязателен: snapshot до записи, пока нет правок/возвратов;
историю лучше помечать отменённой, не стирать. Immutable hash не менять watcher.

Вариант проверки байтов: после явного подтверждения UI передаёт байты на тот же
сервер Flux, сервер хеширует потоком БЕЗ сохранения файла/копии. UI прямо
показывает эту передачу и получателя до подтверждения. Клиентский fileHash до
и при подтверждении + server computed digest должны совпадать с увиденным.
prepareImportRefs/readImportRef дают bounded ranged reads и стабильность inode/
mtime/ctime. Для короткого удержания физического файла Windows от записи при
подтверждении можно новый TS helper + фиксированный PowerShell worker:
FileStream Open / FileAccess.Read / FileShare.Read. Путь только stdin JSON,
в ответе только sha/size/chunks, ошибки без абсолютных путей. Один worker на
пачку до100 файлов, ограничить число workers/TTL, всегда release/cleanup.
Read share отказывает уже открытому writer, запрещает запись/rename до commit.
Так не меняется C# ABI. Реальные Windows sharing checks обязательны в CI.

LocalOffice держит копию в памяти и физически может не держать write-handle.
Нужен общий TTL реестр редактирования по project/folder/path, heartbeat из
WindowsFileHost/LocalOffice; officeHub.rosterOf относится к FileNode, не к этим
путям. Сервер проверяет право/проект/TTL/лимиты. Claim выпуска и начало editing
сериализовать, чтобы editor не открылся между проверкой и commit. Не обещать
независимое подтверждение физических байтов без нового реального протокола.

Возвраты: только к выданной revision (default последняя), несколько файлов,
код->status из project settings, received calendar date, due от неё, calendar
user timezone (не server timezone/добавление миллисекунд с DST). Сроки в реестре,
просрочка выделена; в Сведениях двунаправленные ссылки. Не копировать при выдаче,
не штамповать/заполнять/объединять с Конструктором; старые file props/status/fileNodeId
не возвращать. Все refs/server403/манифесты/мутации/3DB/снимки обязательны.

## Находки вне задачи

Уже известны из 2а: handbook /store,/module-requests и WindowDialog при сжатии
открытого окна. Не чинить попутно. Полный локальный runner имеет несовместимые
окружения API/Guide; не переносить старые stage1 runner patches. Описать пределы
проверки и фактические наборы. Ручные Windows network folders/rename/picker —
отдельная приёмка, не выдавать Linux mocks за Windows.
