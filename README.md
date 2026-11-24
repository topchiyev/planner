# Planner

Planner is a self-hosted kanban workspace for teams. It is designed to help teams move their work from PLANKA Community 2.3.x and connect assistants such as Codex and Claude through the Model Context Protocol (MCP).

Planner is free and open source. Every feature is available free of charge to users with the relevant account and project permissions.

**Project status.** Planner 0.1.0 is in the planning stage. This repository contains the design, specifications, and implementation plan.

## Planned for 0.1.0

- **Team workspace.** Organize work into projects and boards. Switch between kanban, grid, and list views, and collaborate on cards with checklists, assignees, attachments, comments, and live updates.
- **PLANKA migration.** Start fresh or import a PLANKA Community 2.3.x snapshot during setup. Review what was imported and verify the result before cutover.
- **Account-scoped MCP.** Connect supported Codex and Claude clients. Each connection acts within the permissions of the Planner account that authorized it.
- **Native Linux installation.** Run Planner on Ubuntu 24.04 LTS with systemd and a dedicated MongoDB instance.

## Project documents

- [Release proposal](openspec/changes/launch-planner-v0-1/proposal.md) describes the scope and supported workflows.
- [Architecture](openspec/changes/launch-planner-v0-1/design.md) covers the application, storage, migration, and access model.
- [OpenSpec requirements](openspec/changes/launch-planner-v0-1/specs) describe the behavior the release must support.
- [Implementation plan](openspec/changes/launch-planner-v0-1/tasks.md) tracks work and release verification.

## License

You can use, modify, redistribute, and sell copies of Planner’s original code and documentation under the MIT License. Copies and substantial portions must retain the copyright and permission notices. [MIT License](LICENSE)

Third-party components retain their own licenses. [OpenSpec skills (MIT)](.agents/skills/LICENSE-OpenSpec) · [MongoDB Community Server (SSPL)](https://www.mongodb.com/legal/licensing/server-side-public-license)
