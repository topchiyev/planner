# Planner 0.1.0

## Why

Teams using PLANKA 2.3.x need a way to move their work into a self-hosted kanban application that they can evolve independently. Planner 0.1.0 gives them familiar day-to-day workflows, a repeatable migration, and account-scoped automation through MCP.

## What Changes

- Build Planner under its own name, version and visual identity. Use PLANKA 2.3.x Community as the workflow and data-compatibility reference. Cover the board, collaboration and administration workflows defined in the specs.
- Ship one free feature set under ordinary account and project permissions, with no paid tiers, purchase prompts, upgrade gates or license activation. Release Planner’s original code and documentation under the MIT License.
- Offer fresh install and an optional PLANKA 2.3.x import during setup. Preserve supported records, relationships and files, report exclusions and provide a verification and cutover path that preserves the source installation.
- Expose a standards-based Streamable HTTP MCP endpoint compatible with Codex CLI and desktop, Claude Code, and Claude custom connectors. Each authorized client acts as the Planner user who connected it and inherits that user's current permissions.
- Provide a native Linux installation with a dedicated, authenticated MongoDB instance, private port, service identity and data directory. Native Linux is the release support target. Container packaging falls outside the release.

## Capabilities

### New Capabilities

- `kanban-workspace` — Planner identity and the project, board, card and collaboration workflows.
- `planner-accounts` — Login, roles, membership checks and account lifecycle.
- `planka-migration` — Install-time import, reconciliation, recovery and cutover for PLANKA 2.3.x.
- `planner-mcp` — Streamable HTTP discovery, account authorization, and Planner tools, resources and prompts.
- `native-installation` — Fresh install, dedicated MongoDB, service lifecycle, backups and recovery.

### Modified Capabilities

None. This is the first Planner release.

## Impact

This establishes the frontend, backend, private persistence and file storage, native installer, import tooling and remote MCP interface. Release verification covers a clean host, representative snapshots from both PLANKA 2.3.x releases, multi-user permission boundaries and real Codex and Claude connections. PLANKA remains a migration source and interoperability reference. Planner ships independently written code and its own interface.
