import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useRevalidator, useRouteLoaderData } from 'react-router';
import { workspaceSignInPath } from '@planner/contracts';
import type { loadBrowserSession } from '../auth/browser-session.js';
import { WorkspaceRequestError } from '../workspace/workspace-api.js';
import './project-settings.css';

const projectErrors = new Map<string, string>([
  ['PROJECT_NOT_EMPTY', 'This project has boards. Remove them before deleting the project.'],
  ['PROJECT_NAME_MISMATCH', 'Enter the project name exactly as displayed.'],
  ['INELIGIBLE_ACCOUNT', 'That account cannot manage this project.'],
  ['LAST_PROJECT_MANAGER', 'Keep at least one project manager.'],
  ['OWNER_REQUIRES_SOLE_MANAGER', 'Keep exactly one eligible manager to make this project private.'],
  ['INVALID_PROJECT_BACKGROUND', 'Choose an available image from this project.'],
]);

export function useWorkspaceMutation(errors: ReadonlyMap<string, string>, changed: string,
  invalid = 'Check the information and try again.') {
  const session = useRouteLoaderData<Awaited<ReturnType<typeof loadBrowserSession>>>('app-shell');
  const revalidator = useRevalidator();
  const { pathname, search } = useLocation();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const pending = useRef(false);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return {
    busy, problem, clearProblem: () => setProblem(''), actorId: session?.account.id,
    run: async <T,>(input: readonly unknown[], execute: (csrf: string, key: string) => Promise<T>, done?: (result: T) => void | Promise<void>, refresh = true) => {
      if (!session || pending.current) return;
      pending.current = true;
      setBusy(true);
      setProblem('');
      try {
        const signature = JSON.stringify(input);
        if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
        const result = await execute(session.csrfToken, attempt.current.key);
        attempt.current = null;
        if (!mounted.current) return;
        await done?.(result);
        if (refresh) await revalidator.revalidate();
      } catch (error) {
        if (!mounted.current) return;
        if (error instanceof WorkspaceRequestError) {
          if (error.status === 401) { window.location.replace(workspaceSignInPath(pathname + search)); return; }
          if (error.status === 409 || error.status === 403 || error.status === 404) {
            setProblem(errors.get(String(error.code)) ?? changed);
            await revalidator.revalidate();
            return;
          }
          setProblem(errors.get(String(error.code)) ?? (error.status === 413 ? 'Choose an image up to 32 MiB.'
            : error.status === 415 || error.status === 422 ? invalid
              : 'Planner could not save this change. Try again.'));
        } else setProblem('Planner could not save this change. Try again.');
      } finally {
        pending.current = false;
        if (mounted.current) setBusy(false);
      }
    },
  };
}

export function useProjectAction() {
  return useWorkspaceMutation(projectErrors, 'This project or your access changed. Current information has been loaded.',
    'Check the project details or choose a supported image.');
}

export { WorkspaceDialog as ProjectDialog };

export function WorkspaceDialog({ title, children, onClose, busy = false }: {
  title: string; children: ReactNode; onClose: () => void; busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const instance = dialog.current;
    const opener = document.activeElement;
    instance?.showModal();
    return () => {
      instance?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return <dialog ref={dialog} className="project-dialog" aria-label={title} onCancel={(event) => {
    event.preventDefault();
    if (!busy) onClose();
  }}>
    <header className="project-dialog-heading"><h2>{title}</h2>
      <button type="button" className="workspace-button" disabled={busy} onClick={onClose}>Close</button>
    </header>
    {children}
  </dialog>;
}
