# Planner accounts

## Purpose

Give each person a distinct identity and enforce the same workspace permissions across browser and integration access.

## ADDED Requirements

### Requirement: Establish and manage local accounts
Planner SHALL let a fresh installation establish an administrator and let administrators provision, disable and recover local accounts. It SHALL provide sign-in, sign-out, password recovery through an administrator-controlled reset flow, and user-managed multifactor authentication.

#### Scenario: Recover an imported account
- **GIVEN** an enabled imported account is awaiting credential setup
- **WHEN** the administrator issues a reset and the user completes it
- **THEN** the user can sign in as the imported identity with its existing project and board memberships.

#### Scenario: End a session
- **WHEN** a user signs out
- **THEN** that browser session can no longer read or mutate authenticated resources.

### Requirement: Enforce workspace membership rules
Planner SHALL enforce workspace, project and board roles in the backend for reads, writes, attachments and event delivery. Access SHALL reflect the current account and resource memberships.

#### Scenario: A viewer attempts to modify a board
- **WHEN** a user with read-only board access attempts to move a card through a supported client
- **THEN** Planner denies the action and the board remains unchanged.

#### Scenario: Board access is removed
- **WHEN** a manager revokes the connected user's last grant of board read access
- **THEN** subsequent reads and writes are denied and board events and attachment access are no longer available to that user.

#### Scenario: Editor membership is removed while another read grant remains
- **GIVEN** a project manager with a direct editor membership on one of its boards
- **WHEN** the user's editor membership is removed
- **THEN** the user retains permitted reads and loses editor-only changes and membership-dependent follows and assignments.

#### Scenario: An administrator attempts to read an owner-managed private board
- **GIVEN** an imported owner-managed private board with an administrator outside its project manager and board member assignments
- **WHEN** that administrator requests the board, a card resource, or its attachment
- **THEN** Planner denies access regardless of client and exposes no protected data.

#### Scenario: Read a board in an unowned shared project
- **GIVEN** an unowned shared project with a board and an unrelated ordinary user
- **WHEN** a site administrator and that ordinary user each request the board
- **THEN** Planner allows the administrator and denies the ordinary user, including when the project is hidden.

### Requirement: Preserve accountable actions
Planner SHALL record the Planner actor for material mutations and SHALL distinguish actions made through connected MCP clients. Audit information SHALL omit credentials and tokens.

#### Scenario: Inspect an integration change
- **WHEN** a connected client updates a card on behalf of an authorized Planner user
- **THEN** eligible audit readers can identify the Planner user and client, and no credential is exposed in the audit record.
