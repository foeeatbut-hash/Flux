# Task 04 progress

Task: Codex 04 — explorer icons, project folder bindings, unified file picker.
Branch: `codex/04-explorer-projects`
Base: `b8af56988eeef1a1598f146c211bafd4ba1ecd64` (PR 108 head); target branch currently `e889fd586bc27156ae309c6eef5c57d7b9c5ffd1`, so PR 108 remains an explicit dependency.

## Steps
- [x] Re-read task instructions, project methodology, style, data-safety, architecture, and verification rules after the scratch reset.
- [x] Re-map Explorer and record the checkpoint state.
- [ ] Implement durable project-folder binding, migration/undo, and UI.
- [ ] Unify file selection with system-picker setting and compatibility coverage.
- [ ] Add owner-reviewable SVG icon variants and verified light/dark screenshots.
- [ ] Update program docs, run final checks, commit, publish branch, open dependent draft PR.

## Baseline / notes
- Scratch reset recreated the branch at `e99244d9b62c5ef27071a67c16a55a8e524057f1`; this commit contains only prior progress notes, not implementation. The work below is a new reconstruction.
- Fetched target branch; it has not incorporated PR 108.
- Baseline `node --import tsx scripts/test-explorer-shell.ts`: 113/113 passed. `tsx` CLI itself is blocked by `/tmp/tsx-0/*.pipe` EPERM; `node --import tsx` works. Avoid changing unrelated baseline failure in `scripts/fixtures/office-flux-panel-ui/README.md`.
- Owner-approved design constraints from task handoff: binding ledger in existing durable app settings, actor/device/root scope, canonical IDs + relative path + capability reference (no absolute OS paths); ACL/auth on all reads/writes; compare-and-swap, idempotent preview/apply/undo; preserve manual file project metadata; boundary-only unbind; no file moves or ACL changes. Unified picker should preserve existing API semantics, especially multipart, multi-file, folders, and capabilities.
- Rebuilt and tested `src/lib/projectFolderBindings.ts`: 9/9 focused checks pass; TypeScript passes. This is only the initial pure resolver/validation checkpoint; server persistence and UI remain unimplemented.
- Added authenticated AppSetting-backed binding ledger API scoped by session actor plus hashed device/root key, with project ACL filtering, hidden-history preservation, revision CAS, and bounded atomic undo snapshots. `scripts/test-project-folder-bindings-api.ts` passes 7/7, including revoked membership, stale revision, CAS conflict, explicit unbind/undo, and actor isolation. The preview/confirm UI and file metadata integration are still pending.
