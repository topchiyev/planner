import { useEffect, useRef, useState } from 'react';
import type { EditorMode } from './card-markdown.js';
import { clearDescriptionDraft, readDescriptionDraft, writeDescriptionDraft, type DescriptionDraft } from './description-drafts.js';

export function useDescriptionDraft(key?: string) {
  const [offer, setOffer] = useState<DescriptionDraft>();
  const [active, setActive] = useState<DescriptionDraft>();
  const edited = useRef<DescriptionDraft>(undefined);

  useEffect(() => {
    if (!key) return;
    let mounted = true;
    void readDescriptionDraft(key).then((draft) => {
      if (mounted && !edited.current) setOffer(draft);
    });
    return () => { mounted = false; };
  }, [key]);

  function recover(draft: DescriptionDraft) {
    edited.current = draft;
    setActive(draft);
    setOffer(undefined);
  }

  function write(markdown: string, baseRevision: number, mode: EditorMode) {
    if (!key || !globalThis.crypto?.randomUUID) return;
    const draft = { markdown, baseRevision, mode, version: crypto.randomUUID(), editedAt: Date.now() };
    recover(draft);
    void writeDescriptionDraft(key, draft);
  }

  function recordEditor(fields: Partial<Pick<DescriptionDraft, 'baseRevision' | 'mode'>>) {
    const current = edited.current;
    if (!key || !current) return;
    const draft = { ...current, ...fields, version: crypto.randomUUID() };
    edited.current = draft;
    setActive(draft);
    void writeDescriptionDraft(key, draft, current.version);
  }

  function forget(version?: string) {
    if (!version) return;
    if (edited.current?.version === version) {
      edited.current = undefined;
      setActive(undefined);
    }
    setOffer((current) => current?.version === version ? undefined : current);
  }

  function clear(version?: string) {
    forget(version);
    if (key && version) void clearDescriptionDraft(key, version);
  }

  return { offer, active, recover, write, recordEditor, clear, forget };
}
