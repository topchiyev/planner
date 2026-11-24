# Planner build and operations contract

## Repository skeleton

Use one npm workspace and one lockfile. Ship one Node.js backend process with the compiled frontend assets. The CLI and packaging scripts are separate entry points into the same install, recovery, and migration code.

| Path | Ownership and contents |
| --- | --- |
| `package.json`, `package-lock.json`, `tsconfig.base.json` | Private npm workspace with `@planner/backend` and `@planner/frontend` application packages, release version 0.1.0, Node 24 engine, shared TypeScript strict settings and release commands. |
| `packages/contracts/src` | Pure Zod schemas, resource IDs, DTOs, error codes, operation IDs, browser event envelopes and import-report shapes. Export from `index.ts`. Import no runtime adapter. |
| `apps/backend/src/main.ts`, `config.ts`, `build-app.ts` | Load validated configuration, open isolated MongoDB, acquire the writer lock, recover pending changes, construct Fastify, mount adapters and handle graceful shutdown. `build-app` supports injected services for HTTP tests. |
| `apps/backend/src/domain/{accounts,projects,boards,cards,content,collaboration}` | Pure rules for permissions, placement, revisions, field validation and state changes. |
| `apps/backend/src/application/{operations,access,command-gate,events}` | Shared operation handlers, authorization and journal boundary. Every REST or MCP tool calls a registered operation with an actor established by the backend. |
| `apps/backend/src/storage/{mongo,blobs}` | Connection, named collections, index and schema migrations, repositories, private file storage and repair. Keep BSON and filesystem objects inside adapters. |
| `apps/backend/src/http/{rest,session,events,files}` | REST routes and errors, browser login, authenticated SSE and download/upload controllers. |
| `apps/backend/src/{oauth,mcp,import,maintenance}` | OAuth provider plus adapter, MCP SDK transport, PLANKA readers and maps, and service lifecycle primitives. Import code may read only via its own source adapter and write only the inactive target generation. |
| `apps/frontend/src/{app,api,components,features}` | Router, app shell and browser API wrapper, shared accessible controls, and feature pages for sign-in, projects, boards, card inspector, notifications, accounts and settings. Store frontend preferences through their documented boundaries. |
| `tools/cli/src/main.ts`, `ops/{package,systemd,proxy}` | `plannerctl` local operator command, .deb staging, two unit files and a sample TLS proxy config. No third-party service provisioning in package scripts. |
| `tests/{fixtures,integration,e2e,release}` | Independent synthetic PLANKA and Planner inputs, real standalone MongoDB checks, browser and client acceptance, and clean-host package drills. |
| `docs/{development,operations,migration,mcp}.md` | Commands, runtime service and storage ownership, source snapshot procedure, and supported client configuration. Keep runbooks adjacent to the task that introduces their entry point. |

Use TypeScript 6.0.3 in NodeNext ESM, Fastify 5, MongoDB Node driver 7, React 19, Vite 8, Zod 4, `pg` 8, `oidc-provider` 9 and the official MCP SDK split v2 packages. Use Vite development proxy for same-origin API behavior. Use dnd-kit for pointer handling, an explicit keyboard move action, and TipTap's Markdown bridge with a plain Markdown editor mode. Use Node's test runner through `tsx` for backend and contract tests, React Testing Library for isolated UI behavior, and Playwright for real browser flows. Resolve and commit one exact, mutually compatible patch set in task 1.2. Record resolved package versions and peer dependency results there. Build and CI consume the lockfile with `npm ci`.

### Interfaces between modules

1. Contracts export input and output schemas and an operation ID. The backend registry binds each ID to its read or command handler, scope and resource policy. REST and MCP adapters deserialize from the same schemas. The storage adapters return domain objects.
2. The frontend sends the shared contract shape. Backend error responses use a machine code and a safe message. The frontend renders validation and conflict outcomes and re-fetches changed resources. It derives control visibility from permission flags returned by the backend.
3. Use `npm run dev`, `build`, `typecheck`, `test`, `test:integration`, `test:e2e`, and `verify` at the repository root. `verify` runs types, unit and contract tests, and build. Integration and browser commands run separately with their documented isolated fixtures. Test startup must refuse a shared MongoDB URI.

## Storage and command execution

