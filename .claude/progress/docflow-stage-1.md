# Документооборот — этап 1 (передача следующему исполнителю)

Задание: `docs/docflow-program.md` — решения владельца в начале, этап 1 — раздел 12,
решения по вопросам — раздел 13. Ветка `docflow/stage-1`: коммиты только поверх,
без force-push/rebase/amend; перед push — `git fetch` + `git merge origin/docflow/stage-1`.
Не трогать Studio/modules/Store и панель «Черновики». Этап 2 не начинать.

## Сделано

- [x] Шаг 1 (e6a107a, внешний исполнитель): /docflow, вкладки, перенос VdrPanel/DocflowSettings, права docflow.*.
- [x] Шаг 1 — исправления (2ec7c35, 2eb0b65):
  - test-handbook падал: нет статьи /docflow, в правах vdr.* → `src/handbook/docflowArticles.ts`, правки work/topicArticles.
  - Новые ссылки на строку ВДР строились через `/management?vdr=` (vdr.ts, insight*.ts, TagVdrDocs, ProjectCheckView,
    Dashboard, notifCenter «ДОКУМЕНТЫ», actionWords, TranslateScreen) → теперь `/docflow?tab=registry&vdr=…`.
  - Перенаправление внутри окна «Менеджмента» оставляло пустое окно, которое при каждом выходе вперёд снова уводило в ДО.
    Теперь старый адрес переводится до открытия окна: `resolveSectionHref` (src/lib/sectionAliases.ts) +
    `windowStore.open/openAnother/restored`. Ловушка: в `restored()` нельзя звать `pathOf` — он объявлен ниже модуля (TDZ).
  - Гид: «документооборот/вдр» → /docflow (guide/engine.ts, queryWords.ts).
  - Проверено: права docflow.files в DEFAULT_DENIED и не в ролях; администратор проходит всё; «Менеджмент» без вкладок ДО.
- [x] Шаг 2 (e46ff56): настройки ДО проекта.
  - Модель `DocflowSettings` (projectId @unique, config/source/undo JSON) в трёх схемах; MariaDB — @db.LongText/@db.Text.
  - `shared/docflow/config.ts` — формат настроек (надмножество прежнего стандарта: reviewCodes/reasons/vdrTypes те же),
    статусы по умолчанию раздела 13, разделы переноса, `mergeSections`, `diffSections`, чтение меток прежнего стандарта.
  - `shared/docflow/nameMask.ts` — общая проверка имени (4.2): `parseFileName`, `checkName` (блокируют: не по маске,
    шифр, тип, ревизия не по схеме; остальное — предупреждения; новая ревизия — `isNewRevision`), `buildFileName`,
    `folderPath`, `isIgnored`, `maskErrors`. Ловушка: поле кончается на первом знаке СЛЕДУЮЩЕГО разделителя, последнее
    берёт остаток (тег «П-2» с дефисом); омоглифы А/A сравниваются как одно.
  - `server/docflowSettings.ts` + `server/routes/docflow.ts`: GET/PUT `/api/docflow/settings` (версия `expectedUpdatedAt`,
    null — первой записи; 409 с current), copy-plan/copy-apply/undo, templates (= прежние DocStandard), migration
    (plan/apply/undo, только администратор). Права — таблица `server/vdrPermissions.ts` (settings/templates/migration →
    docflow.settings, `/api/docflow/links` → docflow.files, прочая запись → docflow.edit, GET → docflow.view).
  - `standardOfRegister` (server/routes/vdr.ts) берёт настройки проекта, если они сохранены; статусы и «для сведения»
    в кодах рассмотрения — из настроек. VdrPanel берёт статусы/коды/типы из настроек проекта.
  - Окно: `src/components/docflow/` — DocflowSettings (разделы слева), MaskBuilder (конструктор + разбор примеров),
    RowsEditor, SettingsCopyDialog (источник → разделы → предпросмотр → применить), StandardsMigrationDialog;
    запросы — `src/lib/docflowApi.ts`.

## Проверки

- «До» (e6a107a): tsc 0; падали test-handbook (исправлено), test-schema-databases (нужен FLUX_SCHEMA_MARIA_FIXTURE_URL — среда),
  *-ui без сервера/Chrome, windows-files-electron (нет бинарника Electron), windows-files-bridge (закрытие программы — среда).
- После шага 2: tsc 0; `run-checks docflow vdr architecture schema-sync schema-runtime test-ddl handbook notify.ts` — зелёные,
  кроме test-remaining-collaboration-handbook-ui (UI без сервера, падал и до). Новые наборы: test-docflow-name (29),
  test-docflow-settings (34, SQLite+express), test-docflow-navigation расширен. Отрицательные мутации: убрать перевод
  адреса в sectionAliases / вернуть ссылку notifCenter → navigation падает; отключить сверку версии / настройки проекта
  в standardOfRegister → settings падает.
