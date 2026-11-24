import { useState, type FormEvent } from 'react';
import { useRevalidator } from 'react-router';
import { maximumMediaBytes, mediaNameSchema, safeMediaLink, type WorkspaceReadOutput } from '@planner/contracts';
import { relationshipCommand } from '../projects/project-api.js';
import { useWorkspaceMutation, WorkspaceDialog } from '../projects/project-controls.js';
import { WorkspaceRequestError } from '../workspace/workspace-api.js';
import { attachmentDownload, attachmentFileForm, attachmentThumbnail, attachmentWrite } from './attachment-api.js';
import './card-media.css';

type Card = WorkspaceReadOutput<'cardGet'>['data'];
type Attachment = Card['attachments'][number];
type Dialog = { kind: 'upload' | 'link'; revision: number } | { kind: 'rename' | 'remove'; id: string; revision: number };
type Action = ReturnType<typeof useWorkspaceMutation>;

const errors = new Map([
  ['INVALID_CARD_COVER', 'Choose an available image from this card.'],
  ['INVALID_IMAGE', 'This image could not be opened. Choose an intact image.'],
  ['MEDIA_SIZE', 'Choose a file up to 32 MiB.'],
  ['MEDIA_TOO_LARGE', 'Choose a file up to 32 MiB.'],
  ['MEDIA_BUSY', 'Planner is handling other uploads. Try again shortly.'],
]);

