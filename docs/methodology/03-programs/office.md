# Flux Office

Flux Office opens and edits the original DOCX and XLSX files through the
GenOffice editors embedded in Flux. The Flux ribbon connects project data,
header bindings, translation, templates, and document revisions to those same
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
  anchor, while retaining ordinary text and document formatting.
- The update view compares source and document revisions, shows a fill plan,
  and applies or undoes a confirmed update.
- Templates are managed from the Flux ribbon. They store header structure and
  selection settings, not filled rows or personal data.

## Раскладка

- Keep the document canvas visible while the side panel is open. Its default
  width is 580 px, the left edge is resizable, width is local to the user, and
  narrow windows switch to a full-height overlay.
- The panel header shows the current file and close action. Search and source
  controls belong to «Выборка»; field search and insertion belong to «Поля и
  шапка»; revision comparison and confirmation belong to «Обновление».
- The bottom «Заполнить» action stays in view and is disabled with a specific
  reason until the selection and document anchors are valid.
- Keep template save/open/pin/reload actions in the top Flux ribbon, not in the
  side panel. Translation keeps the existing local engine, memory, glossary,
  and review path.

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
  Shared/personal permissions are enforced by the server.
- An issued revision is immutable. A changed source creates a comparison and
  draft revision; repeated update must not duplicate rows or bindings.

## Приёмка и проверки

- Follow `01-design.md` sections 5 and 8 for component vocabulary and visual
  review. Follow the test levels in the opening table of `04-testing.md`.
- Exercise the real GenOffice bridge for both DOCX and XLSX: create a header,
  type before/after/between bindings, undo/redo, insert fields, preview and fill,
  save/reopen, update a source revision, and undo.
- Verify selection above 1,000 records, stable sort/filter behavior, empty and
  unavailable sources, null/zero values, ambiguous fields, and unit conflicts.
- Verify Word/Excel round-trip in Microsoft Office, template permissions,
  translation placement and stale translations, and preservation of formulas,
  styles, merges, other sheets, and manual rows.
- Measure the panel and canvas at normal and narrow widths, inspect light and
  dark screenshots, and test keyboard focus and disabled/loading/error states.
- Browser fixtures do not establish Windows portable behavior or independent
  Microsoft Office round-trips; record those separately as pending until run.
