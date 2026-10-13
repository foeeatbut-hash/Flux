# Task 04 progress

Task: Codex 04 — explorer icons, project folder bindings, unified file picker.
Branch: `codex/04-explorer-projects`
Base: `b8af56988eeef1a1598f146c211bafd4ba1ecd64` (PR 108 head); target branch currently `e889fd586bc27156ae309c6eef5c57d7b9c5ffd1`, so PR 108 remains an explicit dependency.

## Steps
- [x] Read task instructions, project methodology, style, data-safety, architecture, and verification rules.
- [x] Map explorer/project/picker implementation and record baseline checks.
- [ ] Implement durable project-folder binding, migration/undo, and tests.
- [ ] Unify file selection with system-picker setting and compatibility coverage.
- [ ] Add owner-reviewable SVG icon variants and verified light/dark screenshots.
- [ ] Update program docs, run final checks, commit, publish branch, open dependent draft PR.

## Baseline / notes
- Working tree clean at start; `HEAD` is the PR 108 head.
- Fetched target branch; it has not incorporated PR 108.
- Baseline `node --import tsx scripts/test-explorer-shell.ts`: 113/113 passed. `tsx` CLI itself is blocked by `/tmp/tsx-0/*.pipe` EPERM; `node --import tsx` works. Avoid changing unrelated baseline failure in `scripts/fixtures/office-flux-panel-ui/README.md`.
- Owner-approved design constraints from task handoff: binding ledger in existing durable app settings, actor/device/root scope, canonical IDs + relative path + capability reference (no absolute OS paths); ACL/auth on all reads/writes; compare-and-swap, idempotent preview/apply/undo; preserve manual file project metadata; boundary-only unbind; no file moves or ACL changes. Unified picker should preserve existing API semantics, especially multipart, multi-file, folders, and capabilities.
