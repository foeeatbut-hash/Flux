# Документооборот — этап 1: передача (читать целиком)

Ветка `docflow/stage-1`, PR #138 (draft) в `main`. Коммиты только поверх: **без force-push, rebase и amend**;
перед push — `git fetch` + `git merge origin/docflow/stage-1`, перед PR — `git merge origin/main`.
Не трогать Studio/`modules/`/Store и панель «Черновики». Этап 2 не начинать.
Этот файл удалить (`git rm`) в последнем коммите, когда этап готов и описан на страницах программ.

## Цель и где читать

`docs/docflow-program.md`: решения владельца (начало), этап 1 — раздел 12 (пять шагов), готовность — там же,
решения по вопросам — раздел 13. Нужные разделы: 3 (Проводник ↔ ДО), 4 (связь файла и строки, проверка имени,
«Сверка с папкой»), 5 (настройки проекта), 7.3–7.4 (возвраты, реестр ссылками — частично сделано, см. ниже),
10 (без связи/одновременная работа), 11 (что убирается). Навыки: `flux-data-safety` (запись в базу),
`flux-verify` (проверки, снимки), `flux-architecture` (новые файлы ≤400 строк, храповик
`scripts/test-architecture.ts` правит только руководитель).

## Решения владельца, которые нельзя нарушать

1. Документ = файл в Проводнике. Имя файла по маске проекта несёт шифр, тип, ревизию; строка ВДР — запись о нём.
2. Связать можно из ДО и из Проводника. **Несходящееся имя не связывается**, видны расхождения по полям.
   Из Проводника имя исправляет сам человек (F2) — диалог переименование не предлагает (`renameOffer={false}`);
   из ДО предлагается «Переименовать в …» с предпросмотром или «Исправлю сам».
3. **Автосвязи нет — всегда спрашивать.** Совпало имя — предлагаем в «Сверке», решает человек.
4. Назначать файлы и возвраты может только тот, кому админ выдал `docflow.files` (по умолчанию — только
   администратору; в `DEFAULT_DENIED`, не в ролях). Проверяет и сервер (`server/vdrPermissions.ts`).
5. Старые локальные свойства файла (теги/проекты/ревизия/ответственный), статусы D/C/B/A, `fileNodeId`,
   «Проводник проекта» — удалены **без мастера переноса**. Серверный архив `FileNode` (`/api/files`) НЕ удалять.
6. Настройки ДО у каждого проекта свои (копия, не ссылка), переносятся с предпросмотром и отменой.
7. Файл выбирается окном Проводника Flux (`ImportFileChooser`), **не системным** диалогом Windows (требование
   владельца, `docs/methodology/03-programs/explorer.md`, «Выбор и сохранение файлов»). Команду моста
   `pickDocumentFile` я добавлял и снял — не возвращать.
8. Копия в «Выпуск» при выпуске — пока нет; заполнение файлов данными, штамп, письмо, выпуск Конструктора — позже.
9. Не дробить на много этапов: этап 1 — один PR.

## Сделано (коммиты в ветке)

- Шаги 1–2 (до меня: e6a107a, 2ec7c35, 2eb0b65, e46ff56): программа `/docflow`, вкладки, права `docflow.*`,
  редиректы старых адресов, настройки проекта (`DocflowSettings`, `shared/docflow/config.ts`, `server/docflowSettings.ts`,
  `server/routes/docflow.ts`, `src/components/docflow/*Settings*`, `MaskBuilder`), общая проверка имени
  `shared/docflow/nameMask.ts` (`parseFileName`, `checkName`, `buildFileName`, `placementFolder`, `isIgnored`).
- **Шаг 3 — d38baaf**: модель `DocFileLink` ×3 схемы (`pathKey` уникален только у действующей связи — «файл уже связан»
  решает индекс, а не чтение; история не удаляется, `unlinkedAt`); `server/docflowLinks.ts` +
  `server/routes/docflowLinks.ts` (`GET /api/docflow/links?projectId|itemId[&history=1]`, `POST …/plan`, `POST …/links`,
  `…/unlink`, `…/track`); сервер сам проверяет имя (`checkName`), папку (привязана к проекту строки, назначение:
  файл — work/issue/без назначения, замечания — returns), «заменить файл той же ревизии» (`replace`). Назначения
  папок: поля `purpose` и `locator` у привязки (`src/lib/projectFolderBindings.ts`,
  `server/routes/projectFolderBindings.ts`, `ProjectFolderBindingDialog.tsx`); у проекта одна папка на назначение.
  Набор `scripts/test-docflow-links.ts` (54), мутации (проверка имени, pathKey, назначение) валят его.
  `shared/docflow/links.ts` — типы и чистые правила.
