# Files and Office verification inventory

Inventory date: 2026-10-04. Scope: `explorer`, `windows-files`, `shared-files`,
`windows-file`, `document` (`/doc`, `/office-doc`), `spreadsheet` (`/sheet`,
`/office-sheet`), `pdf`, `notes`, `sticker`, and `archives`.

This is an implementation inventory and evidence map, not a result report or a
claim of complete action coverage. The sources were traced from
`src/workspace/sections.tsx` through the route entry points, visible React
handlers, file type and native bridge helpers, archive and notes screens,
GenOffice injections, and related server endpoints. The manifest lists the
major supported actions found in that pass. A follow-up pass still needs to
compare every control/menu/shortcut and conditional native action against the
live UI on each supported role and platform.

## Automated evidence

The manifest declares only the narrow claims supported by each suite:

- Pure/domain checks cover file type and route mapping, drag/drop planning,
  DOCX package generation, archive listing parsing, recent-file helper logic,
  Windows file reference encoding and byte transfer, local file access/failed
  close behavior, and shared-file sync behavior with a controlled bridge mock.
- `scripts/test-file-sharing.ts` creates temporary SQLite databases and
  exercises file sharing routes/access with synthetic users and contents. It
  is useful API/domain evidence; it does not prove the browser UI or Windows
  desktop behavior.
- Existing browser-live suites exercise selected file opening and the DOCX,
  XLSX, PDF, notes, and archive save paths. They use generated synthetic
  documents, but require an explicitly isolated test server, test credentials,
  browser, and built editor assets. These suites were not run for this
  inventory task.
- Browser-live evidence is only for actions named in the suite claims. It does
  not establish every toolbar item, every keyboard binding, every archive
  format, every permission combination, nor complete visual/usable behavior.

The new `scripts/test-verification-files-office.ts` independently checks a
synthetic Windows file reference containing Cyrillic, spaces, reserved URL
characters, and a draft identity, plus exact round-trip of synthetic binary
bytes including NUL and high-bit values. It does not call Windows or write a
real file. In this workspace the following safe tests passed: that new helper
test; `test-file-types`, `test-drop-files`, `test-docx`, `test-archives`,
`test-recent-docs`, `test-local-file-access`, `test-file-sharing-sync`, and
`test-file-sharing`. The sharing route test used only its temporary SQLite
fixture and generated users/files. These results cover only the helper/domain
claims above.

## Explicitly not run here

All manifest `manual` scenarios have status `NOT_RUN`. In particular, no
installed Windows/portable execution, native folder picker, Explorer shell
reveal, Windows recycle bin, native drag/drop, or real local-file edit was
observed. No company database, company files, real credentials, or vault were
used. The broad/server `:3000` and browser-live suites were not run as they are
coordinated by the parent task.

The following result paths therefore remain unverified in this pass:

- Full save/read/reopen behavior for real DOCX/XLSX/XLSM/PDF files in Windows
  portable Flux, including formatting fidelity, formula recalculation and
  malformed/large files.
- Conflict/recovery behavior with two independently hosted servers and two
  employees, revoked access while an editor is open, offline save recovery,
  and complete role/project permission boundaries.
- Actual two-user shared-file behavior from both browser screens, including
  version history, recipient lists, revocation, and unchanged owner source.
- Complete Windows filesystem behavior: custom root selection, unavailable
  roots, copy/move semantics, collisions, symlinks/reparse points, properties,
  file watcher refresh, bridge loss, and access outside/inside a chosen root.
- Every Explorer context menu and bulk operation, keyboard shortcut,
  clipboard/paste case, drag/drop edge, sort/filter combination, preview, and
  destructive-operation confirmation/recovery.
- The full toolbar/menu/shortcut inventory for Document, Spreadsheet and PDF;
  Office-specific paste, translation and project-data panel outputs; DOCX/XLSX
  byte/part preservation for all supported constructs; and PDF annotation
  rendering in independent readers.
- Notes list filters/groups/permissions/export/print, duplicate and delete
  behavior, sticker polling races, and persistence under close/reopen or a
  failed save.
- Archive ZIP/7z creation and edit-copy output on Windows, encrypted archive
  failure paths, compression choices, path traversal defense, cancellation,
  duplicate output names, and independent byte comparison after extraction.
- Visual quality, accessibility, focus order, both themes, narrow windows,
  high DPI, performance, and native menu states.

The current action rows split the prominent commands for opening, saving,
save-as, undo, redo, close, file operations, sharing/revocation, note/sticker
controls, and archive operations. Some editor tools remain inventoried as
families where the editor UI is generated at build time (for example the
individual text formatting, link, image, and table-toolbar commands). The
Explorer row still groups some selection/navigation variants, and the
Windows picker/native file operations still need a live platform census.
`/sticker` is a special route handled directly in `src/App.tsx`, not a normal
entry in `SECTIONS`; it is included as its own program because it has a
separate window lifecycle and controls.

## Cross-program edges

The manifest records the implemented or conditional file edges to `registry`,
`equipment`, `catalog`, `builder`, `mail`, `chat`, `users`, `settings`,
`owner`, and `shell`. These are source-derived edges, not verified journeys.
The manually pending checks call out the file/tag assignment, selected-file
equipment import, catalog/builder spreadsheet handoff, mail attachment save,
conditional chat file entry, user access/revocation, per-profile Windows roots,
Owner account lifecycle, and native shell bridge. Additional implemented
internal edges cover Explorer-to-editor file identity and Notes-to-Sticker
identity.

## Reconciliation gaps

This manifest is intentionally a scoped first inventory, not proof that the
control census is complete. The next reconciliation should inspect each
rendered menu and native dialog in a test profile, compare every event binding
and global shortcut in the source with an action ID, and update the manifest
when an action or launch path is missing. At present several action rows group
related controls (for example, an editor toolbar family) and therefore do not
provide one scenario per individual command. Those individual commands and
alternate triggers remain uncovered until split into their own contracts and
checked with meaningful expected results.
