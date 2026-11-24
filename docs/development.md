# Planner development

## PLANKA Community compatibility baseline

Planner 0.1.0 uses these public PLANKA releases to establish workspace behavior and migration compatibility. Planner has independently written code, interface, copy and assets. The release scope is defined by the [OpenSpec design](../openspec/changes/launch-planner-v0-1/design.md) and its companion [workspace](../openspec/changes/launch-planner-v0-1/workspace.md), [access and MCP](../openspec/changes/launch-planner-v0-1/access-and-mcp.md), and [migration](../openspec/changes/launch-planner-v0-1/migration.md) contracts.

| Tag | Pinned commit | License evidence at that commit |
| --- | --- | --- |
| [v2.3.0](https://github.com/plankanban/planka/releases/tag/v2.3.0) | [`ce6d499ae16202a727d7dbb9238b48422ab60da9`](https://github.com/plankanban/planka/commit/ce6d499ae16202a727d7dbb9238b48422ab60da9) | [Repository notice](https://github.com/plankanban/planka/blob/ce6d499ae16202a727d7dbb9238b48422ab60da9/LICENSE.md), [Community terms](https://github.com/plankanban/planka/blob/ce6d499ae16202a727d7dbb9238b48422ab60da9/LICENSES/PLANKA%20Community%20License%20EN.md), [commercial terms](https://github.com/plankanban/planka/blob/ce6d499ae16202a727d7dbb9238b48422ab60da9/LICENSES/PLANKA%20Commercial%20License%20EN.md) |
| [v2.3.1](https://github.com/plankanban/planka/releases/tag/v2.3.1) | [`27219fd3635e695b2ec4e2a9d9ed6bec6560370f`](https://github.com/plankanban/planka/commit/27219fd3635e695b2ec4e2a9d9ed6bec6560370f) | [Repository notice](https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/LICENSE.md), [Community terms](https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/LICENSES/PLANKA%20Community%20License%20EN.md), [commercial terms](https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/LICENSES/PLANKA%20Commercial%20License%20EN.md) |

The PLANKA notice distinguishes Community material from marked Pro/Enterprise source and identifies separately licensed third-party components. Pro/Enterprise features are outside Planner 0.1.0 compatibility scope. The v2.3.1 patch changes Markdown editing for boards with a member whose username is null, an explicit Planner acceptance case. [Pinned editor change](https://github.com/plankanban/planka/commit/27219fd3635e695b2ec4e2a9d9ed6bec6560370f)

The paths below resolve to the same Git objects at both pins.

| Path | Git object ID | Evidence |
| --- | --- | --- |
| [server/db/migrations](https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/db/migrations) | `6a054709a1a94d9f3505338ec377bf11f6c864d4` | Same 23 migration scripts through `20260918000000_add_show_card_counter_to_boards.js` |
| [server/api/models](https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/models) | `93f456979a109b5db05a5508b1e48bcd412fd537` | Same source model tree |
| [server/config/routes.js][up-routes] | `ab1233f0b3f52eb9ca84efeb091d1e298ad52f5b` | Same server route inventory |
| `LICENSE.md` | `eb25b3ed3bb14e2659dc4afdeefb5a7d311010e1` | Same repository notice |
| `LICENSES` | `3fd8ec1fc755ca14862592ca893f8a05c6b1e452` | Same Community and commercial license directory |

Verify the tags, object IDs, ledger count, and patch delta using a disposable bare repository. The commands inspect Git metadata and public diffs.

```sh
planka_reference_git=$(mktemp -d)
git init --bare "$planka_reference_git"
git -C "$planka_reference_git" fetch --depth=1 --no-tags https://github.com/plankanban/planka.git \
  refs/tags/v2.3.0:refs/tags/v2.3.0 refs/tags/v2.3.1:refs/tags/v2.3.1
for planka_tag in v2.3.0 v2.3.1; do
  git -C "$planka_reference_git" rev-parse "$planka_tag^{commit}"
  git -C "$planka_reference_git" ls-tree "$planka_tag" -- \
    server/db/migrations server/api/models server/config/routes.js LICENSE.md LICENSES
  git -C "$planka_reference_git" ls-tree -r --name-only "$planka_tag" -- server/db/migrations | wc -l
  git -C "$planka_reference_git" ls-tree -r --name-only "$planka_tag" -- server/db/migrations | tail -n 1
done
git -C "$planka_reference_git" diff --stat v2.3.0 v2.3.1
```

The private Community v2.3.1 restore is read-only evidence for schema metadata and aggregate observations. The recorded baseline has 34 public tables and 23 ledger entries. The recorded snapshot includes 250 cards across three boards, with active, archive and trash examples. Closed lists, story cards, linked tasks, custom field values and viewer memberships are absent. The migration contract also records three absent originals, stale prior lists, historical snapshots of deleted targets and orphan move notifications. These are aggregate observations from the private reference. Independently authored synthetic identities and workspace cases are planned in task 1.5, with synthetic schema, database and file fixtures for both pins in task 1.6. Those fixtures supply the absent branches, controlled file and relationship failures, and repeatable inputs for public tests and hosted-client acceptance. [Fixture tasks](../openspec/changes/launch-planner-v0-1/tasks.md#1-freeze-the-reference-and-build-skeleton) · [Reference observations](../openspec/changes/launch-planner-v0-1/migration.md#source-baseline-and-inputs)

## Community coverage matrix

The matrix identifies observable release checks. It is an index for implementation and verification. Use the linked OpenSpec scenarios and companion contracts for exact permissions, inputs and outcomes. Bring any later-discovered parity gap to the Coordinator before changing release behavior.

### Workspace and collaboration

| PLANKA source and workflow | Planner operation or action | Acceptance |
| --- | --- | --- |
| [Home][up-home] and [projects][up-projects]. Grouped and grid project views, sorting, filters, favorites, deep links and hidden presentation. | `projects.list/get/favorite/unfavorite`, project picker and home settings. | A manager and an admin of an unowned shared project see all permitted board summaries. A member sees assigned boards, an unrelated user sees none, and hidden state only changes presentation. [Read a board in an unowned shared project][acct-shared] · task 4.1 |
| [Projects][up-projects] and [project settings][up-project-settings]. Create, edit, set owner and managers, change project type, use a gradient or uploaded background, and delete. | `projects.create/update/delete`, `projects.addManager/removeManager/uploadBackground/removeBackground`, and scoped manager candidates. | Reject an ineligible or last-manager removal, validate private/shared conversion and project-scoped backgrounds, and require confirmation and zero boards for deletion. [An administrator attempts to read an owner-managed private board][acct-private] · task 4.2 |
| [Boards][up-boards] and [board preferences][up-board-settings]. Create, order, update and delete boards, choose default view or card type, and control creator, age, card counter and checklist display. | `boards.create/move/update/delete` and board settings. | Persist settings on reload, give the creator direct editor membership, create exactly one archive and trash list, and delete a confirmed board without removing a surviving shared file reference. [Organize a board across views][board-views] · task 4.3 |
| [Board access][up-board-show] and [membership cleanup][up-membership-cleanup]. Managers, editor/viewer membership, viewer comments and dependent cleanup. | `boards.members/addMember/updateMember/removeMember/memberCandidates`, shared access checks. | A viewer may comment only with the flag and cannot move cards. A manager with independent read access loses direct editor rights, assignments and follows on membership removal. Removing the last read path evicts live access and denies protected leaf reads. [A viewer attempts to modify a board][acct-viewer] · [Board access is removed][acct-removed] · [Editor membership is removed while another read grant remains][acct-read-remains] |
| [Board views][up-board-views]. Kanban, Grid and List, including historical contexts and card direct links. | `boards.workspace/cards`, view switcher, archive/trash navigation and card inspector. | Keep one scoped query and selection model across views, with archive/trash out of ordinary views and stable historical pagination. Verify direct links and inspector eviction on access loss. [Organize a board across views][board-views] · task 4.15 |
| [Lists][up-lists]. Finite active/closed list creation, editing, ordering and delete. | `lists.create/update/move/delete`. | A finite list can be reordered, stale ordering is rejected, archive and trash edits are rejected, and deleting a finite list puts its cards in trash. [Move a card][board-move] · task 4.4 |
| [List bulk actions][up-list-bulk] and [list controllers][up-lists]. Sort, archive closed-list cards and clear trash. | `lists.sort/archiveCards/clearTrash`. | Sort with stable ties and missing due dates last. Archive a closed list in one commit with per-card move history and no follower fan-out. Confirm trash clearing and reject a stale trash version. General selected-list bulk moves are outside this Planner operation. [Duplicate a card and clear trash][board-clear] · task 4.7 |
| [Cards][up-cards], [card move helper][up-move] and [card inspector][up-card-inspector]. Edit project/story cards, rich/Markdown description, due date and completion, stopwatch, and closed state. | `cards.create/get/update`, card content and stopwatch controls. | Reopen a card and verify its type, fields and stopwatch state. Test type restrictions for new cards or explicit type changes, retained type-specific data, and mention selection for a board member without a username. [Save and revisit a detailed card][board-details] · task 4.5 |
| [Card transitions][up-move] and [lists][up-lists]. Move, close, reopen, archive, trash, restore and purge. | `cards.move/archive/trash/restore/purge`. | Closed-to-active reopens and updates linked completion, archive preserves completion, and restore offers an eligible destination when the previous list is gone. Permanent removal requires confirmation. [Move a card][board-move] · [Recover archived work][board-recover] · [Recover after the original list was removed][board-recover-missing] |
| [Card movement][up-move], [duplication][up-duplicate] and [lists][up-lists]. Transfer cards or finite lists between boards and duplicate card content. | `cards.move/duplicate`, `lists.move`. | Require destination editor permission, remap labels and incompatible fields, drop ineligible assignments/follows, redact destination details on source-only events, and give clones independent IDs and a remapped cover. [Move a card between boards][board-transfer] · [Duplicate a card with an image cover][board-cover] |
| [Route inventory][up-routes] and [card inspector][up-card-inspector]. Board label palette and card members. | `labels.list/create/update/delete`, `cards.addLabel/removeLabel/assign/unassign`. | Accept unnamed labels within their board, reject a foreign label or an ineligible assignee, and preserve an explicit follow when unassigning. [Save and revisit a detailed card][board-details] · task 4.8 |
| [Task lists][up-task-lists] and [tasks][up-tasks]. Checklist ordering, front/expansion settings, hide-completed, task completion, assignments and linked cards. | `checklists.list/create/update/delete`, `tasks.create/update/delete/move`. | Reorder tasks within the owning card, sync linked completion, and show a neutral unavailable task when a link is inaccessible or its target is purged. [Save and revisit a detailed card][board-details] · task 4.9 |
| [Custom fields][up-fields] and [project templates][up-project-settings]. Project templates, board/card group instances, definitions, text values and front display. | The `fields` operation family. | Preserve exact text, accept two instances of one template independently, and reject a definition outside the card/group/definition tuple. [Save and revisit a detailed card][board-details] · task 4.10 |
| [Attachments][up-attachments], [asset configuration][up-assets] and [card inspector][up-card-inspector]. File and link attachments, thumbnails and image cover. | `attachments.addLink/addFile/update/delete/download/thumbnail`, `cards.update` for cover. | Leave HTTP(S) links inert on the server, choose the first eligible image cover, require current access for download and preview, and preserve independent access when file bytes deduplicate. [Duplicate a card with an image cover][board-cover] · task 4.11 |
| [Upstream attachment viewers][up-attachment-viewers]. Dedicated PDF, CSV and text-content previews. | Planner attachment download and image thumbnail actions. | Planner 0.1.0 acceptance covers authorized downloads and supported image variants. Dedicated document viewers are outside that acceptance. [Content, filters and files][workspace-files] · task 4.11 |
| [Board filters][up-filters]. Text and label/member/list filters and recall of saved filters. | `boards.cards`, search and saved filter actions. | Apply permissions before search and counts. Check positive/negative labels, direct/task assignees, unassigned cards, invalid-pattern feedback and stable pagination. Recall the saved recipe for the same user and board. [Recall filters for a board][board-filters] · task 4.14 |
| [Comment and subscription routes][up-routes] and [action fan-out][up-actions]. Comments, mentions, activity, board/card follows and notification read state. | `comments` and `notifications` families, `activity.board/card`, `boards.follow/unfollow`, `cards.follow/unfollow`. | Enforce current comment and moderation permissions, deduplicate a follower who is also mentioned, suppress actor echo, and update eligible unread counts. An imported orphan stays out of the badge. [Follow project activity][board-follow] · task 4.13 |
| [Board frontend][up-board-views] and [action fan-out][up-actions]. Live board updates and reconnect. | `boards.workspace/events`, conflict recovery and reconnect. | Reject a stale competing move, reload the current order, replay eligible events after reconnect and stop delivery when permission is lost. [Two editors move the same card][board-conflict] · [An editor reconnects][board-reconnect] |
| [Board shortcuts][up-shortcuts]. Keyboard board actions and card cut/copy/paste. | Keyboard move and focus controls, cut/copy/paste routed to `cards.move/duplicate`. | Complete a move without a pointer and announce its outcome. Recheck permissions on paste, clear a successful cut, duplicate once per deliberate paste, and verify focus and status on narrow and desktop screens. [Reorder without a pointer][board-keyboard] · tasks 4.15–4.16 |
| [Markdown editor][up-editor]. Unsaved-description recovery. | Card description draft restore, save and discard. | Recover the user/card-scoped draft within its lifetime, offer the stale-draft choices after a revision change, and clear the draft on save or discard. [Save and revisit a detailed card][board-details] · task 4.16 |

### Accounts, migration and integration

| Source or Planner capability | Planner operation or action | Acceptance or release scope |
| --- | --- | --- |
| [Upstream access tokens][up-tokens] and [user security controllers][up-users]. Local login/logout, TOTP challenges, recovery codes and trusted devices. | `/session`, `/recovery/consume`, `/mfa/enrollment` and `/me` security operations under `/api/v1`. | End a browser session and its streams. For an imported MFA account permit enrollment only until new MFA succeeds. Consume recovery codes once and recheck device trust after revocation. [End a session][acct-end] · [Recover an account that used MFA][migration-mfa] · tasks 3.4–3.6 |
| [User controllers][up-users] and [administration screen][up-admin]. Provisioning, role changes, profile/avatar, preferences, credential changes and privileged resets. | `/admin/accounts` and `/me` profile, avatar, password and preferences under `/api/v1`. | Verify identity uniqueness with a nullable username, deny disabled accounts with old membership, protect the last usable admin, and invalidate sessions and grants on credential change. [Recover an imported account][acct-recover] · task 3.5 |
| [Configured site-terms hook][up-terms] and [upstream authentication steps][up-auth-steps]. PLANKA gates login on acceptance of the active terms when the user has no matching signature, with template terms as a fallback for missing custom terms. | Planner uses its approved [account lifecycle and web endpoints][planner-session]. | The upstream site-terms gate is source-only. Source consent is excluded from import. Planner sessions follow password, recovery and required MFA states, with separate consent for a Planner OAuth grant. [Recover an imported account][acct-recover] · [Authorize a client without a manual token][mcp-consent] |
| [Upstream user deletion][up-user-delete]. Permanent account deletion and cascades. | Admin disablement. | Permanent account deletion is deferred. Disabled users lose access, and their historical actor links remain. [Account lifecycle and web endpoints][planner-session] |
| [Upstream board routes][up-routes]. Trello JSON board creation. | Install-time PLANKA migration through `plannerctl migration`. | Trello JSON import is excluded. The supported import input is the declared PLANKA PostgreSQL backup plus corresponding file snapshot. [Check supported snapshots][migration-snapshots] |
| [Upstream API key, webhook and notification routes][up-routes] and [SMTP settings][up-smtp]. External API credentials and delivery integrations. | Local accounts, in-app inbox and Planner OAuth grants. | Source API keys, outgoing webhooks, SMTP and external notification delivery are excluded, with only allowlisted integration metadata in the report. Source passwords, sessions, MFA secrets, trusted devices and integration secrets remain excluded. [Source contains active sessions and integrations][migration-secrets] |
| [Upstream board filter storage][up-filter-storage]. Browser-local preferences and saved filters. | Planner saved filter recall and scoped local description drafts. | A user's new Planner preferences and recipes begin in Planner. Browser-local PLANKA settings are outside the database import. [Recall filters for a board][board-filters] · [Migration mapping][migration-mapping] |
| [Upstream migration ledger][up-migrations], [backup example][up-backup] and [asset configuration][up-assets]. PostgreSQL and a matching copied or versioned file snapshot. | `plannerctl migration prepare/preflight/stage/resume/verify/report`. | Compare the fingerprints of both supported fixtures, preserve IDs/order/timestamps and supported relationships, verify local or object-backed asset digests and retry without duplicates. Classify missing originals, corrupt bytes and stale or orphan relationships separately. [Check supported snapshots][migration-snapshots] · [Compare representative workspaces][migration-compare] · [Import object-backed attachments][migration-object] · [An import stops partway through][migration-retry] |
| [Upstream data models][up-models] and [asset configuration][up-assets]. Reconcile import exceptions, media and access. | `plannerctl migration verify/bootstrap-admin/activate/enable-writes/rollback`, plus approved-missing-assets input. | Keep verified missing originals unavailable after explicit approval and keep historical snapshots while quarantining orphan inbox rows. Bootstrap an eligible admin, prove authorized reads during read-only activation and verify the first-write rollback boundary. [Approve an original file absent from the source][migration-missing] · [Preserve history with a deleted target][migration-history] · [Bootstrap the first administrator on a cold migration][migration-admin] · [Verify an activated snapshot before enabling writes][migration-readonly] |
| Planner-only OAuth and remote MCP. | `/mcp`, account consent and `/me/connections`, workspace tool registry, board/card resources and authorized board subscriptions. | Verify Codex CLI, Codex desktop, Claude Code and a hosted Claude connector on synthetic data. Confirm account/scopes, a permitted read/write, denied read-only edit, actor/client audit and grant revocation. Raw file bytes, permanent destruction, accounts and operator workflows remain in their web/operator routes. [Connect from Codex][mcp-codex] · [Connect from Claude Code][mcp-claude-code] · [Connect from a Claude custom connector][mcp-claude] · [Revoke a live connection][mcp-revoke] |

[up-actions]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/helpers/actions/create-one.js
[up-admin]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/client/src/components/common/AdministrationModal/UsersPane
[up-assets]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/config/custom.js
[up-attachment-viewers]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/client/src/components/attachments/Attachments
[up-attachments]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/controllers/attachments
[up-auth-steps]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/helpers/access-tokens/handle-steps.js
[up-backup]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/docker-backup.sh
[up-board-settings]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/client/src/components/boards/BoardSettingsModal
[up-board-show]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/controllers/boards/show.js
[up-board-views]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/client/src/components/boards/Board
[up-boards]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/controllers/boards
[up-card-inspector]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/client/src/components/cards/CardModal
[up-cards]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/controllers/cards
[up-duplicate]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/helpers/cards/duplicate-one.js
[up-editor]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/client/src/components/common/EditMarkdown/EditMarkdown.jsx
[up-fields]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/controllers/custom-fields
[up-filter-storage]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/client/src/components/boards/BoardActions/useFilterStorage.js
[up-filters]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/client/src/components/boards/BoardActions
[up-home]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/client/src/components/common/Home
[up-list-bulk]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/controllers/lists/move-cards.js
[up-lists]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/controllers/lists
[up-membership-cleanup]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/helpers/board-memberships/delete-one.js
[up-migrations]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/db/migrations
[up-models]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/models
[up-move]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/helpers/cards/update-one.js
[up-project-settings]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/client/src/components/projects/ProjectSettingsModal
[up-projects]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/controllers/projects
[up-routes]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/config/routes.js
[up-shortcuts]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/client/src/components/boards/Board/ShortcutsProvider.jsx
[up-smtp]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/client/src/components/common/AdministrationModal/SmtpPane.jsx
[up-task-lists]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/controllers/task-lists
[up-tasks]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/controllers/tasks
[up-terms]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/hooks/terms/index.js
[up-tokens]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/controllers/access-tokens
[up-user-delete]: https://github.com/plankanban/planka/blob/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/controllers/users/delete.js
[up-users]: https://github.com/plankanban/planka/tree/27219fd3635e695b2ec4e2a9d9ed6bec6560370f/server/api/controllers/users

[acct-end]: ../openspec/changes/launch-planner-v0-1/specs/planner-accounts/spec.md#scenario-end-a-session
[acct-private]: ../openspec/changes/launch-planner-v0-1/specs/planner-accounts/spec.md#scenario-an-administrator-attempts-to-read-an-owner-managed-private-board
[acct-read-remains]: ../openspec/changes/launch-planner-v0-1/specs/planner-accounts/spec.md#scenario-editor-membership-is-removed-while-another-read-grant-remains
[acct-recover]: ../openspec/changes/launch-planner-v0-1/specs/planner-accounts/spec.md#scenario-recover-an-imported-account
[acct-removed]: ../openspec/changes/launch-planner-v0-1/specs/planner-accounts/spec.md#scenario-board-access-is-removed
[acct-shared]: ../openspec/changes/launch-planner-v0-1/specs/planner-accounts/spec.md#scenario-read-a-board-in-an-unowned-shared-project
[acct-viewer]: ../openspec/changes/launch-planner-v0-1/specs/planner-accounts/spec.md#scenario-a-viewer-attempts-to-modify-a-board
[board-clear]: ../openspec/changes/launch-planner-v0-1/specs/kanban-workspace/spec.md#scenario-duplicate-a-card-and-clear-trash
[board-conflict]: ../openspec/changes/launch-planner-v0-1/specs/kanban-workspace/spec.md#scenario-two-editors-move-the-same-card
[board-cover]: ../openspec/changes/launch-planner-v0-1/specs/kanban-workspace/spec.md#scenario-duplicate-a-card-with-an-image-cover
[board-details]: ../openspec/changes/launch-planner-v0-1/specs/kanban-workspace/spec.md#scenario-save-and-revisit-a-detailed-card
[board-filters]: ../openspec/changes/launch-planner-v0-1/specs/kanban-workspace/spec.md#scenario-recall-filters-for-a-board
[board-follow]: ../openspec/changes/launch-planner-v0-1/specs/kanban-workspace/spec.md#scenario-follow-project-activity
[board-keyboard]: ../openspec/changes/launch-planner-v0-1/specs/kanban-workspace/spec.md#scenario-reorder-without-a-pointer
[board-move]: ../openspec/changes/launch-planner-v0-1/specs/kanban-workspace/spec.md#scenario-move-a-card
[board-reconnect]: ../openspec/changes/launch-planner-v0-1/specs/kanban-workspace/spec.md#scenario-an-editor-reconnects
[board-recover]: ../openspec/changes/launch-planner-v0-1/specs/kanban-workspace/spec.md#scenario-recover-archived-work
[board-recover-missing]: ../openspec/changes/launch-planner-v0-1/specs/kanban-workspace/spec.md#scenario-recover-after-the-original-list-was-removed
[board-transfer]: ../openspec/changes/launch-planner-v0-1/specs/kanban-workspace/spec.md#scenario-move-a-card-between-boards
[board-views]: ../openspec/changes/launch-planner-v0-1/specs/kanban-workspace/spec.md#scenario-organize-a-board-across-views
[mcp-claude]: ../openspec/changes/launch-planner-v0-1/specs/planner-mcp/spec.md#scenario-connect-from-a-claude-custom-connector
[mcp-claude-code]: ../openspec/changes/launch-planner-v0-1/specs/planner-mcp/spec.md#scenario-connect-from-claude-code
[mcp-codex]: ../openspec/changes/launch-planner-v0-1/specs/planner-mcp/spec.md#scenario-connect-from-codex
[mcp-consent]: ../openspec/changes/launch-planner-v0-1/specs/planner-mcp/spec.md#scenario-authorize-a-client-without-a-manual-token
[mcp-revoke]: ../openspec/changes/launch-planner-v0-1/specs/planner-mcp/spec.md#scenario-revoke-a-live-connection
[migration-admin]: ../openspec/changes/launch-planner-v0-1/specs/planka-migration/spec.md#scenario-bootstrap-the-first-administrator-on-a-cold-migration
[migration-compare]: ../openspec/changes/launch-planner-v0-1/specs/planka-migration/spec.md#scenario-compare-representative-workspaces
[migration-history]: ../openspec/changes/launch-planner-v0-1/specs/planka-migration/spec.md#scenario-preserve-history-with-a-deleted-target
[migration-mapping]: ../openspec/changes/launch-planner-v0-1/migration.md#table-and-field-mapping
[migration-mfa]: ../openspec/changes/launch-planner-v0-1/specs/planka-migration/spec.md#scenario-recover-an-account-that-used-mfa
[migration-missing]: ../openspec/changes/launch-planner-v0-1/specs/planka-migration/spec.md#scenario-approve-an-original-file-absent-from-the-source
[migration-object]: ../openspec/changes/launch-planner-v0-1/specs/planka-migration/spec.md#scenario-import-object-backed-attachments
[migration-readonly]: ../openspec/changes/launch-planner-v0-1/specs/planka-migration/spec.md#scenario-verify-an-activated-snapshot-before-enabling-writes
[migration-retry]: ../openspec/changes/launch-planner-v0-1/specs/planka-migration/spec.md#scenario-an-import-stops-partway-through
[migration-secrets]: ../openspec/changes/launch-planner-v0-1/specs/planka-migration/spec.md#scenario-source-contains-active-sessions-and-integrations
[migration-snapshots]: ../openspec/changes/launch-planner-v0-1/specs/planka-migration/spec.md#scenario-check-supported-snapshots
[planner-session]: ../openspec/changes/launch-planner-v0-1/access-and-mcp.md#account-lifecycle-and-web-endpoints
[workspace-files]: ../openspec/changes/launch-planner-v0-1/workspace.md#content-filters-and-files
