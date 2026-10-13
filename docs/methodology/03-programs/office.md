# Flux Office

Flux Office opens and edits the original DOCX and XLSX files through the
GenOffice editors embedded in Flux. The Flux ribbon connects project data,
header bindings, translation, templates, and source comparisons to those same
files.

## Что на экране

- The editor keeps its native Word or Excel ribbon, canvas, status, selection,
  keyboard behavior, and save lifecycle.
- The Flux ribbon command opens one resizable side panel. Its tabs are
  «Выборка», «Поля и шапка», and «Обновление»; «Переводчик» remains available
  from the Flux ribbon.
- The selection view chooses the project, source, equipment types, filters,
  exclusions, and stable multi-field sort; it shows result counts and a
  virtualized preview.
- The header view inserts protected field bindings into the active Word/Excel
  anchor, while retaining ordinary text and document formatting. Its ordered
  editor can insert and move text, operators, and field parts, edit literal text
  and operators, and remove a field or a union alternative. A change is applied
  through the native editor schema bridge; Word's live text/token order is read
  back before it is shown as saved.
- Right-clicking a selected Flux-bound header cell opens cell actions. With one
  cell, the dialog inserts a catalog parameter or returns focus to the native
  formula editor. The formula is entered in that cell and starts with `=`;
  protected parameter chips and ordinary text/operators remain in the native
  document. With two adjacent header cells, the dialog previews one output
  column with ordered first-match parameter alternatives. Manual-value
  conflicts block confirmation; the first cell remains and the second is
  removed only after the preview is confirmed. Formula cells and headings with
  several separate parameter chips cannot be flattened into aliases; edit or
  simplify them in the native cell first.
- The update view compares live source fingerprints and the document hash, shows
  a fill plan, and applies a confirmed update through normal editor save/history.
- Templates are managed from the Flux ribbon. They store header structure and
  selection settings, not filled rows or personal data. Opening one maps its
  anchors and fields to the current document and catalog. Ambiguous anchors and
  unavailable fields stay pending for an explicit choice; saving the mapped
  schema is a separate action.
- The update view includes Office revisions: an issued revision is immutable,
  and edits continue in a separate draft created from that revision. Saved
  revisions can be compared by document content, source, bindings, and schema.

## Раскладка

- Keep the document canvas visible while the side panel is open. Its default
  width is 580 px, the left edge is resizable, width is local to the user, and
  narrow windows switch to a full-height overlay.
- The panel header shows the current file and close action. Search and source
  controls belong to «Выборка»; field search and insertion belong to «Поля и
  шапка»; source comparison and confirmation belong to «Обновление».
- The bottom «Заполнить» action stays in view and is disabled with a specific
  reason until the selection and document anchors are valid.
- Keep template save/open/pin/reload actions in the top Flux ribbon, not in the
  side panel. Translation keeps the existing local engine, memory, glossary,
  and review path.
- Cell actions belong to the native right-click context. The dialog may choose
  parameter alternatives and an output label, but formula text is edited in the
  native cell so the editor owns caret, selection, undo, and typing behavior.

## Что было смешано

The previous «Flux» panel combined source browsing, project fields,
translation, and generic data export in one section picker. The new panel gives
the schedule workflow three explicit stages while preserving the existing
project-field, translation, and export capabilities through their established
flows.

The schedule must use the live GenOffice editor and its file bridge. A
standalone substitute editor cannot preserve DOCX/XLSX parts, file identity,
save conflict handling, or collaborative sessions and must not be used as a
fallback.

## Исключения из общих правил

- The editor's GenOffice ribbon and document canvas retain their own layout;
  Flux owns only its added ribbon command and side panel.
- Bound values use compact in-editor tokens, but ordinary text remains editable
  around them. Token protection is owned by the editor model and must respect
  IME, selection, undo/redo, and screen readers.
- Engineering values and units are shown as received. The UI must surface
  incompatible units and missing values rather than silently converting them
  or replacing errors with zero.

## Логика

- Source rows and fields use stable `sourceId`, `entityType`, `entityId`,
  `fieldKey`, and source revision identities. Display text and row position
  are not identifiers.
