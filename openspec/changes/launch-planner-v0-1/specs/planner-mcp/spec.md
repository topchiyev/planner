# Planner MCP

## Purpose

Let remote MCP clients work with Planner over standard HTTP using an explicitly authorized Planner identity.

## ADDED Requirements

### Requirement: Interoperate over Streamable HTTP
Planner SHALL expose an HTTPS Streamable HTTP MCP endpoint implementing the published 2026-07-28 profile and a 2025-11-25 compatibility profile. It SHALL handle discovery or initialization, version signaling, supported content types, JSON-RPC requests and errors, and streaming according to each profile and the capabilities it advertises.

#### Scenario: A current client discovers capabilities
- **WHEN** an authorized 2026-07-28 client uses the endpoint
- **THEN** the client can discover capabilities, submit versioned requests, and use the advertised methods over Streamable HTTP.

#### Scenario: A legacy Streamable HTTP client connects
- **WHEN** an authorized 2025-11-25 client initializes a connection
- **THEN** it can complete that profile's lifecycle and use the same Planner operations subject to its grant.

#### Scenario: Subscribe to supported board updates
- **WHEN** an authorized modern client starts a supported subscription and an eligible board changes
- **THEN** the client receives the corresponding notification on the appropriate stream.

### Requirement: Connect a client to a Planner account
Planner SHALL provide standards-based OAuth discovery and authorization with PKCE and consent through a Planner account. It SHALL bind the grant to the consenting user, client, resource and scopes, issue revocable access, and let the user see and revoke connected clients.

#### Scenario: Authorize a client without a manual token
- **WHEN** a compatible remote client discovers authorization and the user signs into Planner and approves a read grant
- **THEN** the client can read only Planner records visible to that user and permitted by the grant.

#### Scenario: Reject an invalid token
- **WHEN** a client sends an expired token or a token issued for another resource
- **THEN** the endpoint denies access according to the authorization profile and exposes no Planner data.

### Requirement: Connect Codex and Claude to Planner
Planner SHALL support Codex CLI and desktop, Claude Code, and Claude custom connectors through its HTTPS Streamable HTTP endpoint. Users SHALL be able to sign into their own Planner account, authorize access without a manually issued token, discover tools, and perform permitted reads and updates. Planner SHALL enforce its grant scopes, current account permissions and revocation for each client.

#### Scenario: Connect from Codex
- **WHEN** a user configures Planner in Codex CLI or desktop, signs into Planner through the client's OAuth flow, and grants access
- **THEN** Codex can discover and call Planner tools as that user, and a permitted card update appears in Planner with the correct audit actor.

#### Scenario: Connect from Claude Code
- **WHEN** a user adds Planner as an HTTP server in Claude Code and approves a Planner grant through the browser login
- **THEN** Claude Code can discover and call Planner tools as that user, with writes denied when the grant is read-only.

#### Scenario: Connect from a Claude custom connector
- **GIVEN** a Planner instance reachable by Claude's hosted connector using HTTPS
- **WHEN** a user adds the Planner endpoint as a custom connector and approves a Planner grant
- **THEN** Claude can discover tools and read and update permitted cards as that user, and loses access when that grant is revoked in Planner.

### Requirement: Discover and use Planner capabilities
Planner SHALL expose schemas and paginated discovery for its supported MCP tools, resources and prompts. Its tools SHALL support ordinary project, board, membership, list and card work, including organization, card details, collaboration and discovery. Planner SHALL apply the same validation, permission checks and audit rules as the web application.

#### Scenario: Inspect and update a board
- **WHEN** a client with write scope and editor access finds a card through a tool or resource and calls a supported move operation
- **THEN** the card updates once, the board view reflects the new placement and the audit record identifies the acting user and client.

#### Scenario: Use a read-only workflow
- **WHEN** a client lists and uses the board summary prompt or reads a board resource
- **THEN** the workflow uses only data accessible through that grant and the user's current permissions.

#### Scenario: Use board creation and card maintenance from a client
- **WHEN** a client with the corresponding write scope and roles creates a board, restores an archived card, and updates a custom field through the relevant tools
- **THEN** the changes match the corresponding browser workflows and a read-only caller cannot perform them.

### Requirement: Enforce current access throughout a connection
Planner SHALL check the grant, scope and account authorization for each operation and associated data delivery. Absent or withdrawn access SHALL block affected operations and terminate access to the affected streams or subscriptions.

#### Scenario: Try a mutation with a read-only grant
- **WHEN** a client uses a read-only grant to update a card
- **THEN** it receives a permission error and the card remains unchanged.

#### Scenario: Revoke a live connection
- **WHEN** a user revokes a client or an administrator disables the user while the client is connected
- **THEN** new requests and refreshes fail and protected streams stop delivering data.