export function CardAttachments({ card }: { card: Card }) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const revalidator = useRevalidator();
  const action = useWorkspaceMutation(errors, 'This card, attachment or your access changed. Review the current information and try again.',
    'Check the attachment name, file or link.');
  const editable = card.permissions.canEdit;
  const opened = dialog && 'id' in dialog ? card.attachments.find(({ id }) => id === dialog.id) : undefined;
  const hasOpenDialog = dialog && (!('id' in dialog) || !!opened);
  const close = () => { setDialog(null); action.clearProblem(); };
  const show = (next: Dialog) => { action.clearProblem(); setDialog(next); };

  function setCover(coverAttachmentId: string | null) {
    const body = { coverAttachmentId };
    void action.run(['cards.update', card.id, card.revision, body], async (csrf, key) => {
      try {
        return await relationshipCommand('cards.update', csrf, key, { id: card.id, revision: card.revision, body });
      } catch (error) {
        if (error instanceof WorkspaceRequestError && error.code === 'INVALID_CARD_COVER') await revalidator.revalidate();
        throw error;
      }
    });
  }

  return <section className="card-attachments" aria-label="Attachments">
    <h3>Attachments</h3>
    {editable && <div className="project-actions">
      <button className="workspace-button" type="button" disabled={action.busy} onClick={() => show({ kind: 'upload', revision: card.revision })}>Add file</button>
      <button className="workspace-button" type="button" disabled={action.busy} onClick={() => show({ kind: 'link', revision: card.revision })}>Add link</button>
      {card.coverAttachmentId && <button className="workspace-button" type="button" disabled={action.busy} onClick={() => setCover(null)}>Clear cover</button>}
    </div>}
    {!hasOpenDialog && action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
    {card.attachments.length > 0 && <ul className="card-attachment-list" aria-label="Card attachments">
      {card.attachments.map((file) => {
        const cover = file.id === card.coverAttachmentId;
        return <li key={file.id}>
          {file.hasThumbnail && <img className="attachment-thumbnail" src={attachmentThumbnail(file.id)} alt="" loading="lazy" decoding="async" />}
          <div className="attachment-heading">
            <strong>{file.name}</strong>
            {cover && <span className="attachment-status">{file.hasThumbnail ? 'Cover' : 'Cover unavailable'}</span>}
            {!file.available && <span className="attachment-status">{file.kind === 'file' ? 'File unavailable' : 'Link unavailable'}</span>}
            {file.available && file.kind === 'file' && file.byteLength !== null && <span className="attachment-status">{formatBytes(file.byteLength)}</span>}
          </div>
          <div className="project-actions">
            {file.kind === 'file' && file.available && <a className="workspace-button" href={attachmentDownload(file.id)} download
              aria-label={`Download ${file.name}`}>Download</a>}
            {file.kind === 'link' && file.url && <a className="workspace-button" href={file.url} target="_blank" rel="noopener noreferrer"
              aria-label={`Open link ${file.name}`}>Open link</a>}
            {editable && <>
              {file.hasThumbnail && !cover && <button className="workspace-button" type="button" disabled={action.busy}
                aria-label={`Use ${file.name} as cover`} onClick={() => setCover(file.id)}>Use as cover</button>}
              <button className="workspace-button" type="button" disabled={action.busy}
                aria-label={`Rename ${file.name}`} onClick={() => show({ kind: 'rename', id: file.id, revision: file.revision })}>Rename</button>
              <button className="workspace-button" type="button" disabled={action.busy}
                aria-label={`Remove ${file.name}`} onClick={() => show({ kind: 'remove', id: file.id, revision: file.revision })}>Remove</button>
            </>}
          </div>
        </li>;
      })}
    </ul>}
    {editable && (dialog?.kind === 'upload' || dialog?.kind === 'link') &&
      <AttachmentForm card={card} kind={dialog.kind} revision={dialog.revision} action={action} close={close} />}
    {editable && dialog?.kind === 'rename' && opened &&
      <AttachmentForm card={card} kind="rename" attachment={opened} revision={dialog.revision} action={action} close={close} />}
    {editable && dialog?.kind === 'remove' && opened &&
      <RemoveAttachment attachment={opened} revision={dialog.revision} action={action} close={close} />}
  </section>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function AttachmentForm({ card, kind, attachment, revision, action, close }: {
  card: Card; kind: 'upload' | 'link' | 'rename'; attachment?: Attachment; revision: number; action: Action; close: () => void;
}) {
  const [file, setFile] = useState<{ value: File; selection: string }>();
  const [name, setName] = useState(attachment?.name ?? '');
  const [url, setUrl] = useState('');
  const validName = mediaNameSchema.safeParse(name);
  const href = kind === 'link' ? safeMediaLink(url) : null;
  const tooLarge = !!file && file.value.size > maximumMediaBytes;
  const stale = revision !== (attachment?.revision ?? card.revision);
  const allowed = !stale && (kind === 'upload' ? !!file && !tooLarge : validName.success && (kind === 'rename' || !!href));
  const title = kind === 'upload' ? 'Add file' : kind === 'link' ? 'Add link' : 'Rename attachment';

  function save(event: FormEvent) {
    event.preventDefault();
    if (!allowed) return;
    if (kind === 'upload' && file) {
      void action.run(['attachments.addFile', card.id, revision, file.selection], (csrf, key) =>
        attachmentWrite('uploadAttachment', card.id, revision, csrf, key, attachmentFileForm(file.value)), close);
    } else if (kind === 'link' && validName.success && href) {
      const body = { name: validName.data, url: href };
      void action.run(['attachments.addLink', card.id, revision, body], (csrf, key) =>
        attachmentWrite('addLink', card.id, revision, csrf, key, body), close);
    } else if (kind === 'rename' && attachment && validName.success) {
      if (validName.data === attachment.name) { close(); return; }
      const body = { name: validName.data };
      void action.run(['attachments.update', attachment.id, revision, body], (csrf, key) =>
        attachmentWrite('renameAttachment', attachment.id, revision, csrf, key, body), close);
    }
  }

  return <WorkspaceDialog title={title} onClose={close} busy={action.busy}>
    <form className="project-form" onSubmit={save}>
      {kind === 'upload'
        ? <label>File<input type="file" autoFocus required onChange={(event) => {
          const value = event.target.files?.[0];
          setFile(value ? { value, selection: crypto.randomUUID() } : undefined);
        }} /></label>
        : <label>Name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={Math.max(255, attachment?.name.length ?? 0)}
          autoFocus required /></label>}
      {kind === 'link' && <label>URL<input type="url" required maxLength={2048} value={url} onChange={(event) => setUrl(event.target.value)} /></label>}
      {tooLarge && <p className="workspace-problem" role="alert">Choose a file up to 32 MiB.</p>}
      {kind === 'link' && url.length > 0 && !href && <p className="workspace-problem">Enter an HTTP or HTTPS address without credentials.</p>}
      {stale ? <p className="workspace-problem" role="alert">{attachment
        ? <>This attachment changed. Its current name is <strong>{attachment.name}</strong>. Close and reopen to review the change.</>
        : 'This card changed. Close and reopen to review it before adding an attachment.'}</p>
        : action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
      <button className="workspace-button workspace-button-primary" type="submit" disabled={!allowed || action.busy}>
        {kind === 'upload' ? 'Upload file' : kind === 'link' ? 'Save link' : 'Save name'}
      </button>
    </form>
  </WorkspaceDialog>;
}

function RemoveAttachment({ attachment, revision, action, close }: {
  attachment: Attachment; revision: number; action: Action; close: () => void;
}) {
  const stale = attachment.revision !== revision;
  return <WorkspaceDialog title="Remove attachment" onClose={close} busy={action.busy}>
    <p>Remove <strong>{attachment.name}</strong> from this card?</p>
    {(stale || action.problem) && <p className="workspace-problem" role="alert">
      {stale ? 'This attachment changed. Close and reopen to review it before removing it.' : action.problem}
    </p>}
    <button className="workspace-button workspace-button-danger" type="button" disabled={stale || action.busy}
      onClick={() => void action.run(['attachments.delete', attachment.id, revision], (csrf, key) =>
        attachmentWrite('removeAttachment', attachment.id, revision, csrf, key), close)}>Confirm removal</button>
  </WorkspaceDialog>;
}