- **Шаг 4 — 0dced6e, b0a2398, 7b7d0a2**: Проводник — `src/components/explorer/useExplorerDocflow.tsx` (сведения о файлах
  проекта, фильтры, меню «Документооборот ▸», слежение 3.5: переименование по размеру+отпечатку, пропажа → `lost`),
  `src/components/files/docEntryInfo.ts` (чистая), `DocColumns.tsx` (столбцы Шифр/Тип документа/Ред./Статус/В реестре,
  значок), `DocDetails.tsx` («Сведения»), правки `ContentsPane/SelectionPane/viewModel/WindowsExplorer`.
  ДО — `src/components/vdr/RowFileCells.tsx` (столбцы «Файл»/«Возврат» ссылками, правая кнопка), перетаскивание файла
  из Проводника на строку, `src/components/docflow/AssignFileDialog.tsx` («Назначить файл…/возврат…», план переноса,
  отмена журналом Проводника), `AddToRegistryDialog.tsx`, `RowPicker.tsx`, `NameCheckView.tsx`, `ReconcileTab.tsx`
  (вкладка «Сверка с папкой»), `shared/docflow/reconcile.ts` (4 группы 4.3, чистая), `src/lib/docflowFiles.ts`,
  `docflowAssign.ts`, `docflowApi.ts`, `useProjectDocs.ts`. Возврат: файл переносится в папку возвратов по маске
  `folders.returns`, код рассмотрения сохраняется обычным `PUT /api/vdr/items/:id` (статус/срок по правилам реестра).
  Наборы: `test-docflow-reconcile` (17), `test-docflow-entry-info` (13), браузерный `test-docflow-explorer-ui` (24, стенд
  `scripts/fixtures/docflow-stand.ts` + `windows-explorer-ui.html?docflow=1[&screen=docflow&tab=…]`), снимки обеих тем.
- **Шаг 5 (код) — 0a1fcf8**: удалены `metadata/setMetadata`, `carryMeta`, поиск по тегу/проекту/ревизии, правка свойств в
  окне (теперь только чтение Windows-свойств), столбцы/группировка «Теги/Ревизия/Ответственный», `FILE_STATUSES` и
  стадия/ревизия на столе (`Desk*`, `desktopStore.setStatus`, `dataService.setFileStatus`), `DocRegisterItem.fileNodeId`
  (схемы, `vdr.ts`, `localSchema.ts`, `officeSources.ts`, `projectFields.ts` — `vdrItemOf` теперь `null`, `VdrPanel`),
  «Проводник проекта» → «папка проекта в Проводнике». История действий над файлом (`state.metadata[id].history`) осталась;
  старые локальные записи при загрузке обрезаются до `{fileId, history}`. Удаление проекта чистит `DocFileLink` и
  `DocflowSettings` (`server/projectDelete.ts`, набор `test-project-delete-sqlite`).

## Осталось (в порядке важности)

1. **Довести CI до зелёного** (см. «Состояние CI»): последние правки (carryMeta в `test-windows-files-bridge`,
   `OPEN_BY_DEFAULT` в `test-builder-perms`, deep link свойств в `test-windows-explorer-ui`) — в коммите после 7b7d0a2;
   проверить check runs нового SHA, первую причину каждого красного — отдельно.
2. **Документы (шаг 5, не сделано)** — критерий: страницы описывают то, что в коде, без «Логика: позже»:
   - новая `docs/methodology/03-programs/docflow.md` (шаблон — `03-programs/README.md`: назначение, что на экране,
     раскладка, что было смешано, исключения, логика; вкладки Реестр/По тегам(каркас)/Выпуски(каркас)/Сверка/Настройки,
     столбцы «Файл»/«Возврат», назначение файлов, проверка имени);
   - `explorer.md` (раздел «Документооборот в Проводнике»: столбцы, значок, фильтры, «Сведения», меню, слежение;
     убрать описание локальных свойств; в таблице исключений системных окон — без `pickDocumentFile`),
     `management.md` (убрать вкладки «ВДР» и «Настройки документооборота», оставить закупки и управление проектом),
     `docs/plan.md` (отметить этап 1; пункты «Общие свойства Flux…» и «этап E» — переписать), `docs/roadmap/` по правилу его README;
   - справка `src/handbook/docflowArticles.ts`: дописать назначение файлов/возвратов, «Сверку с папкой», назначения папок,
     права `docflow.files`; `test-handbook` должен остаться зелёным.
3. **Снимки по `flux-verify`** лежат в `/tmp/flux-docflow-shots` (не в репозитории, при необходимости снять заново:
   `FLUX_UI_URL=<свой vite> FLUX_CHROME=… tsx scripts/test-docflow-explorer-ui.ts`). Смотреть глазами обе темы. Замечено:
   в «Сведениях» шапка таблицы Проводника наползает на панель при узком окне (не связано с этапом, можно отдельно).
4. **Выпуск (7.1) и код рассмотрения со сроками ответа (7.3)** — не делались; по заданию это этап 2 (запись в
   ветку/PR: этап 2 — «Комплекты, каталог проекта, файлы, выпуск, замечания»). Возврат (путь → перенос → ссылка → статус по
   коду) в этапе 1 сделан, кроме «изменён после выпуска» (нужен выпуск) и «+N»-логики для нескольких возвратов (есть).