- Use UUIDv4 strings for newly created resources and deterministic UUIDv5 for imported rows. Use the same ID in URLs, REST and MCP. Preserve each source bigint as a decimal string in a separate import map. Store MongoDB `Date` for instants. Serialize UTC ISO 8601. Express intervals and sizes as bounded nonnegative integers. Use an explicit null for absent optional values in responses.
- Scope business documents by `generationId`. Keep public `id` separate from MongoDB `_id` and use the internal key `generationId/id` so two staged generations can hold the same public ID. Use a small `installation` collection for instance UUID, active generation, schema version and setup state. Put a generation predicate in every workspace read, index, unique constraint and command. Use explicitly selected inactive generations for importer and operator verification. Session and grant resolution must match the active generation or the specific enrollment generation allowed by setup.
- Give each editable object `revision` starting at 1. Use signed 64-bit integer ranks internally with step 1024. Serialize positions as decimal strings if exposed. A move accepts neighbor and/or target list IDs and current revision and placement version, never a browser-computed rank. Allocate the midpoint or renumber the affected ordered scope under the command gate. Sort by rank, then ID. Source ordering is resolved before initial ranks are assigned.
- Use deterministic cursor pagination with an opaque, versioned cursor bound to actor, generation, query and ordering. Clamp limits to 100 and default to 25. Reject malformed or mismatched cursors. Board detail and counts use the same permission predicate as its card queries. Escape literal query strings and project only public DTO fields.

### Collections and minimum indexes

| Collections | Minimum searchable or unique keys after the generation prefix |
| --- | --- |
| `users`, `projects`, `projectManagers`, `projectFavorites` | Unique normalized email and partial unique normalized username, ordered project rank, unique project/user pairs and reverse user-to-project lookup. |
| `boards`, `boardMembers`, `boardPreferences`, `lists`, `cards` | Project/rank, unique board/user and lookup by user, shared board options, board/rank, unique system-list kind per board, list/rank/id and list/listChangedAt/historySequence/id, card kind and search field by board. |
| `labels`, `cardLabels`, `cardAssignees`, `checklists`, `tasks`, `fieldGroups`, `fieldDefinitions`, `fieldValues` | Board/rank, unique link pairs, card/rank and checklist/rank, reverse linked-card lookup, field scope/rank, unique card/field-group/field-definition tuple. |
| `comments`, `activities`, `auditEntries`, `boardFollows`, `cardFollows`, `notifications` | Card and board feeds ordered by time and ID, audit query by actor and resource, unique follow pairs, recipient/read-state/time. |
| `attachments`, `projectBackgrounds`, `blobs` | Card/time, project/time, digest reference, unique digest string per generation, file lifecycle state and byte length. Avatars are user-owned references. |
| `sessions`, `recoveryGrants`, `trustedDevices`, `oauthArtifacts`, `oauthConnections` | Unique token digest or provider artifact identifier, user and client association, expiry, atomic consumption and revocation. |
| `commands`, `commandEffectBatches`, `events`, `importRuns`, `importIds`, `importQuarantine` | Unique idempotency key with actor and operation identity, journal status and recovery sequence, unique command/batch and board/event-sequence keys, unique generation/entity/source ID maps, run state/checkpoints and quarantined-row reason. |

### Mutation, idempotency and recovery

1. Acquire exclusive on-host process ownership before opening write paths. Use a supervisor-held advisory lock under `/run/planner` for the application and maintenance commands. A second writer exits. A FIFO in-process gate serializes business mutations and coordinates snapshot reads. File streaming and long-lived events release the read gate after taking an authorized DTO or file handle. Revalidate subscription recipients before delivery.
2. Read current actor, ACL, generation, revisions and references within the gate. Resolve an operation and normalized input, including idempotency ID, before checking state. Persist an intent using acknowledged journaled writes. The intent records deterministic IDs, one timestamp, target revisions, normalized operation hash, effect keys and phase. Store large effect sets in immutable batches of at most 256 effects and 2 MiB. Persist and verify their manifest before changing the intent from `building` to `prepared`. An interrupted build has no domain effects and can be rebuilt under the same authorization. Avoid secrets in the intent. Credential changes use dedicated atomically consumed secret-state records.
3. Apply effects in order with revision checks and the same logical effect ID on each replay. Persist and fsync staged bytes before linking them. Store change and audit records with predetermined unique event IDs. Mark intent committed only after all durable effects succeed. ACK the response after commit. Notify subscribers after commit, even if an earlier notification was lost.
4. On retry, accept the same key and payload, recheck current access, then return the recorded result or recover the pending command. Reject a reused key with a different payload as `409 IDEMPOTENCY_CONFLICT`. Scope the key to generation, actor and operation. Browser generates UUIDs. MCP accepts `idempotencyKey` for writes. Keep results for at least seven days and uncertain intents until resolved.
5. On recoverable failure after recording intent, keep business readers behind the gate until effects replay successfully. If recovery cannot finish, return maintenance status and keep the ordinary routes closed. Before readiness at boot, replay intents in order and reconcile the event outbox. Test interruption before intent, during effect writes, after commit before response, and before publication. Verify no partial or duplicate records in reads, feeds, audit or attachments.
6. Allocate monotonic event sequences per board and use stable IDs for deduplication. Board snapshots contain the last committed sequence. Replay from the client's `Last-Event-ID` where available. Replay at most 1,000 retained events. Otherwise emit a reset signal and require a fresh authorized snapshot. Send SSE heartbeat every 20 seconds and close upon permission or session loss. Publish IDs and revisions with only the minimum payload from the recipient's authorized scope.