- A selection is a query over project data, not a cached synthetic list.
  Search is debounced, filters apply only to available fields, sorting is
  stable, and long previews are virtualized.
- Filling is a preview-plan-apply flow. The plan includes the file base hash,
  source revision, affected anchors, adds/replacements, manual rows, skips,
  errors, and conflicts. Apply requires explicit confirmation and optimistic
  version checks; undo uses the saved before-image.
- A document anchor is a Word content control/custom XML identity or a
  sheet-scoped Excel name/custom metadata identity. A row binding carries the
  actual entity ID and source revision. Ordinary Microsoft Office must show
  normal headings and values without Flux chips.
- A template contains the ordered header parts, anchors/layout, query and sort
  settings, and a schema version. It excludes filled rows and personal data.
  Opening it never copies source-document anchor IDs: parts bind to anchors in
  the open document, and each unavailable mapping must be resolved before save
  or fill. Shared/personal permissions are enforced by the server.
- Office revision numbers are issued by the server from saved file snapshots.
  An issued revision cannot be edited; a draft is a separate file derived from
  an issued snapshot. The UI must not invent revision numbers from file history.

## Приёмка и проверки

- Follow `01-design.md` sections 5 and 8 for component vocabulary and visual
  review. Follow the test levels in the opening table of `04-testing.md`.
- Exercise the real GenOffice bridge for both DOCX and XLSX: create a header,
  type before/after/between bindings, insert and move literal text/operators,
  remove a protected field and an individual union alternative, undo/redo, and
  verify that the native readback preserves the exact order. Preview and fill,
  save/reopen, update a source revision, and undo.
- Exercise right-click actions with one selected header cell and two adjacent
  selected header cells in Word and Excel. Confirm formula focus returns to the
  native cell, the formula begins with `=`, preview orders parameter
  alternatives, the exact preview token is required for confirmation, and
  conflicting manual values leave both cells unchanged.
- Verify selection above 1,000 records, stable sort/filter behavior, empty and
  unavailable sources, null/zero values, ambiguous fields, and unit conflicts.
- Verify Word/Excel round-trip in Microsoft Office, template permissions,
  cross-document template mapping (ambiguous/missing anchors and unavailable
  fields included), and shared/personal permissions. Issue an immutable R1,
  confirm edits cannot change it, create an R2 draft, and compare both saved
  revisions. Also verify translation placement and stale translations, plus
  preservation of formulas, styles, merges, other sheets, and manual rows.
- Measure the panel and canvas at normal and narrow widths, inspect light and
  dark screenshots, and test keyboard focus and disabled/loading/error states.
- Browser fixtures do not establish Windows portable behavior or independent
  Microsoft Office round-trips; record those separately as pending until run.
  The added ordered-header, template-mapping, and revision flows still require
  the real DOCX/XLSX native bridge and revision API scenarios above; focused
  helper checks alone do not establish native round-trip behavior.

## Лента Flux и панель (ТЗ v10)

Основание: ТЗ владельца v10 и интерактивный макет v10 в
`docs/office-spec/`, аудит кода — `docs/office-spec/audit-v10.md`. Макет
задаёт вид и порядок действий, не готовый код. Правило: упрощать действия
пользователя, не урезать функции. Переключатели «Excel/Word» и «Во
Flux/В обычном Office» в макете только для просмотра и не делаются.

### Назначение

Собрать таблицу из данных проекта в обычной шапке Word/Excel: выбрать
источник и позиции, нажать параметр и ячейку, нажать «Заполнить».

### Где встраивается

Один общий компонент панели и одна лента на обоих путях: Проводник
(`WindowsFileHost` → `LocalOfficeEditor`) и проект (`OfficeHost`,
`OfficeAppEditor`). Сегодня в Проводнике стоит только старая `FluxPanel`, и
новая панель там не видна, — это первый этап. Лента — вкладка «Flux»
(`flux-ribbon-docs`, `flux-ribbon-sheets` в `tools/genoffice/patches.mjs`):
из одной кнопки становится набором групп; кнопки шлют хосту сообщения, как
сейчас `flux:open-panel`; состояние (источник, выбранное поле, активная
ячейка) хранит хост. Старая `FluxPanel` удаляется из Word и Excel, когда её
возможности перенесены и сверены (ниже); PDF, Markdown и заметки остаются
на ней.

