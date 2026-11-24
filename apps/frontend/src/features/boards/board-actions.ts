import { useLocation, useNavigate } from 'react-router';
import { workspaceSignInPath } from '@planner/contracts';
import { useWorkspaceMutation } from '../projects/project-controls.js';
import { readWorkspace, WorkspaceRequestError } from '../workspace/workspace-api.js';
import { projectHref } from '../workspace/workspace-navigation.js';
import './board-management.css';

const errors = new Map([
  ['BOARD_ORDER_CONFLICT', 'The board order changed. Review the current order and try again.'],
  ['BOARD_NAME_MISMATCH', 'Enter the board name exactly as displayed.'],
  ['INELIGIBLE_ACCOUNT', 'That account is unavailable for board membership.'],
  ['RELATIONSHIP_EXISTS', 'This account already belongs to the board.'],
  ['INVALID_MEMBER_ROLE', 'The comment permission must match the board role.'],
]);

export function useBoardMutation() {
  return useWorkspaceMutation(errors, 'This board or your access changed. Review the current information and try again.');
}

export function useReturnFromBoard() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  return async (projectId: string) => {
    let path = '/workspace';
    try {
      await readWorkspace('projectGet', projectId);
      path = projectHref(projectId);
    } catch (error) {
      if (error instanceof WorkspaceRequestError && error.status === 401) {
        window.location.replace(workspaceSignInPath(pathname + search));
        return;
      }
    }
    await navigate(path, { replace: true });
  };
}
