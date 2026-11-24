# PLANKA migration

## Purpose

Move supported PLANKA 2.3.x workspace data into a new Planner installation with a verifiable handoff and a recoverable failure path.

## ADDED Requirements

### Requirement: Preflight an install-time import
The installer SHALL offer fresh setup or migration from a consistent PLANKA 2.3.x PostgreSQL backup and matching file snapshot. Preflight SHALL verify the version, schema, source consistency evidence, destination readiness and supported data before importing. It SHALL report blockers and exclusions without modifying the source or activating a destination.

#### Scenario: Check supported snapshots
- **GIVEN** separate complete fixtures from PLANKA Community 2.3.0 and 2.3.1
- **WHEN** an operator selects migration during setup and runs preflight for each fixture
- **THEN** each supported source is recognized and the report lists the expected rows, files, exclusions and destination prerequisites.

#### Scenario: Detect unsupported or incomplete input
- **WHEN** the declared release is unsupported, the schema does not match, or a required attachment file is missing
- **THEN** preflight identifies the cause and prevents activation under default policy.

### Requirement: Reconcile missing assets and historical references
Planner SHALL report absent originals, corrupt assets, stale previous lists, historical snapshots and orphan notifications separately. It SHALL permit activation with specifically approved absent originals and keep the affected file records visibly unavailable. Corrupt assets and unresolved active access relationships SHALL block activation.

#### Scenario: Approve an original file absent from the source
- **WHEN** an operator explicitly approves the exact absent asset for the verified snapshot
- **THEN** the corresponding attachment remains visible as unavailable after activation and attempts to download it receive no file.

#### Scenario: Preserve history with a deleted target
- **WHEN** an import contains historic activity referring to a former list and an unread notification with no accessible live target
- **THEN** the activity retains its historical snapshot and the orphan notification is reported without adding a user-visible inbox item or unread count.

### Requirement: Preserve workspace relationships and content
The importer SHALL preserve supported users and their status, memberships, projects, boards, lists, cards, ordering, labels, assignments, task groups and links, custom field values, comments, activity, favorites, subscriptions, notifications and referenced files. It SHALL preserve supported timestamps, author references, archive states, and nullable fields.

#### Scenario: Compare representative workspaces
- **WHEN** an operator imports a snapshot containing ordered cards, archived items, a user without a username, linked tasks, custom fields and attachments
- **THEN** counts and relationships reconcile and authorized users can open the same work in Planner with ordering, authorship, timestamps and file contents intact.

#### Scenario: Import object-backed attachments
- **WHEN** the operator provides a matching read-only object snapshot or a materialized copy for an object-backed installation
- **THEN** Planner verifies each supported referenced object's content and makes the imported file available subject to board permissions.

### Requirement: Re-establish credentials and integrations safely
Planner SHALL preserve identity and account status while requiring imported users to establish new Planner credentials and enroll MFA again. Source sessions, passwords and hashes, authentication secrets, and integration credentials SHALL remain excluded. Unsupported or inactive integration settings SHALL be identified in the report.

#### Scenario: Source contains active sessions and integrations
- **WHEN** a source snapshot contains password hashes, sessions, API keys, MFA secrets or configured delivery integrations
- **THEN** Planner excludes those credentials, sends no imported integration traffic, and records the affected integration types in the operator report.

#### Scenario: Recover an account that used MFA
- **WHEN** an imported user with source MFA completes verified recovery but has yet to enroll a new factor
- **THEN** access remains limited to credential setup until enrollment completes, including for MCP consent.

#### Scenario: Bootstrap the first administrator on a cold migration
- **GIVEN** a new Planner installation with no usable account and an enabled imported administrator
- **WHEN** the local operator authorizes that administrator to complete recovery
- **THEN** the administrator can establish credentials and any required MFA without changing the source identity or opening staging to ordinary users.

### Requirement: Recover and verify a staged migration
Planner SHALL stage imports into a new destination, report counts, mappings, exclusions and file integrity, and require successful reconciliation and explicit operator cutover. Repeating or resuming a selected snapshot SHALL prevent duplicates. Failure SHALL leave the source usable and the incomplete destination unavailable to users.

#### Scenario: An import stops partway through
- **WHEN** an import fails after saving some supported records and the operator retries the same snapshot
- **THEN** the operator can complete a clean, consistent import with one destination record per supported source record and the source remains unchanged.

#### Scenario: An operator declines cutover
- **WHEN** a staged import reconciles successfully and the operator declines to cut over
- **THEN** the destination remains unavailable to ordinary users and the operator can continue using the source.

#### Scenario: Verify an activated snapshot before enabling writes
- **WHEN** the operator activates a verified snapshot for read-only cutover checks
- **THEN** authorized reads are available and edits remain blocked until the operator explicitly enables writes.