### Лента «Flux»

| Группа | Кнопки | Откуда |
|---|---|---|
| Источники данных | Оборудование · Теги · Менеджмент · E3Flux | первые две — `fluxData.ts`; Менеджмент и E3Flux на этапе 1 серые с подписью «Скоро» |
| Перевод | Переводчик | `TextTranslationPanel`, та же правая область |
| Шаблоны | Шаблоны · Закреплённые · Сохранить как · Обновить шаблон | `FluxTemplateControls` — окна по командам ленты (ТЗ §13) |
| Документ | Обновить данные · Выпустить · Исходная шапка · Выгрузить | см. ниже |

Команды ленты не исчезают при переключении режимов и не дублируют родную
ленту Word/Excel. «Назад/вперёд» — только кнопки редактора.

- «Обновить данные» — `preview` → подтверждение → `applyWrites` без
  дублей строк и меток.
- «Выпустить» — `FluxRevisionPanel`; на этапе 1 только для файлов проекта,
  для файлов Проводника — отдельный этап позже.
- «Исходная шапка» — возвращает шапку к виду из шаблона, из которого файл
  создан или к которому привязан, и отбрасывает правки шапки после
  применения шаблона; данные в строках не трогает. Связь файла с шаблоном
  сейчас не хранится: нужно хранить в части Flux файла `templateId` и
  снимок схемы шаблона на момент применения (`appliedAt`) — снимок, а не
  ссылка, потому что шаблон потом изменят или удалят. Пишется при
  открытии шаблона в файл. Нет шаблона — кнопка неактивна с подсказкой
  «У файла нет шаблона».
- «Выгрузить» — XLSX, CSV, «Книга Flux» (перенос из старой панели).

Отдельной строки или панели операторов нет: знаки, числа и текст печатаются
в самой ячейке (ниже). Подсказка состояния («Выбрано поле «…». Теперь
щёлкните ячейку шапки.») — одна строка `fx-hint` в шапке панели, рядом с
подписью активной ячейки.

### Панель «Данные для таблицы»

Вкладки, как в ТЗ §4: «Выборка», «Поля и шапка», «Обновление». Ширина по
умолчанию 580 px, левая граница тянется, предел по окну, значение
хранится локально; на узком окне панель — оверлей. Кнопка «Ширина» из
макета не нужна: ширина меняется перетаскиванием. Шапка панели 44 px:
название, подпись активной ячейки («Ячейка E2») или выбранного поля.
Внизу закреплено: «Выбрано полей в шапке: N», «Предпросмотр» (обычная),
«Вставить все» (обычная), «Заполнить» (единственная главная,
отключена с указанием причины).

- «Выборка»: проект, ревизия источника (новое), флажки типов позиций,
  поиск тега/наименования, фильтры по применимым полям, сортировка 1..N
  уровней, исключения, «В таблицу попадёт N позиций», виртуализованный
  предпросмотр. Основа — `FluxSelectionPanel`.
- «Поля и шапка»: поиск, сворачиваемые группы (`fx-gh`), строка поля с типом
  (`Badge`) и «+»; поле выбирается нажатием, затем щелчок по ячейке вставляет
  метку без диалога. Основа — `FluxFieldsPanel`, `insertBinding`. Блока
  «Объединить параметры разных типов» с отдельной кнопкой нет: объединение
  делается в самой шапке (ниже).
- «Обновление»: сравнение источника, конфликты, план, ревизии. Основа —
  `UpdatePanel`, `FluxRevisionPanel`.

### Ввод в ячейке шапки (ТЗ §6–7)

Ячейка — упорядоченные части: защищённые метки полей и редактируемый текст
(`OfficePart`). Всё печатается прямо в ячейке, окна «Редактировать формулу в
ячейке» нет:

- текст до, после и между метками («Итого: », « кВт», « / ») — обычный
  набор; метка не исчезает при вводе, вставке, Undo/Redo, смене фокуса и
  сохранении; Backspace у метки сначала выделяет её, второй раз удаляет
  (как у чипа); удаление метки также через контекстное меню;
