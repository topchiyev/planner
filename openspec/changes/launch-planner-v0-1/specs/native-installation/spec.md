# Native installation

## Purpose

Run Planner and its private database as a self-contained native installation with repeatable service and recovery procedures.

## ADDED Requirements

### Requirement: Install natively and establish readiness
A supported Linux host SHALL be able to install, configure, start, stop and restart Planner using native services. The installer SHALL check prerequisites and distinguish service liveness from application readiness. Fresh setup SHALL allow first administrator creation.

#### Scenario: Install on a clean host
- **WHEN** an operator installs Planner on a supported host without a pre-existing MongoDB installation
- **THEN** the installer provisions Planner's runtime components and dedicated database, and the operator can complete first login.

#### Scenario: Detect database unavailability
- **WHEN** the Planner database stops or an incomplete import still needs cutover
- **THEN** application readiness indicates the condition and ordinary workspace traffic cannot use an incomplete database.

### Requirement: Isolate the bundled MongoDB service
Planner SHALL provision a dedicated MongoDB service with a configurable non-default loopback port, private database credentials, dedicated storage, separate service identity and network access limited to the host. The installer SHALL preserve existing MongoDB services and refuse conflicts on its configured port.

#### Scenario: Install alongside a system MongoDB
- **WHEN** a host already runs an unrelated database on its standard port
- **THEN** Planner starts its own authenticated instance on the configured private port without reading, modifying or reusing the existing service.

#### Scenario: A process already owns the configured port
- **WHEN** the Planner database port is occupied by another process
- **THEN** setup reports the conflict and leaves that process and its data alone.

### Requirement: Preserve installation data through service maintenance
Planner SHALL provide backup and verified restore for workspace data and files, and SHALL preserve data when its application services are restarted or reinstalled. Destructive removal of persisted data SHALL require an explicit operator action.

#### Scenario: Restore a saved workspace
- **WHEN** an operator restores a supported matched database and file backup into a clean Planner installation
- **THEN** the restored board, account mappings and attachment checksums reconcile before readiness returns.
