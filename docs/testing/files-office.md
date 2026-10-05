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

Additional scoped regressions added during remaining-action review:

- `scripts/test-remaining-files-notes.ts` passed 17 checks using temporary
  SQLite and synthetic users/notes. It independently reads persisted title,
  Markdown, color, group, share permissions, revocation, legacy claim, and
  deletion state. This is API/domain evidence, not the Notes UI.
- `scripts/test-remaining-files-explorer-api.ts` passed cross-server checks on
  the explicitly marked disposable MariaDB fixture: a unique project and
  folder, exact synthetic file bytes, rename, soft delete, trash listing, and
  restore. It emitted `NOT_RUN` for purge because the project trash view also
  contained 11 pre-existing shared/root records; the test deliberately did not
  send the bulk purge request.
- `scripts/test-remaining-files-explorer-purge.ts` passed six route checks on
  temporary SQLite, including project-specific trash listing, restore, purge,
  and independent verification that another project's deleted file remains.
  This establishes the route behavior with isolated data; the real UI
  confirmation and browser path remain manual `NOT_RUN`.
- `scripts/test-notes-live.ts` passed all 22 assertions on the synthetic live
  fixture after routing text entry through the focused Markdown iframe editor.
  This covers note autosave, legacy HTML migration, genuine DOCX export, `.md`
  file persistence with unchanged original content and version rollback,
  sticker save, and no external network requests. An earlier run saved only
  `Вто` before the existing paragraph. The test had clicked at the editor
  center and sent keyboard events through the outer page; the focused-editor
  actions now move the caret to the end and type inside the iframe. The
  full-content and reopen checks passed without a production save change.
- `scripts/test-remaining-files-notes-markdown.ts` passed three live checks:
  an iframe-targeted keyboard append saved the full document after the original
  paragraph, the save retained a recoverable prior version, and reopening the
  file restored both the original and appended text.
- `scripts/test-html-to-markdown.ts` covers the opt-in Notes image policy:
  bounded inline PNG/JPEG/GIF/WebP data remains inline, while remote, relative,
  `cid:`, `file:`, `javascript:`, SVG, and oversized image sources become inert
  text placeholders. Generic conversion retains its default image behavior.
  The policy is applied at mail-to-note conversion and when legacy HTML Notes
  or Stickers are normalized for the Markdown editor.
- `scripts/test-remaining-files-mail-note-images.ts` creates a note through the
  real mail-to-note API using the disposable seeded message, independently
  reads the exact returned note ID, opens that note in the real Markdown
  iframe, checks for page/CSP/`md-asset` errors and requests to unsupported
  image URLs, then deletes only that run-created note. It passed both API and
  browser checks on the disposable fixture. An initial attempt hit the
  pre-restart server and read the old `![](x)` output; the result recorded here
  is the successful run after both fixture servers loaded the source change.
- `scripts/test-explorer-open-live.ts` passed all four checks on the isolated
  loopback fixture: double-click opens one Office window, no empty-editor
  window appears, the Office file URL is selected, and an Explorer deep link
  selects the document for preview. A diagnostic rerun captured both views;
  its only browser error was the fixture server's Vite HMR WebSocket handshake,
  with no application or React exception. This does not establish native
  Windows window behavior.
- `scripts/test-remaining-files-notes-ui.ts` mounts the real
  `NotesManagement` screen against mocked API responses. It checks pinning
  a grouped note above the list, visibility while its source group is
  collapsed, return to the group on unpin, plus search, scope, sort, group,
  color, and duplicate behavior. The serialized Chromium run passed all 12
  checks without uncaught browser errors.
- The Notes pin regression exposed a real ordering defect: data was sorted
  with pinned IDs first, then grouped rendering put grouped notes back inside
  their group. The approved fix renders pinned notes first and excludes them
  from the following group rendering, so each note is rendered once. The
  synthetic regression passed against the fixed component.

## Explicitly not run here

Manifest manual scenarios without a recorded run artifact remain `NOT_RUN`. In particular, no
installed Windows/portable execution, native folder picker, Explorer shell
reveal, Windows recycle bin, native drag/drop, or real local-file edit was
observed. The browser checks in this scope used only isolated loopback fixtures
on ports 4300 and 5197; no `:3000` server was used. No company database,
company files, real credentials, or vault were used.

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
controls, and archive operations. Two older Notes aggregate rows
(`notes-organize-share-export` and `notes.search-scope-sort`) were removed when
their behaviors were represented by individual pin/group/color/duplicate/
export/print and search/scope/sort action IDs. No unique trigger or expected
outcome was removed; these aggregate rows duplicated the specific contracts.
Some editor tools remain inventoried as
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
identity. The mail-to-Notes edge is separately inventoried and its live API
readback is pending a source-server restart.

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
