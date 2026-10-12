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

## Лента Flux и панель «Данные для таблицы» (проект, этап 1–2)

Раздел описывает новый интерфейс Flux в Word и Excel вместо старой панели
`FluxPanel`. Эскиз владельца приблизительный: порядок и подписи уточняются
при реализации, но состав и смысл ниже обязательны.

### Назначение

Собрать таблицу из данных проекта за три действия: выбрать источник и
позиции, нажать параметр и ячейку шапки, нажать «Заполнить таблицу». Режим
один для Word и Excel; переключатели «Excel/Word» и «Во Flux/В обычном
Office» из эскиза не делаются (в эскизе они только для просмотра).

### Где встраивается

Один общий компонент (`FluxOfficePanel` с лентой-обёрткой) на обоих путях:

| Путь | Хост | Состояние сегодня |
|---|---|---|
| Проводник | `WindowsFileHost` → `LocalOfficeEditor` | только старая `FluxPanel` |
| Проект | `OfficeHost` (Word), `OfficeAppEditor` (Excel) | `FluxOfficePanel` |

Вкладка «Flux» на ленте редактора (патчи `flux-ribbon-docs` /
`flux-ribbon-sheets` в `tools/genoffice/patches.mjs`) из одной кнопки
становится набором групп. Кнопки ленты шлют редактору сообщения, как
сейчас `flux:open-panel`; состояние (источник, выбранное поле, активная
ячейка) хранит хост, а не лента. Старая `FluxPanel` удаляется из Word и
Excel полностью (из Проводника и из проекта); PDF, Markdown и заметки пока
остаются на ней.

### Лента «Flux»

| Группа | Кнопки | Откуда |
|---|---|---|
| Источники данных | Оборудование · Теги · Менеджмент · E3Flux (переключатель, активен один) | Оборудование, Теги — `fluxData.ts` (`sources`); Менеджмент, E3Flux — этап 2, до него кнопки скрыты или серые с пояснением «Скоро» |
| Перевод | Переводчик | `TextTranslationPanel`, без изменений |
| Шаблоны | Шаблоны · Сохранить шапку · Обновить шаблон · Закреплённые | `FluxTemplateControls` (`saveTemplate`, `updateTemplate`, `pinTemplate`); «Закреплённые» — выпадающий список закреплённых |
| Документ | Обновить данные · Выпустить · Исходная шапка | «Обновить данные» — `preview`/`applyWrites` по новому источнику; «Выпустить» — `FluxRevisionPanel`; «Исходная шапка» — новое |

«Исходная шапка». В коде исходной считается схема, записанная в самом
документе (`requestState().schema`); открытый шаблон лежит поверх неё как
несохранённая раскладка (`templateMapping`, `templateTargetSchema`).
Смысл кнопки: сбросить открытый шаблон и несохранённые правки шапки к схеме,
сохранённой в документе. Доступна, пока есть что сбрасывать; до подтверждения
показывает, что изменится. Данные в строках не трогает.

Под лентой — полоса из двух строк:
- операторы «Добавить между полями: + − × ÷ ( )» — кнопки `fx-btn-quiet` 24;
  вставляют оператор в схему шапки активной ячейки (`officeHeaderEditor`,
  операторы в `schema`); неактивны без активной ячейки шапки;
- строка-подсказка состояния (`fx-hint`): «Выбран параметр «…». Теперь
  щёлкните нужную ячейку шапки.» Подсказка меняется по шагу: нет источника,
  нет параметра, параметр выбран, ячейка принята, есть ошибка.

### Панель «Данные для таблицы»

Правая панель по умолчанию шириной 580 px, левый край тянется (как в
разделе «Раскладка»); документ остаётся виден. Шапка панели в одну строку
44 px: название «Данные для таблицы», подпись активной ячейки («Ячейка E2»,
`fx-hint`) и кнопка «Ширина» (быстрый выбор 420 / 580 / 760 — новое;
перетаскивание края остаётся).

