# Remaining live fixture

This helper runs two source `server.ts` processes against one disposable local
MariaDB database. It never reads `database/config.json`. Each process gets its
own temporary `VENT_APP_DATA`, `HOME`, log file and port, while both use the
same explicitly supplied MariaDB fixture URL.

Requirements: the database must already exist, be empty, use a name matching
`flux_<name>_fixture` (or the documented `_fixture_...` extension), and be
reachable only at `localhost`, `127.0.0.1` or `::1`. Before any process starts,
the helper queries the server and requires a MariaDB version string. The URL
must be supplied as `FLUX_REMAINING_LIVE_DATABASE_URL`; it is never printed or
copied to fixture metadata. Use a disposable test account with privileges
needed for the application schema. Startup synchronizes the application schema
and therefore writes to this database.

Run from the repository root:

```sh
FLUX_REMAINING_LIVE_DATABASE_URL='mysql://…/flux_remaining_fixture' \
node --import tsx scripts/fixtures/remaining-live/remaining-live.mjs start --keepalive
FLUX_REMAINING_LIVE_DATABASE_URL='mysql://…/flux_remaining_fixture' \
node --import tsx scripts/fixtures/remaining-live/remaining-live.mjs restart <state-directory> --keepalive
node --import tsx scripts/fixtures/remaining-live/remaining-live.mjs seed <state-directory>
node --import tsx scripts/fixtures/remaining-live/remaining-live.mjs preflight <state-directory>
node --import tsx scripts/fixtures/remaining-live/remaining-live.mjs stop <state-directory>
```

The `start` command prints the private state-directory path, both loopback
origins and the MariaDB version/database name; it never prints the URL or
credentials. It waits for `/api/health` to return ready from each process.
`start` requires an empty database. `restart` is for a prior state directory;
it requires the fixture URL again, validates it against the recorded loopback
MariaDB database and exact running PIDs,
stops only those processes, then starts them with source-only fixture owner and
personal-license flags. It also sets `DISABLE_HMR=true`. Add `--keepalive` in
the managed execution environment: the foreground keeper keeps the launcher's
process sandbox alive for both server children, and `stop` shuts down the exact
recorded servers and keeper. The fixture license flags are accepted by source
`server.ts` only; packaged servers do not trust the fixture key or automatic
test licensing.

`seed` logs in through the source-only owner fixture key, creates one ADMIN,
six employees, one project and project membership for the first four employees,
then logs all seven synthetic accounts in against both servers. The first four
employees are the project group; the last two are outsiders. Synthetic
passwords and IDs are written to `/tmp/flux-remaining-live.json` with mode
`0600` (or `FLUX_REMAINING_LIVE_METADATA` if set). It does not print
credentials or bearer tokens. The fixture ADMIN receives only
`admin.users.create` and `admin.users.manage`; an idempotent seed merges those
two grants into its existing permissions without replacing other rights.

`preflight` verifies health, ADMIN login, the explicit source-only test license,
and a one-byte personal file POST followed by deletion of that exact file on
both servers. It also creates one disposable employee and deletes that exact
user through the other server, then confirms the user is gone. It emits no
credentials or bearer token. `seed` is idempotent
against the private metadata file: it verifies the existing seven accounts on
both servers and refuses to create duplicates.

The state directory is created under the operating system temporary directory
with mode `0700`. Server output is kept in mode-`0600` log files there. `stop`
checks each PID's kernel start tick and `server.ts` command line before sending
signals, and never uses a process-name-wide kill. Stop both servers when the
checks finish; then remove the state directory and metadata file with the same
user that created them. The MariaDB database itself is not dropped by this
helper.

The health endpoint reports application readiness, configured mode and
detected dialect. `start` also performs `SELECT VERSION()` through the MariaDB
driver and rejects non-MariaDB servers. This is a test fixture harness, not a
claim that the full application or all user actions have been verified.