## Native install and ownership

| Location | Runtime contract |
| --- | --- |
| `/opt/planner/releases/0.1.0`, `/opt/planner/current` | Immutable binaries, built application and static assets, packaged Node.js 24 and MongoDB 8.0 and toolchain notices. Atomic current-release symlink. |
| `/etc/planner/planner.json`, `/etc/planner/mongod.conf` | Install UUID, canonical HTTPS origin, HTTP and MongoDB ports, expected DB identity. Separate file-backed secrets protected by OS ownership and mode. |
| `/var/lib/planner/mongodb`, `/var/lib/planner/{blobs,staging,backups}` | MongoDB data mode 0700 owned by `planner-mongodb`. App storage owned by `planner`, with staged and committed blobs on one filesystem. |
| `/run/planner`, `planner.service`, `planner-mongodb.service` | Locks and service supervision. Use systemd credentials or same-purpose files to pass secrets. App HTTP binds `127.0.0.1:27430` by default, MongoDB at `127.0.0.1:27431`. Only the configured reverse proxy is trusted, with explicit HTTPS public origin and SSE buffering disabled. |

- `plannerctl preflight --public-url URL [--app-port N] [--db-port N]` reports supported OS/arch, free configured ports, directory ownership, available storage, installed version and runtime readiness. Read-only and structured output available with `--json`.
- `plannerctl setup --mode fresh|import` writes validated config and starts its MongoDB only. Provision an installation identity and a limited app role using a one-time local bootstrap body. Verify the expected DB identity before app startup. Fresh setup issues a short-lived first-admin grant. Import setup leaves workspace routes gated and invokes the migration contract.
- `plannerctl status`, `start`, `stop`, `restart`, `backup create`, and `backup restore` operate only on Planner services and data. Uninstall preserves persistent state by default. Keep destructive removal behind a separately confirmed `plannerctl purge-data`.
- Use a Unix control socket at `/run/planner/admin.sock` with parent and socket permissions limiting local use to the Planner service identity and root. Online operator mutations enter the same application gate through that socket. Offline restore takes the exclusive writer lock with the app stopped. Keep operator methods off the public HTTP listener.
- `GET /health/live` reports process liveness. `GET /health/ready` returns 503 during setup, recovery, DB outage, failed schema check or unapproved migration. Endpoint payload contains only status, release version and request ID. Keep configuration and readiness failure specifics in the operator interface.
- Use a guarded native package install controlled by the local operator. Validate distro dependencies without network use during installation. Package scripts do not start an unconfigured service or overwrite an existing DB. Stage and verify upgrades and create a recoverable backup before switching `current` or migrating active data.
- For backup, block new mutations, drain and flush the journal, capture database and private filesystem as a matched set and write a verified manifest. Encrypt or otherwise restrict the matched secret bundle. Restore into an inactive generation and require ID, tenant, file and readiness checks before activation. Backups preserve the installation namespace needed for imported IDs.

## Test environments and handoff

Use a fresh Ubuntu 24.04 x86-64 VM for package acceptance and a second clean VM for restore. Keep a disposable integration instance per test run and use fixed synthetic IDs from fixtures. Exercise old and current account permissions, overlapping browser edits, missing blobs and startup recovery from real endpoints. Keep credentials, raw payloads and private logs out of acceptance evidence.

The local PLANKA reference is beside this repository under `../planka-reference`. Use its runbook and loopback endpoint for source behavior checks. Query schema metadata, keep observations aggregate and record version and query intent. Produce independently authored fixtures for public tests and hosted-client verification.

Before assigning a task, the Coordinator records the accepted planning revision, task IDs and prerequisites, role, branch/worktree, owned files, forbidden shared resources, acceptance cases and test commands. A task returns the revision, checks and skipped cases, along with evidence for the changed path and an adjacent case. The Reviewer checks those same revisions and cases before integration.