5. **Проверка маски «на файлах рабочей папки»** в `MaskBuilder` (сейчас только по вставленным примерам): прочитать имена
   рабочей папки через `folderOfBinding` + `scanFolder` (`src/lib/docflowAssign.ts`) и показать разбор.
6. **Слежение**: переименованный файл ищется только среди одноимённо-размерных файлов той же папки; перенос в другую папку
   даёт «не найден». Файл «Не документ» из сверки записывает имя в `masks.ignore` целиком (не шаблоном).
7. Перед снятием draft — один полный `npm run check` (долго; падения из-за среды описаны ниже).

## Нюансы и ловушки

- Сервер: `server/docflowLinks.ts` берёт строку для проверки из `RowForCheck`; `planLink` возвращает `row` — клиент по нему
  собирает подпапку (`placementFolder`) и имя, чтобы совпадать с сервером. Не считать подпапку на клиенте из `PickRow`.
- Страж проекта (`server/projectEntityAccess.ts`) смотрит `itemId` только в теле одного запроса; пачка `track` проверяет
  доступ к проектам строк сама. Новые маршруты с `linkId` без `itemId` страж не покроет.
- Привязка папки хранится в `AppSetting` (журнал `explorer_project_bindings:shared:v1`), не в модели. Ключ места — 64 hex;
  `locator` нужен, чтобы найти папку на другом компьютере (`resolvePortableFolder`); привязки без `locator` (старые) ДО
  не может найти — человеку надо «Привязать к проекту» заново.
- Цепочка `locationKeys` для файла: первым идёт сам файл, привязанная папка — на индексе `depth`; путь внутри — последние
  `depth` сегментов (`relativeInBinding`). Файл в корне привязанной папки: depth=1.
- Мост: `fileHash` возвращает `{sha256, size}`; `move` отказывает при изменённом файле (`baseSha256`); `mkdir` падает, если
  папка есть (поэтому `ensureFolders` сперва `stat`); имя группы отмены — `^[\w.:-]{1,64}$`.
- `shared/docflow/nameMask.ts`: поле кончается на первом знаке следующего разделителя, последнее берёт остаток; омоглифы А/A
  равны. Заказ внутри шифра отдельно не сверяется.
- `ProjectFolderBinding` в `src/lib` импортирует `shared/docflow/links` — допустимо; `src/lib` не должен импортировать
  `components` (потому `docflowFiles.ts` сам зовёт `locationKeys`).
- Палитра: цвета вне палитры Flux (например `violet`) валят `test-architecture`; тон `violet` из настроек рисуется как `sky`.
- Окружение: не пользоваться `sleep` + чтение файла; долгие наборы — в фон. Генерация Prisma пишет в `prisma-clients/*`;
  перед коммитом вернуть `prisma-clients/*/package.json` (меняется только хеш). Свой Vite — на своём порту (не 3000).
- Файл `scripts/test-windows-explorer-ui.ts` (900 с) тяжёлый: гнать в фоне.

## Проверки

Быстро (после правок): `NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc --noEmit` (смотреть код выхода) и
`node_modules/.bin/tsx scripts/run-checks.ts docflow explorer-native explorer-operations explorer-view-model explorer-shell.ts project-folder project-delete vdr- windows-files.ts windows-files-bridge windows-network architecture test-desktop.ts verification- handbook builder-perms`.
Браузерные (нужен свой Vite `node node_modules/vite/bin/vite.js --port <порт>` и Chrome
`/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`): `test-docflow-explorer-ui`, `test-windows-explorer-ui`.
Падают из-за среды (и до моих правок): `test-schema-databases` (нужен `FLUX_SCHEMA_MARIA_FIXTURE_URL`),
`test-remaining-collaboration-handbook-ui` и другие `*-ui` без сервера/Chrome, `windows-files-electron` (нет Electron),
`windows-files-bridge` закрытие программы — местами. Не проверено: Windows (переименование, сетевые папки, окно выбора файла),
схемы на живых PG/MariaDB (CI `security-db` проверяет), MariaDB `relativePath @db.Text`.

## Состояние CI

На SHA `0a1fcf8` (до исправлений набора) красными были `contracts` (deep link свойств в `test-windows-explorer-ui` —
ожидал «Проект 1 · текущий»), `windows-shell` (`test-windows-files-bridge`: проверка `carryMeta` в `ipc.ts`),
`security-db` (`test-builder-perms`: ждал `OPEN_BY_DEFAULT` без `docflow.view`; mariadb io_uring в логе — предупреждение,
не причина). Все три исправлены в тестах (решение: поведение верное, наборы устарели). `office-native` был в работе.
Актуальный итог — check runs последнего SHA PR #138: `gh api repos/foeeatbut-hash/Flux/commits/<sha>/check-runs`
(GraphQL из сессии недоступен — только REST).
