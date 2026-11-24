import { useEffect, useRef, useState } from 'react';
import type { DescriptionDraft } from './description-drafts.js';

export function DescriptionRecovery({ draft, revision, current, onRecover, onDiscard }: {
  draft: DescriptionDraft; revision: number; current: string | null; onRecover: () => void; onDiscard: () => void;
}) {
  const stale = draft.baseRevision !== revision;
  const [copied, setCopied] = useState(false);
  const [showCopy, setShowCopy] = useState(false);
  const fallback = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (showCopy) { fallback.current?.focus(); fallback.current?.select(); }
  }, [showCopy]);

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(draft.markdown);
      setCopied(true);
    } catch { setShowCopy(true); }
  }

  return <section className="project-confirm card-description-recovery" aria-label="Saved description draft">
    <p>{stale ? 'This card changed since you wrote the local draft.' : 'You have an unsaved description draft from this browser.'}</p>
    {stale && <dl className="draft-comparison">
      <div><dt>Local draft</dt><dd>{draft.markdown ? <pre>{draft.markdown}</pre> : <p>Empty description</p>}</dd></div>
      <div><dt>Current description</dt><dd>{current ? <pre>{current}</pre> : <p>Empty description</p>}</dd></div>
    </dl>}
    <div className="project-actions">
      <button type="button" className="workspace-button" onClick={onRecover}>{stale ? 'Review draft' : 'Recover draft'}</button>
      {stale && <button type="button" className="workspace-button" onClick={() => void copyDraft()}>Copy draft</button>}
      <button type="button" className="workspace-button" onClick={onDiscard}>Discard draft</button>
    </div>
    {copied && <p role="status">Draft copied.</p>}
    {showCopy && <label>Copy this draft<textarea readOnly ref={fallback} value={draft.markdown} /></label>}
  </section>;
}
