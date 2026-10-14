# Task 04 progress

Task: Codex 04 — explorer icons, project folder bindings, unified file picker.
Branch: `codex/04-explorer-projects`
Base: `b8af56988eeef1a1598f146c211bafd4ba1ecd64` (PR 108 head); target branch currently `e889fd586bc27156ae309c6eef5c57d7b9c5ffd1`, so PR 108 remains an explicit dependency.

## Steps
- [x] Re-read task instructions, project methodology, style, data-safety, architecture, and verification rules after the scratch reset.
- [x] Re-map Explorer and record the checkpoint state.
- [ ] Finish project-folder binding, legacy archive pairing/migration, canonical rename reconciliation, and UI tests.
- [x] Unify ordinary module file selection with the system-picker setting and capability-based large imports; specialized save/export and database setup dialogs remain platform dialogs.
- [x] Add owner-reviewable SVG icon variants and light/dark screenshots (owner approval pending; no product rollout).
- [ ] Update program docs, run final checks, commit, publish branch, open dependent draft PR.

## Baseline / notes
- Scratch reset recreated the branch at `e99244d9b62c5ef27071a67c16a55a8e524057f1`; this commit contains only prior progress notes, not implementation. The work below is a new reconstruction.
- Fetched target branch; it has not incorporated PR 108.
- Baseline `node --import tsx scripts/test-explorer-shell.ts`: 113/113 passed. `tsx` CLI itself is blocked by `/tmp/tsx-0/*.pipe` EPERM; `node --import tsx` works. Avoid changing unrelated baseline failure in `scripts/fixtures/office-flux-panel-ui/README.md`.
- Owner-approved design constraints from task handoff: binding ledger in existing durable app settings, actor/device/root scope, canonical IDs + relative path + capability reference (no absolute OS paths); ACL/auth on all reads/writes; compare-and-swap, idempotent preview/apply/undo; preserve manual file project metadata; boundary-only unbind; no file moves or ACL changes. Unified picker should preserve existing API semantics, especially multipart, multi-file, folders, and capabilities.
- Rebuilt and tested `src/lib/projectFolderBindings.ts`: 9/9 focused checks pass; TypeScript passes. This is only the initial pure resolver/validation checkpoint; server persistence and UI remain unimplemented.
- Added authenticated AppSetting-backed binding ledger API scoped by session actor plus hashed device/root key, with project ACL filtering, hidden-history preservation, revision CAS, and bounded atomic undo snapshots. `scripts/test-project-folder-bindings-api.ts` passes 7/7, including revoked membership, stale revision, CAS conflict, explicit unbind/undo, and actor isolation. The preview/confirm UI and file metadata integration are still pending.
- Added actual SQLite route checks in `scripts/test-project-folder-bindings-sqlite.ts` (12 checks), including concurrent first-write CAS, replay, ACL revocation, opaque hidden history preservation, and forged-undo rejection.
- Added renderer capability tickets for native file imports: per-window ownership, 128-ticket bound, 1 MiB ranged reads, 5-minute sliding idle expiry, source identity validation, and explicit release. A 70 MiB test streams through the existing upload API without constructing a `File`; MIME compatibility covers PNG/JPEG/PDF/CSV. The generic Flux picker keeps legacy `File` consumers compatible and removes the prior 64 MiB cap.
- Converted ordinary file inputs in Signature Editor, builder, E3 catalog/project/solutions, feedback, mail signatures, dictionary, VDR, Chat, Translator, and both Explorer upload flows. Specialized equipment XML selection now routes through the shared chooser and existing XML stable-read/parser/revision helpers.
- Added a current-folder project-binding dialog in native Explorer. Before saving it stats the folder and verifies directory kind/path; active bindings are revalidated by canonical identity before they supply inherited project labels. Inheritance fills only files with no manual project IDs. Legacy FileNode archive pairing/navigation and canonical rename/move reconciliation are still outstanding.
- Owner-review assets now live in `docs/codex/task-04-icons/`; no product icon rollout has been made.