- арифметика (`+ − * / ( )`, числа) считается только в ячейке, которая
  начинается с «=», как в Excel; без него «Т/А» и «№-1» остаются текстом
  (решение владельца 3). Расчёт — `evaluateOfficeParts` (без `eval`, единицы,
  деление на ноль, округление);
- параметр в ячейке всегда плашка: скруглённая светло-зелёная рамка с
  названием, один стиль для Word и Excel (`parameter-chip-style.ts`, ступени
  emerald из токенов, тёмная тема тоже). Excel в покое показывает плашки
  слоем DOM поверх холста (`sheets-idle-chips.ts`), при правке — защищёнными
  токенами окна ввода; новая метка встаёт в позицию курсора;
- ошибка расчёта показывается значком у ячейки с подсказкой и в сводке
  предпросмотра; значение не подменяется нулём;
- «×», «÷», «−» принимаются как `*`, `/`, `-` (уже в `normalizeOfficeFormulaParts`);
  требуется распознавать их без ведущего «=» — единственное изменение
  разбора; существующее поведение с «=» остаётся совместимым.

Для Excel это перехват начала правки привязанной ячейки
(`BeforeSheetEditStart`): окно ввода открывается поверх неё, без диалога; для
Word чип уже есть, требуется проверить сценарии ТЗ §6 (вставка из буфера,
Undo) и IME.

### Объединение (ТЗ §8)

Два шага вместо трёх: выделить две соседние ячейки шапки → правая кнопка →
«Объединить». Результат сразу: один столбец, значения ложатся в него по
типу позиции, в ячейке одна метка, в которой параметры показаны через
«ИЛИ» (как в макете), с подписью по типу. Имя выходного заголовка берётся
из первой ячейки и правится в самой ячейке. Диалога нет, пока нет
конфликта.

- Диалог открывается только если ручное значение в соседней ячейке
  пропадёт, у двух параметров совпадают типы (нужно выбрать приоритет),
  или несовместимы единицы; в нём одно решение и «Объединить».
- Предпросмотр (`previewOnly` + токен) остаётся, но работает внутри: кнопка
  «Объединить» сама делает проверку, а затем подтверждение; пользователь
  видит один шаг. Отмена — Undo редактора.
- Отображение «по типам» — внутри ячейки: наведение на метку показывает,
  какой параметр для какого типа; приоритет меняется в меню метки.
- Сделано (ветка office-merge-rename): правый щелчок по двум ячейкам даёт малое
  меню с пунктом «Объединить», окна с именем и «Проверить» / «Подтвердить» нет.
  Имя колонки по умолчанию «<имя1> / <имя2>». Если у части позиций заполнены оба
  параметра, рядом с ячейкой встаёт плашка «У N позиций заполнены оба параметра»
  с «Брать <параметр>» и «Выбрать по каждой»; выбор хранится в объединении
  (`alternatives[].priority`, `picks` — исключения по позициям, `resolved`) и
  меняется правым щелчком по метке → «Приоритет объединения». Конфликт разных
  ручных значений — окно «Объединение не выполнено» без записи.
- Своё имя параметра: правый щелчок по метке → «Переименовать» / «Сбросить имя».
  Хранится в `binding.label` (у объединения — `label` части), показано на метке и
  в тексте шапки, программное имя «название · источник» — в окне и подсказке;
  данные берутся по `fieldKey`.
- Различать с форматным Merge cells: пункт меню «Объединить» работает с
  метками, а штатное слияние ячеек остаётся командой родной ленты.
- «Очистить метки выбранной ячейки» — второй пункт того же меню.

### Сопоставление макета с кодом

