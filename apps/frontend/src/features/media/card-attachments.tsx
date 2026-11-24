import { useState, type FormEvent } from 'react';
import { maximumMediaBytes, mediaNameSchema, safeMediaLink, type WorkspaceReadOutput } from '@planner/contracts';
import { relationshipCommand } from '../projects/project-api.js';
import { useWorkspaceMutation, WorkspaceDialog } from '../projects/project-controls.js';
import { attachmentDownload, attachmentFileForm, attachmentThumbnail, attachmentWrite } from './attachment-api.js';
import './card-media.css';

type Card = WorkspaceReadOutput<'cardGet'>['data'];
type Attachment = Card['attachments'][number];
type Dialog = { kind: 'upload' | 'link' } | { kind: 'rename' | 'remove'; id: string };
type Action = ReturnType<typeof useWorkspaceMutation>;

const errors = new Map([
  ['INVALID_CARD_COVER', 'Choose an available image from this card.'],
  ['INVALID_IMAGE', 'This image could not be opened. Choose an intact image.'],
  ['MEDIA_SIZE', 'Choose a file up to 32 MiB.'],
  ['MEDIA_BUSY', 'Planner is handling other uploads. Try again shortly.'],
]);

export function CardAttachments({ card }: { card: Card }) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const action = useWorkspaceMutation(errors, 'This card, attachment or your access changed. Review the current information and try again.',
    'Check the attachment name, file or link.');
  const editable = card.permissions.canEdit;
  const opened = dialog && 'id' in dialog ? card.attachments.find(({ id }) => id === dialog.id) : undefined;
  const close = () => { setDialog(null); action.clearProblem(); };
  const show = (next: Dialog) => { action.clearProblem(); setDialog(next); };

  function setCover(coverAttachmentId: string | null) {
    const body = { coverAttachmentId };
    void action.run(['cards.update', card.id, card.revision, body], (csrf, key) =>
      relationshipCommand('cards.update', csrf, key, { id: card.id, revision: card.revision, body }));
  }

  return <section className="card-attachments" aria-label="Attachments">
    <h3>Attachments</h3>
    {editable && <div className="project-actions">
      <button className="workspace-button" type="button" disabled={action.busy} onClick={() => show({ kind: 'upload' })}>Add file</button>
      <button className="workspace-button" type="button" disabled={action.busy} onClick={() => show({ kind: 'link' })}>Add link</button>
      {card.coverAttachmentId && <button className="workspace-button" type="button" disabled={action.busy} onClick={() => setCover(null)}>Clear cover</button>}
    </div>}
    {!dialog && action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
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
                aria-label={`Rename ${file.name}`} onClick={() => show({ kind: 'rename', id: file.id })}>Rename</button>
              <button className="workspace-button" type="button" disabled={action.busy}
                aria-label={`Remove ${file.name}`} onClick={() => show({ kind: 'remove', id: file.id })}>Remove</button>
            </>}
          </div>
        </li>;
      })}
    </ul>}
    {editable && (dialog?.kind === 'upload' || dialog?.kind === 'link') &&
      <AttachmentForm card={card} kind={dialog.kind} action={action} close={close} />}
    {editable && dialog?.kind === 'rename' && opened && <AttachmentForm card={card} kind="rename" attachment={opened} action={action} close={close} />}
    {editable && dialog?.kind === 'remove' && opened && <RemoveAttachment attachment={opened} action={action} close={close} />}
  </section>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function AttachmentForm({ card, kind, attachment, action, close }: {
  card: Card; kind: 'upload' | 'link' | 'rename'; attachment?: Attachment; action: Action; close: () => void;
}) {
  const [file, setFile] = useState<{ value: File; selection: string }>();
  const [name, setName] = useState(attachment?.name ?? '');
  const [url, setUrl] = useState('');
  const validName = mediaNameSchema.safeParse(name);
  const href = kind === 'link' ? safeMediaLink(url) : null;
  const tooLarge = !!file && file.value.size > maximumMediaBytes;
  const allowed = kind === 'upload' ? !!file && !tooLarge : validName.success && (kind === 'rename' || !!href);
  const title = kind === 'upload' ? 'Add file' : kind === 'link' ? 'Add link' : 'Rename attachment';

  function save(event: FormEvent) {
    event.preventDefault();
    if (!allowed) return;
    if (kind === 'upload' && file) {
      void action.run(['attachments.addFile', card.id, card.revision, file.selection], (csrf, key) =>
        attachmentWrite('uploadAttachment', card.id, card.revision, csrf, key, attachmentFileForm(file.value)), close);
    } else if (kind === 'link' && validName.success && href) {
      const body = { name: validName.data, url: href };
      void action.run(['attachments.addLink', card.id, card.revision, body], (csrf, key) =>
        attachmentWrite('addLink', card.id, card.revision, csrf, key, body), close);
    } else if (kind === 'rename' && attachment && validName.success) {
      if (validName.data === attachment.name) { close(); return; }
      const body = { name: validName.data };
      void action.run(['attachments.update', attachment.id, attachment.revision, body], (csrf, key) =>
        attachmentWrite('renameAttachment', attachment.id, attachment.revision, csrf, key, body), close);
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
      {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
      <button className="workspace-button workspace-button-primary" type="submit" disabled={!allowed || action.busy}>
        {kind === 'upload' ? 'Upload file' : kind === 'link' ? 'Save link' : 'Save name'}
      </button>
    </form>
  </WorkspaceDialog>;
}

function RemoveAttachment({ attachment, action, close }: { attachment: Attachment; action: Action; close: () => void }) {
  return <WorkspaceDialog title="Remove attachment" onClose={close} busy={action.busy}>
    <p>Remove <strong>{attachment.name}</strong> from this card?</p>
    {action.problem && <p className="workspace-problem" role="alert">{action.problem}</p>}
    <button className="workspace-button workspace-button-danger" type="button" disabled={action.busy}
      onClick={() => void action.run(['attachments.delete', attachment.id, attachment.revision], (csrf, key) =>
        attachmentWrite('removeAttachment', attachment.id, attachment.revision, csrf, key), close)}>Confirm removal</button>
  </WorkspaceDialog>;
}
