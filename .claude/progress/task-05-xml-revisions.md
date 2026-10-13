# Codex task 05: XML revisions

- Branch: `codex/05-xml-revisions`
- Goal: extend the existing equipment XML source/revision flow with revision discovery, an XML updates dialog, and safe folder rebinding.
- Steps:
  - [x] Confirm repository/task instructions and clean branch.
  - [x] Read equipment methodology, data-safety/style/architecture/verify/PR guidance and map existing XML implementation.
  - [x] Implement natural revision discovery, update review UI, and safe local/server folder rebinding on existing flow.
  - [ ] Add focused server/UI checks and update methodology/task status.
  - [ ] Run required checks, review diff, push branch and open draft PR.
- Baseline checks: `npx tsx scripts/run-checks.ts equipment xml` could not start because tsx IPC socket creation returned `EPERM`; Prisma client setup was missing and is now generated with `scripts/session-start.sh`.
- Current checkpoint: revision parsing, picker suggestion, XML updates dialog, folder-rebind route, source/candidate CAS and initial tests are implemented. The typecheck and focused local XML revision test pass; route test and UI checks remain.