| Элемент макета | Механизм | Статус |
|---|---|---|
| Источники Оборудование, Теги | `fluxData.ts` | есть |
| Менеджмент, E3Flux | — | этап 3, на этапе 1 серые «Скоро» |
| Переводчик | `TextTranslationPanel` | есть; команда на ленте — новое |
| Шаблоны, Закреплённые, Сохранить, Обновить | `FluxTemplateControls`, `officeDataApi.*Template` | есть; вынос на ленту — новое |
| Исходная шапка | `updateSchema` + снимок шаблона | новое (хранение связи) |
| Обновить данные, Выпустить | `preview`/`applyWrites`, `FluxRevisionPanel` | есть; кнопки на ленте — новое |
| Тип позиций, поиск, сортировка, итог | `FluxSelectionPanel` | есть; ревизия источника — новое |
| Поля, «+», подсказка | `FluxFieldsPanel`, `insertBinding` | есть; группы — новое |
| Ввод между метками, арифметика в ячейке | `officeHeaderEditor`, `officeFormula` | Word частично, Excel — новое |
| Объединить в один столбец (меню правой кнопки) | `merge` в `useFluxCellActions` | одним действием из меню; плашка выбора и переименование — сделаны |
| Предпросмотр, Заполнить | `preview`, `confirm`, `applyWrites` | есть |
| Вставить все, Выгрузить | `FluxPanel.insert`, `exportRows` | перенос |
| Переключатели Excel/Word, Flux/Office | — | не делаем |

### Возможности старой панели, которые переносятся

Все три работают над выбранными строками, иначе над всеми
отфильтрованными, по активным столбцам.

| Возможность | Что делает в `FluxPanel.tsx` | Новое место |
|---|---|---|
| «Вставить все» / «Вставить выбранные (N)» | `insert`: таблица «заголовки + строки», не более 500 строк, в редактор через `onInsertTable` (Word — таблица, Excel — диапазон); сообщает «вставлены первые 500» | низ панели рядом с «Заполнить» |
| XLSX, CSV | `exportRows`: `toXlsx` / `toCsv`, скачивание файла `exportFileName` | кнопка «Выгрузить» в группе «Документ» |
| «Книга Flux» | та же выгрузка в XLSX, затем `saveNewFile(bytes, name, 'exports')` и переход в новый файл | пункт «Выгрузить» |

Строки берутся из выборки (`officeDataApi.query`) и полей панели, а не из
отдельного списка старой панели.

### Файлы Проводника: что требуется от сервера

Байты файла Проводника хранятся локально и не являются `FileNode` на
сервере. `state`, `preview`, `confirm`, `updateState` сегодня адресуются по
`fileId`. Для локальных файлов нужны варианты по присланному содержимому:

- состояние по содержимому: клиент присылает байты или прочитанные из
  редактора схему и хеш; сервер возвращает `OfficeState` без `FileNode`;
- `preview` и `confirm` принимают то же содержимое вместо `fileId`; план
  привязан к `baseHash` присланных байт;
- результат записывается в сам файл: редактор применяет `writes` через
  `applyWrites` и `write` файлового моста; сервер файл не меняет и не
  хранит; содержимое в облако не уходит (ТЗ §17);
- связи лежат в самом файле (DOCX — `customXml/itemFluxOffice.xml`; для
  XLSX формат хранения надо добавить, ТЗ §12);
- шаблоны и закрепление остаются серверными, общими для пользователя;
  «Выпустить» для таких файлов — позже, нужны снимки на сервере.

Контракт прежний: план → подтверждение → запись, проверка `baseHash`.

Сделано (этап 1, часть А):

- сервер — `server/routes/projectOfficeLocal.ts`: `POST /api/project-data/office-local/`
  `state`, `write-state`, `preview`, `confirm`; тело — `projectId` и `base64`
  содержимого (до 30 МБ), остальное как у файла проекта. Права — по выбранному
  проекту (`requireProjectRead`), проект «по умолчанию» не подставляется.
  `write-state` возвращает новые байты и их `baseHash`, файл не пишет; байты
  в базе и на диске сервера не остаются. Ядро (`planOfficeContent`,
  `officeStateOfContent`, `rebindOfficeContent`) общее с маршрутами файла
  проекта;
- клиент — `OfficeFileSource` в `fluxData.ts` (строка `fileId` или
  `OfficeLocalSource`), `useOfficeFluxBridge` (порядок «записать правки →
  прочитать состояние → записать схему», общий для `OfficeHost`,
  `OfficeAppEditor` и `LocalOfficeEditor`), `useLocalFluxBridge` (байты —
  через `write()` файлового моста, без переоткрытия);
