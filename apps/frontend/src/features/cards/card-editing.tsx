import { Suspense, lazy, useEffect, useState, type FormEvent } from 'react';
import { useRouteLoaderData } from 'react-router';
import { maximumCardDescriptionLength, type CardStopwatch, type RelationshipCommandInput, type WorkspaceReadOutput } from '@planner/contracts';
import { relationshipCommand } from '../projects/project-api.js';
import { useWorkspaceMutation } from '../projects/project-controls.js';
import { workspaceNavigationId, type loadWorkspaceNavigation } from '../workspace/workspace-loaders.js';
import type { EditorMode } from './card-markdown.js';
import { clearDescriptionDraft } from './description-drafts.js';
import { DescriptionRecovery } from './description-recovery.js';
import { useDescriptionDraft } from './use-description-draft.js';
import './card-editor.css';

const CardDescription = lazy(async () => ({ default: (await import('./card-markdown.js')).CardDescription }));
const CardMarkdownInput = lazy(async () => ({ default: (await import('./card-markdown.js')).CardMarkdownInput }));

type Card = WorkspaceReadOutput<'cardGet'>['data'];
type Update = Omit<RelationshipCommandInput<'cards.update'>, 'id' | 'expectedRevision'>;
type CardFields = Required<Pick<Update, 'name' | 'type' | 'description' | 'dueDate' | 'dueDateCompleted' | 'closed'>>;
type Draft = { revision: number; baseline: CardFields; values: Partial<CardFields> };

function cardDraft(revision: number, baseline: CardFields, values: Partial<CardFields>): Draft | null {
  const changed = Object.fromEntries(Object.entries(values)
    .filter(([key, value]) => value !== baseline[key as keyof CardFields])) as Partial<CardFields>;
  if ((changed.dueDate === undefined ? baseline.dueDate : changed.dueDate) === null) delete changed.dueDateCompleted;
  return Object.keys(changed).length ? { revision, baseline, values: changed } : null;
}
const options = { project: 'Project', story: 'Story' } as const;
const errors = new Map([
  ['CARD_TYPE_RESTRICTED', 'This board does not allow the selected card type.'],
  ['CARD_DUE_DATE_REQUIRED', 'Set a due date before changing its completion.'],
  ['CARD_STOPWATCH_STATE', 'The stopwatch changed. Review it before trying again.'],
]);

function dateInput(value: string | null) {
  return value?.slice(0, 16) ?? '';
}

function renderedElapsed(watch: CardStopwatch, now: number) {
  const elapsed = watch?.startedAt ? Math.max(0, Math.floor((now - Date.parse(watch.startedAt)) / 1000)) : 0;
  const total = (watch?.total ?? 0) + elapsed;
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map((part) => String(part).padStart(2, '0')).join(':');
}

function Stopwatch({ watch, busy, onAction }: {
  watch: CardStopwatch; busy?: boolean; onAction?: (action: NonNullable<Update['stopwatchAction']>) => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!watch?.startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [watch?.startedAt]);
  return <section className="card-stopwatch" aria-label="Stopwatch">
    <strong>Stopwatch</strong><span aria-label="Elapsed time" className="card-elapsed">{renderedElapsed(watch, now)}</span>
    {onAction && <div className="project-actions">
      <button type="button" className="workspace-button" disabled={busy} onClick={() => onAction(watch?.startedAt ? 'stop' : 'start')}>
        {watch?.startedAt ? 'Stop stopwatch' : 'Start stopwatch'}
      </button>
      <button type="button" className="workspace-button" disabled={busy || (!watch?.startedAt && !watch?.total)}
        onClick={() => onAction('reset')}>Reset stopwatch</button>
    </div>}
  </section>;
}

type Props = { card: Card; restriction?: Card['type'] | null; draftScope?: string };

