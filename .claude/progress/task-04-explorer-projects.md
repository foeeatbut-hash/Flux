# Task 04 progress

Branch: `codex/04-explorer-projects`; dependent on PRs #108 and #110; target `claude/custom-table-builder-design-38h1b8`.

## Scope and completion

- [x] Persist user/device/root scoped folder-to-project bindings with canonical folder checks, ACL filtering, CAS, server snapshots, manual metadata and child-boundary precedence, and undo.
- [x] Add binding actions to folder context menu and command bar. Dialog confirms bind/unbind and discards stale actor-scope responses.
- [x] Route old FileNode documents through “Архив Flux” in the Explorer navigation and remove the separate “Документы проекта” home shortcut.
- [x] User clarified on 2026-10-14 that old-folder migration/pairing is not required; no archive data is transformed.
- [x] Unify non-Office file selection, preserve input MIME and modification time, provide alias-path independent selection, enforce accept filters, support ranged tickets and the system-picker setting.
- [x] Add review-only icon variants and light/dark screens; no product rollout pending owner approval.
- [x] Merge latest PR #110 commit `a1c34157`.
- [ ] Run final focused tests, update/publish checkpoint, refresh CI status, and remove this progress note after final PR update.

## Validation so far

- Resolver 9/9; API mocks 8/8; SQLite route checks 12/12.
- Import tickets 6/6, including >64 MiB reads, sliding expiry, identity, and mtime; streaming upload 2/2; MIME 7/7.
- Import chooser UI verifies MIME filtering, alias paths sharing one file ID, MIME/mtime/File bytes, capability preservation, and picker cancel without route change.
- Windows Explorer Playwright 136/136; includes archive navigation, binding context action, and scroll preservation for a manually project-linked row. Task03 baseline passed 133/133. Current trace showed scroll moved when refresh replaced decorated focused-entry identity; stable focus key fixes it.
- `npm run check:coverage` passed. `scripts/test-architecture.ts` has one existing hit at forbidden, unchanged `src/components/office/FluxMergeParts.tsx:48`; no Office file is changed.
- Windows CI has not yet run on the latest task04 head; Playwright uses a deterministic bridge fixture, not Windows shell.