- часть Flux не должна пропадать при сохранении из редактора: он открыл пакет
  до записи схемы. Её переносит `carryFluxPart` (`office/fluxPart.ts`) — в
  `LocalOfficeEditor` для Word и в сеансе локальной книги
  (`electron/localOfficeSessions.ts`) для Таблицы; запись хоста сеанс принимает
  командой `rebase` (хеш должен совпасть с файлом), иначе следующее сохранение
  книги было бы CONFLICT;
- «Выпустить» для файлов Проводника скрыто (решение владельца);
- проверки: `scripts/test-office-local.ts` (маршруты), `test-local-office-sessions.ts`
  (`rebase`, перенос части), живой `node --import tsx scripts/test-guide-server.ts
  --office-explorer` — настоящие Word и Таблица в окне `/windows-file`, настоящие
  сервис файлов и сеанс книги за заглушкой моста, сверка байтов файла на диске.

Сделано (этап 1, часть Б):

- лента — вкладка «Flux» (`tools/genoffice/inject/flux-ribbon.tsx`, правки
  `flux-ribbon-docs*`/`flux-ribbon-sheets*` в `patches.mjs`): группы
  «Переводчик», «Данные» (Оборудование, Теги; Менеджмент и E3Flux серые с
  «Скоро»), «Шаблоны» (Шаблоны, Закреплённые, Сохранить как, Обновить шаблон),
  «Документ» (Обновить данные, Выпустить, Исходная шапка, Выгрузить). Кнопка —
  одно сообщение `flux:open-panel` с полем `command`; хост разбирает его в
  `useFluxRibbon`, панель получает команду пропом `command`. Хост шлёт ленте
  событие `fluxRibbonState` (есть ли у файла шаблон, доступен ли выпуск);
  «Выпустить» для файла Проводника неактивна с подсказкой;
- шаблоны вынесены из панели: `FluxTemplateControls` — окна «Шаблоны»,
  «Закреплённые», «Сохранить как»; записи — `useOfficeTemplates`. Права по
  решению владельца: общий шаблон создаёт любой сотрудник, правит и удаляет
  только создатель (администратор тоже; `canManageOfficeTemplate`);
- «Исходная шапка»: часть Flux файла хранит `template` — `templateId`, имя,
  `appliedAt` и снимок схемы (`OfficePackageBindings.template`), один,
  последний. Пишется, когда сопоставленный шаблон сохранён в файл
  (`updateSchema` с `template`); возврат — та же запись схемы со снимком и
  `removedAnchorIds` для ячеек, которых в шаблоне нет, без переоткрытия;
- перенос из старой панели — `fluxTable.ts` (таблица, лимит 500, имя файла,
  CSV и XLSX) и `FluxExportDialog` (XLSX, CSV, «Книга Flux», столбцы);
  «Вставить все» — внизу вкладки «Выборка». Сверка со старой панелью на тех же
  данных — `scripts/test-office-flux-compare-ui.ts`;
- `FluxPanel` удалена из Word и Таблицы (`OfficeHost`, `OfficeAppEditor`,
  `LocalOfficeEditor`), ссылка «Источники и перевод» убрана; на ней остаются
  PDF, Markdown и заметки. Переводчик — команда ленты (`TextTranslationPanel`,
  без полного английского варианта файла: он остаётся в Проводнике). Не
  перенесены «Поля проекта» (метки `{{ключ}}` и «Обновить поля») — их заменили
  привязки в шапке;
- ширина панели зависит от окна редактора, а не экрана: в окне уже 640 px
  панель ложится поверх редактора.

### Этапы

Порядок по ТЗ §20 с одним изменением: сначала то, без чего Flux не виден.

1. Панель и лента в редакторе Проводника (`LocalOfficeEditor`), серверные
   `state`/`preview`/`confirm` по содержимому, Оборудование и Теги; перенос
   «Вставить все», XLSX/CSV, «Книга Flux», сверка с результатом старой
   панели, удаление `FluxPanel` из Word и Excel; единая лента с группами,
   шаблоны на ленте.
