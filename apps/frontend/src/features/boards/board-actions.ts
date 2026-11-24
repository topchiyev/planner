import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { workspaceSignInPath } from '@planner/contracts';
import { useWorkspaceMutation } from '../projects/project-controls.js';
import { readWorkspace, WorkspaceRequestError } from '../workspace/workspace-api.js';
import { projectHref } from '../workspace/workspace-navigation.js';
import './board-management.css';

const errors = new Map([
  ['BOARD_ORDER_CONFLICT', 'The board order changed. Review the current order and try again.'],
  ['BOARD_DELETE_DATA_LIMIT', 'This board has imported data too large to preserve during deletion.'],
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
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  return async (projectId: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    let path = '/workspace';
    try {
      await readWorkspace('projectGet', projectId, undefined, controller.signal);
      path = projectHref(projectId);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof WorkspaceRequestError && error.status === 401) {
        window.location.replace(workspaceSignInPath(pathname + search));
        return;
      }
    }
    if (!controller.signal.aborted) await navigate(path, { replace: true });
  };
}
