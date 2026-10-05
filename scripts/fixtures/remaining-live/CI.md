# Remaining live API CI fixture

`.github/workflows/verify-program-live.yml` runs a selected set of real API and database suites against a fresh MariaDB 10.11 service. The helper verifies that the `flux_remaining_fixture` database is empty before it starts two loopback `server.ts` processes. The orchestrator then seeds the synthetic OWNER, ADMIN, employee accounts, project, mail records, and source-only fixture license before running suites.

The orchestrator accepts only `FLUX_TEST_FIXTURE=1`, an explicit loopback `FLUX_REMAINING_LIVE_DATABASE_URL` naming `flux_remaining_fixture`, and an explicit metadata path at `/tmp/flux-remaining-live-ci/metadata.json`. It creates that path's parent only when the specifically named directory is absent, with mode `0700`. Existing directories are refused and are never removed. On successful cleanup, fixture state, server logs, suite captures, and metadata are removed; on cleanup failure, fixture state is retained privately for safe diagnosis. The workflow uploads no logs or metadata.

## API suite allowlist and order

These are registry suite IDs; missing IDs fail setup rather than silently shrinking the run. The orchestrator expects 14 suites.

1. `collab-chat-privacy`
2. `collab-mail-shared-api`
3. `collab-feedback-privacy-api`
4. `collab-feedback-read-api`
5. `collab-assistant-privacy-api`
6. `files-office-files-live`
7. `eng-remaining-engineering-api-live`
8. `eng-builder-live-regressions`
9. `eng-equipment-composition-live`
10. `eng-equipment-multi-import-live`
11. `eng-equipment-position-add-live`
12. `files-remaining-explorer-api`
13. `shell-play-mariadb-two-api-live`
14. `shell-play-two-clients-api-db`

The suites run sequentially against `http://127.0.0.1:4300` and `:4301`. The collaboration, Office, and engineering suites use the seeded ADMIN credentials. The fixture ADMIN receives `admin.users.create` and `admin.users.manage` so API tests can create and clean up only the synthetic records they own; existing permissions are merged rather than replaced. The Explorer and MariaDB Play oracle read the private fixture metadata; the oracle also uses the source-only owner login and enables Play only for synthetic accounts. The final builtin Play suite then uses the first two synthetic Play employees as separate clients. The workflow does not build Office browser assets or run browser suites.

The position-add suite receives the same explicit loopback MariaDB URL as `FLUX_DB_FIXTURE_URL` and uses it only for guarded `parentElementId` readbacks. It creates and removes its own uniquely named project.

## Result handling

The runner records suite results as `PASS`, `FAIL`, `BLOCKED`, or `SKIP`. Only `PASS` counts as a successful CI check; any other suite status makes the job exit nonzero, while later allowlisted suites still run. Setup or cleanup failures also make the job exit nonzero. Standard output contains totals and failed suite IDs/statuses only. It does not print captured test output, credentials, database URLs, or fixture metadata.

A passing result covers only the claims exercised by that suite at the API/database layer. It does not certify every action or any browser/UI behavior in the application.
