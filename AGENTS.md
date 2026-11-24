# Project coordination

Use the [project-coordinator skill](.agents/skills/project-coordinator/SKILL.md) for project coordination. The designated Coordinator on `agent-vm` is the chat named **Coordinator**.

| Role | Model | Reasoning effort |
| --- | --- | --- |
| Coordinator | User selection for the chat | User selection for the chat |
| Architect | `gpt-6.2-astra` | `high` |
| Developer | `gpt-6.2-sol` | `medium` |
| Reviewer | `gpt-6.2-astra` | `high` |

When delegating to an Architect, Developer, or Reviewer, set the assigned model and reasoning effort explicitly.