export function CardEditing({ card, restriction, draftScope }: Props) {
  if (card.permissions.canEdit) return <EditableCard card={card} restriction={restriction} draftScope={draftScope} />;
  return <div className="card-readonly-content">
    <dl>
      <div><dt>Card type</dt><dd>{options[card.type]}</dd></div>
      <div><dt>Status</dt><dd>{card.closed ? 'Closed' : 'Open'}</dd></div>
      {card.type === 'project' && card.dueDate && <div><dt>Due date (UTC)</dt>
        <dd><time dateTime={card.dueDate}>{card.dueDate.slice(0, 16).replace('T', ' ')}</time>{card.dueDateCompleted && ' · Complete'}</dd>
      </div>}
    </dl>
    {card.description && <Suspense fallback={<p role="status">Loading description…</p>}><CardDescription description={card.description} /></Suspense>}
    {card.type === 'project' && card.stopwatch && <Stopwatch watch={card.stopwatch} />}
  </div>;
}

function EditableCard({ card, restriction, draftScope }: Props) {
  const action = useWorkspaceMutation(errors, 'This card or your access changed. Review the current information and try again.',
    'Check the card’s title, description and due date.');
  const navigation = useRouteLoaderData<Awaited<ReturnType<typeof loadWorkspaceNavigation>>>(workspaceNavigationId);
  const [editorMode, setEditorMode] = useState<EditorMode>();
  const [draft, setDraft] = useState<Draft | null>(null);
  const dirty = draft?.values;
  const { id, revision } = card;
  const draftKey = draftScope ? draftScope + '/' + id : undefined;
  const descriptionDraft = useDescriptionDraft(draftKey);
  const current: CardFields = {
    name: card.name, type: card.type, description: card.description, dueDate: card.dueDate, dueDateCompleted: card.dueDateCompleted ?? false, closed: card.closed,
  };
  const effective = { ...current, ...dirty };
  const stale = draft !== null && draft.revision !== revision;
  const editor = editorMode ?? navigation?.preferences.preferences.editorMode ?? 'wysiwyg';
  const dirtyValues = Object.fromEntries(Object.entries(dirty ?? {}).filter(([key, value]) => value !== current[key as keyof typeof current])) as Update;
  if (dirtyValues.name !== undefined) {
    if (dirtyValues.name.trim() === current.name) delete dirtyValues.name;
    else dirtyValues.name = dirtyValues.name.trim();
  }
  if (effective.dueDate == null) delete dirtyValues.dueDateCompleted;
  const valid = dirtyValues.name !== '' && (dirtyValues.name?.length ?? 0) <= 128
    && (dirtyValues.description?.length ?? 0) <= maximumCardDescriptionLength;
  const edit = <K extends keyof CardFields>(key: K, value: CardFields[K]) => {
    setDraft((old) => cardDraft(old?.revision ?? revision, old?.baseline ?? current, { ...old?.values, [key]: value }));
  };

  function update(body: Update, expected: number, done: (revision: number) => void, storedVersion?: string) {
    void action.run(['cards.update', id, expected, body], async (csrf, key) => {
      const result = await relationshipCommand('cards.update', csrf, key, { id, revision: expected, body });
      if (result && draftKey && storedVersion) void clearDescriptionDraft(draftKey, storedVersion);
      return result;
    },
    (result) => { if (result) done(result.data.card.revision); });
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !valid || !Object.keys(dirtyValues).length || stale) return;
    const stored = Object.hasOwn(dirtyValues, 'description') ? descriptionDraft.active : undefined;
    update(dirtyValues, draft.revision, () => { descriptionDraft.forget(stored?.version); setDraft(null); }, stored?.version);
  }

  const allowedTypes = restriction && restriction !== current.type ? [current.type, restriction] : restriction ? [restriction] :
    (['project', 'story'] as const);
  return <div className="card-editing">
    {descriptionDraft.offer && <DescriptionRecovery draft={descriptionDraft.offer} revision={revision} current={card.description}
      onRecover={() => {
        const saved = descriptionDraft.offer!;
        descriptionDraft.recover(saved);
        setEditorMode(saved.mode);
        setDraft((old) => cardDraft(saved.baseRevision, old?.baseline ?? current, { ...old?.values, description: saved.markdown || null }));
      }} onDiscard={() => descriptionDraft.clear(descriptionDraft.offer?.version)} />}
    {action.problem && (!stale || action.problemCode !== 'REVISION_CONFLICT') && <p className="workspace-problem" role="alert">{action.problem}</p>}
    {stale && <div className="project-confirm">
      <p>The card changed while you were editing. Your edits are still here.</p>
      <details><summary>Current saved description</summary>{card.description ? <pre>{card.description}</pre> : <p>Empty description</p>}</details>
      <div className="project-actions">
        <button type="button" className="workspace-button" onClick={() => {
          descriptionDraft.recordEditor({ baseRevision: revision });
          setDraft(cardDraft(revision, current, draft.values));
          action.clearProblem();
        }}>Keep edits and use current revision</button>
        <button type="button" className="workspace-button" onClick={() => {
          descriptionDraft.clear(descriptionDraft.active?.version); setDraft(null); action.clearProblem();
        }}>Discard edits</button>
      </div>
    </div>}
    <form className="project-form" onSubmit={save} aria-label="Edit card">
      <fieldset className="card-editing-fields" disabled={action.busy}>
        <label>Card name<input required value={effective.name} maxLength={Math.max(128, card.name.length)}
          onChange={(event) => edit('name', event.target.value)} /></label>
        <label>Card type<select value={effective.type} onChange={(event) => edit('type', event.target.value as Card['type'])}>
          {allowedTypes.map((type) => <option key={type} value={type}>{options[type]}</option>)}
        </select></label>
        <label className="board-checkbox"><input type="checkbox" checked={effective.closed}
          onChange={(event) => edit('closed', event.target.checked)} />Card closed</label>
        {effective.type === 'project' && <fieldset className="board-option-set">
          <legend>Due date</legend>
          <label>Due date and time (UTC)<input type="datetime-local" value={dateInput(effective.dueDate)}
            onChange={(event) => {
              const next = event.target.valueAsNumber;
              edit('dueDate', Number.isNaN(next) ? null : new Date(next).toISOString());
            }} /></label>
          {effective.dueDate && <label className="board-checkbox"><input type="checkbox" checked={dirty?.dueDateCompleted ?? effective.dueDateCompleted}
            onChange={(event) => edit('dueDateCompleted', event.target.checked)} />Due date complete</label>}
        </fieldset>}
        <Suspense fallback={<p role="status">Loading description editor…</p>}>
          <CardMarkdownInput value={effective.description ?? ''} original={current.description ?? ''} mode={editor} boardId={card.boardId} disabled={action.busy}
            onMode={(mode) => { setEditorMode(mode); descriptionDraft.recordEditor({ mode }); }}
            onChange={(value) => {
              const next = value || null;
              if ((draft ? draft.baseline.description : current.description) === next) descriptionDraft.clear(descriptionDraft.active?.version);
              else descriptionDraft.write(value, draft?.revision ?? revision, editor);
              edit('description', next);
            }} />
        </Suspense>
      </fieldset>
      {!valid && <p className="workspace-problem" role="status">Use up to 128 characters in the title and {maximumCardDescriptionLength} in the description.</p>}
      {descriptionDraft.active && !stale && <button type="button" className="workspace-button" disabled={action.busy} onClick={() => {
        descriptionDraft.clear(descriptionDraft.active?.version);
        setDraft((old) => {
          if (!old) return old;
          const { description: _description, ...values } = old.values;
          return cardDraft(old.revision, old.baseline, values);
        });
      }}>Discard description draft</button>}
      <button type="submit" className="workspace-button workspace-button-primary"
        disabled={action.busy || stale || !valid || !Object.keys(dirtyValues).length}>Save card</button>
    </form>
    {card.type === 'project' && <Stopwatch watch={card.stopwatch} busy={action.busy} onAction={(stopwatchAction) => {
      update({ stopwatchAction }, revision, (next) => {
        if (descriptionDraft.active?.baseRevision === revision) descriptionDraft.recordEditor({ baseRevision: next });
        setDraft((old) => old?.revision === revision ? { ...old, revision: next } : old);
      });
    }} />}
  </div>;
}