Три блока по порядку работы, каждый с заголовком `fx-group-title`:

1. «Какие позиции включить» — флажки типов позиций (Установка, Вентилятор,
   Клапан, Воздушная завеса… — типы берутся из каталога выбранного
   источника), поиск тега/наименования, сортировка, итог «В таблицу попадёт
   N позиций». Основа — `FluxSelectionPanel` (types, filters, sort,
   excludedEntityIds, `officeDataApi.query`); флажки типов и итог — перекомпоновка,
   поиск — debounce как сейчас.
2. «Какой параметр вставить» — группы параметров (сворачиваемые `fx-gh`),
   поиск, список полей `fx-li` с типом справа (`Badge` нейтральный) и
   кнопкой «+» (`IconBtn`). Основа — `FluxFieldsPanel`/`fieldsFromCatalog`.
   Нажатие на поле выбирает его (`selectedField`), нажатие на «+» — вставляет в
   активную ячейку; нажатие на ячейку шапки при выбранном поле — привязка
   (`insertBinding`). Подсказка блока: «Нажмите поле, потом нужную ячейку…».
3. «Объединить параметры разных типов» — свёрнутый по умолчанию блок;
   создаёт объединение в одной ячейке (первый непустой из нескольких
   параметров). Основа — объединение альтернатив из `FluxCellActionsDialog`
   (там сегодня только правый щелчок по двум соседним ячейкам); в панели
   то же действие получает постоянную форму: «Добавить альтернативу в
   ячейку E2».

Низ панели закреплён: «Выбрано полей в шапке: N» (число привязок схемы),
«Предпросмотр» (обычная) и «Заполнить таблицу» (единственная главная
кнопка, `fx-btn-primary`). Заполнение отключено с указанием причины, пока
нет позиций, привязок или принятого состояния документа. «Предпросмотр» —
`officeDataApi.preview`; «Заполнить» — `confirm` + `applyWrites` после
диалога подтверждения с планом (поток «план → подтверждение → запись»
сохраняется, `flux-data-safety`).

Шаги «Выборка / Поля и шапка / Обновление» перестают быть вкладками: первые
два становятся блоками 1–3, «Обновление» — планом после «Предпросмотра» в
той же панели и ревизиями, которые открывает кнопка «Выпустить».

### Сопоставление эскиза с кодом

| Элемент эскиза | Механизм | Статус |
|---|---|---|
| Оборудование, Теги | `fluxData.ts` | есть |
| Менеджмент, E3Flux | — | новое, этап 2 (данных пока нет) |
| Переводчик | `TextTranslationPanel` | есть |
| Шаблоны, Закреплённые, Сохранить шапку, Обновить шаблон | `FluxTemplateControls`, `officeDataApi.*Template` | есть; вынос на ленту — новое |
| Обновить данные | `preview` + `applyWrites` | есть; кнопка на ленте — новое |
| Выпустить | `FluxRevisionPanel` | есть; вынос на ленту — новое |
| Исходная шапка | `requestState` + `updateSchema` | новое |
| Строка операторов | `officeHeaderEditor`, операторы схемы | механизм есть, строка — новое |
| Строка-подсказка | — | новое |
| Подпись ячейки, «Ширина» | `activeAnchor`, `panelWidth` | подпись — есть в состоянии, показ и «Ширина» — новое |
| Блок 1 | `FluxSelectionPanel` | перекомпоновка |
| Блок 2 | `FluxFieldsPanel`, `insertBinding` | перекомпоновка |
| Блок 3 | `FluxCellActionsDialog` | постоянная форма — новое |
| Предпросмотр, Заполнить таблицу | `preview`, `confirm`, `applyWrites` | есть |
| Переключатели Excel/Word, Flux/Office | — | не делаем |

### Файлы Проводника: что требуется от сервера

Байты файла Проводника хранятся локально и не являются `FileNode` на
сервере. Сегодня `state`, `preview`, `confirm`, `updateState` адресуются
по `fileId` и читают файл на сервере. Для локальных файлов нужны варианты,
которые работают по присланному содержимому:

