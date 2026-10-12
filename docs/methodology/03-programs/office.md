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