- НЕ проверено: снимки интерфейса ДО (обе темы), схема на живых PG/MariaDB (CI security-db), Windows.

## Осталось по разделу 12 этапа 1

- [ ] Шаг 3 — связь файл ↔ строка на сервере:
  - модель `DocFileLink` (3 схемы): itemId, revision, role (`file` | `remarks`), toLinkId (к какому файлу замечания),
    folderKey (= locationKey привязанной папки) + relativePath внутри неё, fileName, sha256, size, linkedById, unlinkedAt
    (история связей не удаляется), createdAt. Индексы: itemId, folderKey; MariaDB — relativePath @db.Text, без индекса по нему.
  - маршруты `/api/docflow/links` (право docflow.files уже в таблице): план/проверка имени через `checkName` на сервере
    (клиенту не верить), создание (отказ «файл уже связан с …» при второй строке — раздел 10), отвязка с историей.
    itemId в теле → общий страж проекта проверит строку (`vdrItem`).
  - назначение папок: расширить привязку `ProjectFolderBinding` (src/lib/projectFolderBindings.ts,
    server/routes/projectFolderBindings.ts, ProjectFolderBindingDialog.tsx) полем `purpose`: work/issue/returns/incoming.
    Файл в папке → `nearestBinding(bindings, chain)`; relativePath = последние depth+1 сегментов `ref.relativePath`
    (цепочка ключей — действие моста `locationKeys`, filesystem/contracts.ts).
- [ ] Шаг 4 — Проводник и ДО:
  - Проводник (src/components/files/ContentsPane.tsx, SelectionPane.tsx, useExplorerOperations.tsx, explorer/*):
    столбцы Шифр/Тип/Ред./Статус/В реестре, значок «не по маске» с подсказкой из `parseFileName().problems`, фильтры,
    «Сведения» со строкой ВДР, меню «Документооборот ▸» (3.3), перетаскивание файла на строку Реестра, слежение (3.5:
    по folderKey + sha256 через действие `fileHash`).
  - ДО (src/components/vdr/VdrPanel.tsx, 975 строк — новое выносить в components/vdr/*): столбец «Файл» со ссылкой,
    «Назначить файл…» (путь, «Переименовать в {buildFileName}» с предпросмотром или «Исправлю сам», перенос в рабочую
    папку по `folderPath(config.folders.work, rowFields(...))` с отменой журналом Проводника), вкладка «Сверка с папкой»
    (4.3; сейчас на её месте заглушка в src/screens/DocflowScreen.tsx) — чистая функция сверки в shared/docflow/ + набор.
  - Проверка маски «на файлах папки проекта» в конструкторе: сейчас — по вставленным примерам; добавить чтение имён
    рабочей папки, когда появятся назначения папок.
- [ ] Шаг 5 — удалить старое (3.6) без переноса: локальные свойства файла (electron/filesystem/state.ts,
  `WindowsFileMetadata`/`setMetadata`/`metadata` в filesystem/contracts.ts, service.ts, ipc.ts, undo.ts,
  replacementCopy.ts `carryMeta`, PropertiesWindow.tsx, WindowsPropertiesDialog.tsx, ContentsPane/SelectionPane,
  src/lib/windowsFiles.ts, наборы test-windows-files*, test-explorer-native-operations, test-windows-explorer-ui,
  test-catalog-workspace-http, fixtures/windows-explorer-ui.tsx, verification/manifests/files-office.json); D/C/B/A
  (src/components/explorer/FileItems.tsx — кто импортирует StatusChip/FILE_STATUSES); `DocRegisterItem.fileNodeId`
  (схемы ×3, server/routes/vdr.ts PUT/создание таблиц, localSchema.ts, VdrPanel Item); «Проводник проекта» →
  «папка проекта в Проводнике» (guide/engine.ts, MailThread.tsx, mailLink.ts). Серверный архив FileNode НЕ удалять.
- [ ] Документы: `docs/methodology/03-programs/docflow.md` (новая), `explorer.md`, `management.md`, `docs/plan.md`,
  справка `src/handbook/docflowArticles.ts` (дописать назначение файлов, сверку, настройки).
- [ ] Снимки ДО и Проводника в обеих темах по `flux-verify`; полный `npm run check` перед снятием draft.
- [ ] В конце — удалить этот файл (`git rm`).

Подготовка рабочей копии: клиенты Prisma после правки схемы генерировать в СВОИ `prisma-clients/*` (не симлинки на
основную копию — генерация пишет через симлинк); перед коммитом вернуть `prisma-clients/*/package.json` (меняется только хеш).