- `office-state` по содержимому: клиент присылает байты (или уже
  прочитанную из редактора схему и хеш), сервер возвращает `OfficeState`
  (`baseHash`, `schema`, `sourceRevision`, строки привязок) без обращения к
  `FileNode`;
- `preview` и `confirm` принимают то же содержимое вместо `fileId`; план
  привязан к `baseHash` присланных байт;
- результат записывается в сам файл: редактор получает `writes` и
  применяет их через `applyWrites` и `write` файлового моста
  (`LocalOfficeEditor`), как сохранение вручную; сервер файл не
  изменяет и не хранит. Состояние шапки лежит в самом документе (якоря и
  пользовательские метаданные), а не в базе;
- шаблоны и закрепление остаются серверными (общие для пользователя);
  ревизии («Выпустить») для локального файла на этапе 1 недоступны:
  `FluxRevisionPanel` требует снимков файла на сервере, кнопка отключена
  с пояснением «Откройте файл из проекта».

Контракт остаётся прежним (план → подтверждение → запись, проверка
`baseHash`): изменение — только в способе передать файл.

### Этапы

1. Лента и панель; локальные файлы Проводника с Оборудованием и Тегами;
   серверные варианты `state`/`preview`/`confirm` по содержимому;
   удаление `FluxPanel` из Word и Excel, оба пути на одном компоненте.
2. Менеджмент и E3Flux: источники, поля, типы позиций в блоке 1;
   ревизии для локальных файлов, если владелец решит (вопрос 3).

### Проверочный список раздела 8 к экрану

- Лента и панель из словаря: `fx-btn` (одна `fx-btn-primary` — «Заполнить
  таблицу»), `fx-btn-quiet` на ленте и в строке операторов, `fx-input`,
  `fx-li`, `fx-gh`, `fx-group-title`, `Badge`, `IconBtn`, `Empty`,
  `ContextMenu`/`Popover` для «Закреплённые»; собственных кнопок нет.
- Заголовок панели 44 px, строки списков 28–32 px, текст не мельче 12 px,
  веса 400/500/600, заглавных нет; типы полей — бейдж, не цветной.
- Готовое: зонд `scripts/test-design-live.ts` на панели в обоих путях,
  снимки в светлой и тёмной теме на 1440 и 1024 px; на узкой ширине
  панель — оверлей на всю высоту.
- Лента не меняет родную раскладку GenOffice: добавляются только группы
  вкладки Flux.
- Состояния: нет источника, пустая выборка, загрузка, ошибка, только
  чтение, источник недоступен (Менеджмент и E3Flux на этапе 1 — серые
  с пояснением).
- Поток: «Выбран параметр → щёлкните ячейку» проверяется для Word и Excel,
  для файла проекта и файла Проводника; результат читается обратно из
  документа (`flux-verify`); запись — через предпросмотр и подтверждение.
- Клавиатура: поле и «+» достижимы Tab, Enter выбирает, Esc снимает выбор
  параметра; фокус возвращается в документ.
- Разделитель окон и ширина сохраняются на пользователя.

### Открытые вопросы владельцу

1. «Исходная шапка» — сбрасывать к схеме, сохранённой в документе (наше
   предложение), или к последнему применённому шаблону?
2. Менеджмент и E3Flux на этапе 1: скрыть кнопки или показать серыми с
   пометкой «Скоро»?
3. Нужны ли ревизии («Выпустить») для файлов Проводника, или достаточно
   файлов из проекта? Для локальных потребуется хранить снимки на сервере.
4. Шаблоны и «Закреплённые» общие для всех файлов пользователя (как
   сейчас) — оставить так для Проводника?
5. Старая панель: убрать из Word и Excel сразу вместе с этапом 1, хотя
   часть возможностей («Вставить все», выгрузка XLSX/CSV, «Книга Flux»)
   в новой панели не воспроизведена?
