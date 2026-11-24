import { useRef, useState, type FormEvent } from 'react';
import { cardMentionToken, commentMentions, maximumCommentLength, type WorkspaceReadOutput } from '@planner/contracts';
import { MemberPicker, type Mention } from '../affiliations/member-picker.js';
import { relationshipCommand } from '../projects/project-api.js';
import { useWorkspaceMutation, WorkspaceDialog } from '../projects/project-controls.js';
import { FeedPagination, FeedTime, useScopedFeed } from './feed.js';

type Card = WorkspaceReadOutput<'cardGet'>['data'];
type Comment = WorkspaceReadOutput<'cardComments'>['data'][number];

function useCommentMutation() {
  return useWorkspaceMutation(new Map(), 'This comment, card or your access changed. Review the current information and try again.',
    'Write a comment before posting it.');
}

function CommentText({ value }: { value: string }) {
  let index = 0;
  const fragments = commentMentions(value).flatMap(({ start, end, label }) => {
    const fragment = [value.slice(index, start), <span className="card-mention" key={start}>@{label}</span>];
    index = end;
    return fragment;
  });
  return <p className="comment-body">{fragments}{value.slice(index)}</p>;
}

function CommentInput({ text, change, boardId, label, focus, disabled }: {
  text: string; change: (value: string) => void; boardId: string; label: string; focus?: boolean; disabled: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  function insert(person: Mention) {
    const area = input.current;
    if (!area) return;
    const token = cardMentionToken(person);
    const start = area.selectionStart;
    const value = text.slice(0, start) + token + text.slice(area.selectionEnd);
    if (value.length > maximumCommentLength) return;
    change(value);
    window.requestAnimationFrame(() => { area.focus(); area.setSelectionRange(start + token.length, start + token.length); });
  }
  return <fieldset className="comment-composer" disabled={disabled}>
    <label>{label}<textarea ref={input} value={text} onChange={(event) => change(event.target.value)} rows={4}
      maxLength={Math.max(maximumCommentLength, text.length)} autoFocus={focus} required /></label>
    <MemberPicker boardId={boardId} select={insert} />
  </fieldset>;
}

export function CardComments({ card }: { card: Card }) {
  const [draft, setDraft] = useState('');
  const [dialog, setDialog] = useState<{ id: string; revision: number; action: 'edit' | 'delete'; text: string }>();
  const { result, cursor, setCursor, retry } = useScopedFeed('cardComments', card.id, card.revision, card.boardId);
  const data = result?.data;
  const action = useCommentMutation();

  function post(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || !card.permissions.canComment || draft.length > maximumCommentLength) return;
    const body = { text: draft };
    void action.run(['comments.create', card.id, card.revision, body], (csrf, key) =>
      relationshipCommand('comments.create', csrf, key, { id: card.id, revision: card.revision, body }),
    () => { setDraft(''); setCursor(undefined); });
  }

  return <section className="workspace-feed" aria-label="Comments">
    <h3>Comments</h3>
    {card.permissions.canComment && <form className="project-form comment-form" onSubmit={post}>
      <CommentInput text={draft} change={setDraft} boardId={card.boardId} label="Write a comment" disabled={action.busy} />
      {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
      <button className="workspace-button workspace-button-primary" type="submit"
        disabled={!draft.trim() || action.busy}>Post comment</button>
    </form>}
    {!result ? <p role="status">Loading comments…</p> : !data
      ? <p role="alert">Comments couldn’t load. <button className="workspace-button" type="button" onClick={retry}>Retry</button></p>
      : <>
        {data.data.length === 0 && <p>No comments.</p>}
        <ol className="feed-entries">
          {data.data.map((comment) => <li key={comment.id}>
            <header><strong>{comment.author?.name ?? 'Unknown author'}</strong> <FeedTime value={comment.createdAt} /></header>
            <CommentText value={comment.text} />
            {(comment.permissions.canEdit || comment.permissions.canDelete) && <div className="project-actions">
              {comment.permissions.canEdit && <button className="workspace-button" type="button"
                onClick={() => setDialog({ id: comment.id, revision: comment.revision, action: 'edit', text: comment.text })}>Edit comment</button>}
              {comment.permissions.canDelete && <button className="workspace-button" type="button"
                onClick={() => setDialog({ id: comment.id, revision: comment.revision, action: 'delete', text: '' })}>Delete comment</button>}
            </div>}
            {dialog?.id === comment.id && comment.permissions[dialog.action === 'edit' ? 'canEdit' : 'canDelete'] &&
              <CommentDialog card={card} comment={comment} action={dialog.action} revision={dialog.revision} text={dialog.text}
                change={(text) => setDialog({ ...dialog, text })} close={() => setDialog(undefined)} />}
          </li>)}
        </ol>
        <FeedPagination cursor={cursor} next={data.page.nextCursor} select={setCursor} />
      </>}
  </section>;
}

function CommentDialog({ card, comment, action, revision, text, change, close }: {
  card: Card; comment: Comment; action: 'edit' | 'delete'; revision: number; text: string;
  change: (value: string) => void; close: () => void;
}) {
  const mutation = useCommentMutation();
  const stale = comment.revision !== revision;
  const updating = action === 'edit';
  const operation = updating ? 'comments.update' : 'comments.delete';
  const title = updating ? 'Edit comment' : 'Delete comment';
  function submit(event: FormEvent) {
    event.preventDefault();
    if (stale || (updating && (!text.trim() || text.length > maximumCommentLength))) return;
    const body = updating ? { text } : undefined;
    void mutation.run([operation, comment.id, revision, body], (csrf, key) =>
      relationshipCommand(operation, csrf, key, { id: comment.id, revision, body }), close);
  }
  return <WorkspaceDialog title={title} onClose={close} busy={mutation.busy}>
    <form className="project-form" onSubmit={submit}>
      {updating ? <CommentInput text={text} change={change} boardId={card.boardId} label="Comment" disabled={mutation.busy || stale} focus />
        : <p>Permanently remove this comment?</p>}
      {(stale || mutation.problem) && <p className="workspace-problem" role="alert">
        {stale ? 'This comment changed. Close and reopen to review the current comment.' : mutation.problem}
      </p>}
      <button className="workspace-button" type="submit" disabled={mutation.busy || stale || (updating && !text.trim())}>
        {updating ? 'Save comment' : 'Confirm deletion'}
      </button>
    </form>
  </WorkspaceDialog>;
}