2. Ввод в ячейке: метки и текст между ними, арифметика без окна формулы
   (Excel и Word) — ТЗ §6–7.
3. Объединение в два действия, «Исходная шапка» и хранение связи файла с
   шаблоном — ТЗ §8, §13.
4. Источники: выбор ревизии источника, Менеджмент и E3Flux (когда появятся
   данные) — ТЗ §9–10.
5. Привязки в файлах: XLSX и проверка round-trip во внешнем Office,
   восстановление из карты — ТЗ §12.
6. Права шаблонов, поиск и сортировка, закрепление для всех — ТЗ §13.
7. Ревизии для файлов Проводника, сравнение с выбором изменений — ТЗ §14.
8. Переводчик: режимы размещения, разделитель, порядок, устаревшие
   переводы, защита меток — ТЗ §15–16.
9. Регрессия, Windows portable, снимки — ТЗ §19.

### Проверочный список раздела 8 к экрану

- Компоненты словаря: `fx-btn` (одна `fx-btn-primary` — «Заполнить»),
  `fx-btn-quiet` на ленте, `fx-input`, `fx-li`, `fx-gh`, `fx-hint`,
  `Badge`, `IconBtn`, `Empty`, `ContextMenu`, `Popover` для «Закреплённые»;
  панель переводится с Tailwind-классов на `fx-*`.
- Шапка панели 44 px, строки списков 28–32 px, текст не мельче 12 px,
  веса 400/500/600, заглавных нет, зелёного акцента ≤ 3 % площади.
- Зонд `scripts/test-design-live.ts` на панели в обоих путях; снимки в
  светлой и тёмной теме, 1440 и 1024 px; на узком окне оверлей.
- Состояния: нет источника, пустая выборка, загрузка, ошибка, только
  чтение, источник недоступен, «Скоро» у Менеджмента и E3Flux.
- Сценарии ТЗ §19 для Word и Excel, файлов проекта и Проводника; результат
  читается обратно из документа; запись через план и подтверждение.
- Набор в ячейке: текст до/после/между метками, вставка из буфера, Undo,
  IME; `+ - * / ( )` без «=»; деление на ноль и несовместимые единицы дают
  ошибку, а не ноль.
- Объединение: два действия без диалога; диалог только при конфликте;
  значения не суммируются; соседние данные не теряются; штатное Merge
  cells не затронуто.
- «Исходная шапка»: неактивна без шаблона; возвращает шапку из снимка
  шаблона и отбрасывает позднейшие правки.
- «Вставить все», XLSX/CSV, «Книга Flux»: результат сверен с тем, что даёт
  старая панель на тех же данных (заголовки, порядок и число строк,
  значения, лимит 500, имя файла); до сверки старая панель не удаляется.
- Клавиатура: поле и «+» достижимы Tab, Enter выбирает, Esc снимает выбор;
  фокус возвращается в документ.

### Решения владельца (12 октября 2026)

1. Общие шаблоны создаёт любой сотрудник. Править и удалять общий шаблон
   может только его создатель, остальные используют его или копируют себе.
   Права проверяет сервер.
2. Backspace у метки: первое нажатие выделяет метку, второе удаляет.
3. Арифметика в шапке считается только тогда, когда ячейка начинается со
   знака `=`, как в Excel. Без `=` знаки `-`, `/` и прочие — обычный текст
   («Т/А», «№-1»).
4. Объединение («Мощность» из «мощности двигателя» и «мощности привода»):
   у каждой позиции берётся тот параметр, который у неё заполнен. Если у
   позиции заполнены оба, объединение не останавливается, а рядом с ячейкой
   появляется короткая плашка «У N позиций заполнены оба параметра» с
   кнопками «Брать <параметр 1>», «Брать <параметр 2>» и «Выбрать по каждой».
   Выбор по каждой открывает список этих позиций с переключателем у каждой.
   Выбор хранится в объединении (порядок и исключения по позициям) и
   меняется позже правым щелчком по метке, пункт «Приоритет объединения».
5. Снимок шаблона в файле хранится один, последний применённый.
