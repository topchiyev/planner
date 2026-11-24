# Kanban workspace

## Purpose

Give teams familiar kanban and collaboration workflows in a self-hosted application with its own visual identity.

## ADDED Requirements

### Requirement: Planner release identity
The application SHALL present itself as Planner, expose the release version, and make its supported features available according to account and project permissions without payment, activation, or upgrade prompts.

#### Scenario: An administrator checks the first release
- **WHEN** an administrator installs the first release and opens the application and its version information
- **THEN** the application identifies itself as Planner 0.1.0 and enabled functionality has no paid-tier restrictions or purchase prompts.

### Requirement: Create and organize work
Authorized users SHALL be able to create and manage projects, boards, lists and cards, reorder lists and cards, and move cards between eligible lists and boards. Users SHALL be able to archive and restore supported items.

#### Scenario: Move a card
- **WHEN** an editor moves a card to a permitted list and reloads the board
- **THEN** the card appears once at the saved destination and rank with its associated content intact.

#### Scenario: Recover archived work
- **WHEN** an editor restores an archived card
- **THEN** the active board shows the card again with its metadata and relationships.

#### Scenario: Recover after the original list was removed
- **GIVEN** a card in archive or trash whose previous list no longer exists
- **WHEN** an editor starts restoration
- **THEN** Planner asks for an eligible destination and preserves the card until one is selected.

### Requirement: Offer board views and bulk actions
Planner SHALL offer kanban, grid and list views. Authorized users SHALL be able to duplicate cards, sort finite lists, bulk archive the cards of a closed list on its board, and clear a confirmed trash list.

#### Scenario: Organize a board across views
- **WHEN** an editor sorts a closed list and bulk archives its cards, then opens the archive in grid or list view
- **THEN** the same card IDs appear in archive and no other board's list changes.

#### Scenario: Duplicate a card and clear trash
- **WHEN** an editor duplicates a card and confirms clearing the trash list
- **THEN** the duplicate has its own identity and the clear operation affects only the confirmed trash list.

### Requirement: Edit structured card content
Authorized users SHALL be able to edit supported card types, descriptions, labels, assignees, dates, task groups and tasks, custom fields, attachments, and links between checklist tasks and cards. Planner SHALL support card due-date completion and stopwatch tracking.

#### Scenario: Save and revisit a detailed card
- **WHEN** an editor updates a description, adds a label, assigns a user, sets a due date, and adds a checklist task and an attachment
- **THEN** another eligible viewer can open the card and see the saved values and download the attachment.

### Requirement: Find and follow work
Planner SHALL provide project favorites and board search and filtering. Authorized users SHALL be able to comment, follow supported boards and cards, view activity, and receive in-app notifications for supported events.

#### Scenario: Follow project activity
- **WHEN** a member uses a board filter and opens a followed card after a qualifying update
- **THEN** the filter limits the board as selected, and the member can see the activity and associated notification for the card.

#### Scenario: Recall filters for a board
- **WHEN** a user saves a filter recipe and opens the same board later
- **THEN** that user can explicitly recall it while other account and board views retain their own filters.

### Requirement: Preserve content during transfers and duplication
Planner SHALL check source and destination permissions when transferring or duplicating a card. It SHALL preserve supported content, remap eligible label, field and cover relationships, and remove references that cannot apply at the destination.

#### Scenario: Duplicate a card with an image cover
- **WHEN** a permitted user duplicates a card to an eligible board
- **THEN** the duplicate has its own identity and child references and its cover belongs to that duplicate. Original comments and activity stay with the source.

#### Scenario: Move a card between boards
- **WHEN** an editor transfers a card to a board where one current assignee has no membership
- **THEN** the same card appears at the destination with its supported content, and the ineligible assignment is removed.

### Requirement: Keep collaborative boards consistent
Planner SHALL propagate authorized board updates to connected eligible users and SHALL recover current state after reconnection. It SHALL preserve a consistent card placement and ordering when edits overlap.

#### Scenario: Two editors move the same card
- **WHEN** two editors submit incompatible moves against the same card version
- **THEN** the backend commits a consistent placement and the clients converge on it or receive an explicit conflict and refresh.

#### Scenario: An editor reconnects
- **WHEN** a client reconnects after missing updates
- **THEN** its board reflects the current authorized state without duplicated cards or stale permissions.

### Requirement: Accessible board actions
Planner SHALL provide keyboard-operable alternatives to drag-and-drop and SHALL keep core board and card actions usable at supported desktop and narrow viewport widths.

#### Scenario: Reorder without a pointer
- **WHEN** an editor uses the keyboard to move a card on a board
- **THEN** the card reaches the selected list and rank and the interface communicates the result.
