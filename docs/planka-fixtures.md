# PLANKA Community snapshot fixtures

The [2.3.0](../tests/fixtures/planka/2.3.0/manifest.json) and [2.3.1](../tests/fixtures/planka/2.3.1/manifest.json) fixtures represent separate invented installations. Each has a stable source instance and asset snapshot ID, a standalone PostgreSQL restore script assembled from checked-in SQL, and its own byte-verified local asset tree. The installations intentionally reuse legacy IDs so migration tests can exercise source instance scoping.

## Run the fixture checks

Use Node 24 and PostgreSQL 17 server tools (`initdb`, `postgres`, `psql`, and the `pg_trgm` extension from the same installation). Run as an ordinary user from the repository root.

```sh
node --test tests/integration/planka-source-fixtures.test.mjs
```

Set `PLANNER_TEST_PG_BIN_DIR` when the tools are outside `PATH`. Run packaged tools with their matching shared libraries for this command. The test starts its own child PostgreSQL server on a mode-0700 socket with TCP disabled, strips inherited `PG*` connection settings, and reads two fresh databases with a SELECT role. The helper registers the bootstrap database and each database it creates, and accepts only registered names as client targets. It deletes the temporary cluster on completion. Missing PostgreSQL executables fail this explicit integration check.

To materialize either snapshot for a fixture consumer, write the assembled SQL to a disposable directory and keep it paired with the release's manifest, asset manifest and `assets/` directory.

```sh
fixture_work=$(mktemp -d)
node tests/fixtures/planka/snapshot.mjs 2.3.0 > "$fixture_work/source.sql"
sha256sum "$fixture_work/source.sql"
```

The digest is `source.dumpSha256`. The output is a standalone plain SQL script with inline `COPY` data and psql variable commands. Run it with `psql -X -v ON_ERROR_STOP=1 -f` in an empty disposable fixture database using an explicit socket, database and owner. Use the same command with `2.3.1` for the other release.

## Frozen source shape

[Source pins](../tests/fixtures/planka/source-pins.json) records the verified commit for each tag and the shared migration tree. [The ledger](../tests/fixtures/planka/migrations.txt) contains 23 sorted basenames, each followed by LF. The [public reference verification](development.md#planka-community-compatibility-baseline) shows how to verify Git objects in a disposable checkout. To verify the ledger digest, sort the fetched migration basenames with `LC_ALL=C sort` and hash the resulting lines.

The [catalog query](../tests/fixtures/planka/catalog.sql) captured structural facts from a clean PostgreSQL 17.12 database after applying the shared public migrations from a disposable checkout. The capture used Knex 3.3.0, pg 8.23.1 and mime-types 3.0.2 from the identical upstream server lockfile at both tags. It used the upstream `migration` ledger name and snake-case identifiers. It read only PostgreSQL catalog metadata. The checked-in files contain the normalized [catalog facts](../apps/backend/src/application/migration/planka-community-catalog.json), migration filenames, independently authored synthetic DDL and data, and generated images and text.

The tests compare each restored fixture with the frozen catalog. They check 34 ordered column projections with PostgreSQL types and nullability, 47 constraints, 113 named index definitions, zero foreign keys, and all 23 ledger names. The index comparison includes GIN operator classes and predicates. The DDL supplies explicit synthetic IDs. Application defaults, ID generators and production restore permissions are outside this source projection.

## Scenario evidence

| Case | Fixture evidence |
| --- | --- |
| Source branches absent from the private reference | Closed list with a closed story, story and project cards at a tied active position, same-board and cross-board linked tasks, custom field values from a template in two instances, and viewers with true and false comment flags. The viewer of the source board lacks membership of the cross-board target. |
| Identity and values | Three source roles, two null usernames, a disabled account and an MFA-enabled flag. Account and connection credential fields are empty. Two adjacent card IDs above the JavaScript safe integer range, UTC microseconds and null, false and zero remain distinguishable. |
| History | An archived card refers to a removed previous list. A historical action retains that list's snapshot. An unread move notification has absent card and action targets. A second notification keeps a live comment and its read state. |
| Files | Both snapshots have nine manifest entries. The image original is shared by two references and is the cover of one card. Two additional upload IDs have identical content. The original filename contains decomposed Unicode and differs from the display names. Avatar and background source size metadata differs from encoded bytes. HTTPS and loopback link attachments are inert metadata. |
| Controlled faults | The test alters a disposable copy to remove or corrupt an original, introduce case or Unicode-normalization collisions, substitute a symlink, and supply a traversal manifest key. A transaction injects an inert `urn:` link to exercise an unsupported scheme alongside the HTTP(S) cases. The database test checks missing and unknown columns, changed username exclusion, legacy card index names, loss of custom field uniqueness and an unexpected ledger name. |

The missing asset changes affect two attachment references through one shared upload. The [migration contract](../openspec/changes/launch-planner-v0-1/migration.md#deterministic-exception-policy) defines future approval and reconciliation for those references, the stale list and the orphan notification. These checks cover source fixtures and their diagnostics. How the records become available is covered by the separate cutover checks.

The [core staging test](../tests/integration/migration-base.test.mjs) uses the same captures with an owned MongoDB fixture. It checks matching IDs across rehearsals, signed ranks and exact history order, scoped project and board access, the requirement for new credentials on imported accounts, and repeatable writes after interruption. Imported timestamps retain their source precision in the protected ID map. Planner uses the manifest capture time where a resource requires a creation or disablement timestamp and the source has none. Recognized source gradient names map to the version 1 Planner presets. Unrecognized names use a neutral background and remain available in protected provenance for reconciliation. A missing optional cover or background record retains its typed source reference locally and has no live association. A reference to another card or project blocks staging.

The relationship staging checks verify ranked labels, favorites, follows, assignees and checklists without producing live activity or notifications. A source-board viewer can read the same-board linked task and gets a neutral row for a private destination. Two field group instances share one template definition while retaining independent exact values. The test covers empty and longer text, missing linked targets, foreign owners, occupied unique tuples and replay after a durable field-value write.

The staged discussion checks use the same authorized comment, activity and inbox reads as Planner. They compare cached source comment counts with the observed comment rows, retain typed activity snapshots in protected provenance, and quarantine deliveries whose parent or recipient is unavailable. A source notification records only a read flag. Planner uses the source update time, then the creation time, then the manifest time when it needs a non-null `readAt` for a historical read notification. Unread notifications keep a null `readAt`. Known source mention IDs are rewritten in place without generating follows or deliveries. [Tagged activity model](https://github.com/plankanban/planka/blob/v2.3.1/server/api/models/Action.js) · [Tagged notification model](https://github.com/plankanban/planka/blob/v2.3.1/server/api/models/Notification.js)
