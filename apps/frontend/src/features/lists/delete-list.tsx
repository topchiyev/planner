import { useState } from 'react';
import type { RelationshipCommandInput } from '@planner/contracts';
import { relationshipCommand } from '../projects/project-api.js';
import { WorkspaceDialog } from '../projects/project-controls.js';
import { useCardPlacementMutation, type PlacementWorkspace } from '../cards/card-placement.js';
import type { BoardList } from './board-lists.js';

export function DeleteList({ workspace, list }: { workspace: PlacementWorkspace; list: BoardList }) {
  const [open, setOpen] = useState(false);
  const action = useCardPlacementMutation();
  const trash = workspace.lists.find(({ kind }) => kind === 'trash');
  if (!trash) return null;
  const body: Omit<RelationshipCommandInput<'lists.delete'>, 'id' | 'expectedRevision'> = {
    sourceOrderVersion: list.orderVersion, trashOrderVersion: trash.orderVersion, boardOrderVersion: workspace.orderVersion,
  };

  return <>
    <button className="workspace-button" type="button" aria-label={'Delete list ' + list.name}
      onClick={() => { action.clearProblem(); setOpen(true); }}>Delete list</button>
    {open && <WorkspaceDialog title="Delete list" busy={action.busy} onClose={() => setOpen(false)}>
      <p>Delete <strong>{list.name}</strong>? Its cards will move to Trash.</p>
      {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
      <button className="workspace-button workspace-button-danger" type="button" disabled={action.busy}
        onClick={() => void action.run(['lists.delete', list.id, list.revision, body], (csrf, key) =>
          relationshipCommand('lists.delete', csrf, key, { id: list.id, revision: list.revision, body }),
        () => setOpen(false))}>Confirm list deletion</button>
    </WorkspaceDialog>}
  </>;
}
