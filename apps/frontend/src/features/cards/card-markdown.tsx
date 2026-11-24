import { useEffect, useRef, useState } from 'react';
import { useLocation, useRevalidator } from 'react-router';
import { Node } from '@tiptap/core';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { cardMentionToken, maximumCardDescriptionLength, workspaceSignInPath, type RelationshipReadOutput } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import { readAffiliation } from '../projects/project-api.js';
import { WorkspaceRequestError } from '../workspace/workspace-api.js';
import './card-editor.css';

type Mention = RelationshipReadOutput<'boards.mentionMembers'>['data'][number];
export type EditorMode = 'markup' | 'wysiwyg';

const mention = /^@\[((?:\\[\\[\]]|[^\\[\]\r\n])*)\]\(([\da-f-]{36})\)/u;
const displayName = (person: Mention) => person.username || person.name;

const PlannerMention = Node.create({
  name: 'plannerMention',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({ id: { default: null }, label: { default: '' } }),
  renderHTML: ({ node }) => ['span', { class: 'card-mention' }, '@' + String(node.attrs.label)],
  renderText: ({ node }) => '@' + String(node.attrs.label),
  markdownTokenizer: {
    name: 'plannerMention', level: 'inline', start: (source) => source.indexOf('@['),
    tokenize(source) {
      const match = mention.exec(source);
      if (!match || !publicIdSchema.safeParse(match[2]).success) return;
      return { type: 'plannerMention', raw: match[0], id: match[2], label: match[1].replace(/\\([\\[\]])/gu, '$1') };
    },
  },
  parseMarkdown: (token, helpers) => helpers.createNode('plannerMention', { id: token.id, label: token.label }),
  renderMarkdown: (node) => cardMentionToken({ id: String(node.attrs?.id), name: String(node.attrs?.label), username: null }),
});

function webUrl(value: string) {
  if (!/^https?:\/\//iu.test(value) || /[\s\p{Cc}]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password;
  } catch {
    return false;
  }
}

function inertHtmlTokenizer() {
  const { instance } = new MarkdownManager();
  const tokenizer = new instance.Tokenizer();
  const blockHtml = tokenizer.html.bind(tokenizer);
  const inlineHtml = tokenizer.tag.bind(tokenizer);
  const literal = (raw: string) => ({ type: 'escape', raw, text: raw });
  return Object.assign(tokenizer, {
    html(source: string) {
      const match = blockHtml(source);
      if (match) return { type: 'paragraph', raw: match.raw, text: match.raw, tokens: [literal(match.raw)] };
    },
    tag(source: string) {
      const state = tokenizer.lexer.state;
      const { inLink, inRawBlock } = state;
      const match = inlineHtml(source);
      // The HTML tokenizer normally enters anchor and raw-text modes. Its result here is ordinary text.
      Object.assign(state, { inLink, inRawBlock });
      if (match) return literal(match.raw);
    },
  });
}

const extensions = [
  StarterKit.configure({ underline: false, link: { openOnClick: false, autolink: false, linkOnPaste: false, isAllowedUri: webUrl } }),
  Markdown.configure({ markedOptions: { tokenizer: inertHtmlTokenizer() } }),
  PlannerMention,
];

export function CardDescription({ description }: { description: string }) {
  const editor = useEditor({
    extensions, content: description, contentType: 'markdown', editable: false,
    editorProps: { attributes: { class: 'card-rendered-description' } },
  });
  useEffect(() => {
    editor?.commands.setContent(description, { contentType: 'markdown', emitUpdate: false });
  }, [editor, description]);
  return <EditorContent editor={editor} />;
}

export function CardMarkdownInput({ value, original, mode, boardId, onMode, onChange }: {
  value: string; original: string; mode: EditorMode; boardId: string;
  onMode: (mode: EditorMode) => void; onChange: (value: string) => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  return <div className="card-description-editor">
    <div className="project-actions" role="group" aria-label="Description editor mode">
      <button type="button" className="workspace-button" aria-pressed={mode === 'wysiwyg'} onClick={() => onMode('wysiwyg')}>Rich text</button>
      <button type="button" className="workspace-button" aria-pressed={mode === 'markup'} onClick={() => onMode('markup')}>Markdown</button>
    </div>
    {mode === 'wysiwyg' ? <RichInput value={value} boardId={boardId} onChange={onChange} /> : <>
      <label>Description<textarea ref={textarea} rows={6} value={value} maxLength={Math.max(maximumCardDescriptionLength, original.length)}
        onChange={(event) => onChange(event.target.value)} /></label>
      <MemberPicker boardId={boardId} select={(person) => {
        const input = textarea.current;
        if (!input) return;
        const { selectionStart, selectionEnd } = input;
        const token = cardMentionToken(person);
        const next = value.slice(0, selectionStart) + token + value.slice(selectionEnd);
        if (next.length > maximumCardDescriptionLength) return;
        onChange(next);
        requestAnimationFrame(() => { input.focus(); input.setSelectionRange(selectionStart + token.length, selectionStart + token.length); });
      }} />
    </>}
  </div>;
}

function RichInput({ value, boardId, onChange }: { value: string; boardId: string; onChange: (value: string) => void }) {
  const emitted = useRef<string | null>(null);
  const editor = useEditor({
    extensions, content: value, contentType: 'markdown',
    editorProps: { attributes: { role: 'textbox', 'aria-label': 'Description', 'aria-multiline': 'true', class: 'card-rich-input' } },
    onUpdate: ({ editor }) => {
      const source = editor.getMarkdown();
      emitted.current = source;
      onChange(source);
    },
  });

  useEffect(() => {
    if (!editor || value === emitted.current) return;
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
    emitted.current = value;
  }, [editor, value]);

  return <>
    <div className="project-actions" role="group" aria-label="Text formatting">
      <button type="button" className="workspace-button" onClick={() => editor?.chain().focus().toggleBold().run()}>Bold</button>
      <button type="button" className="workspace-button" onClick={() => editor?.chain().focus().toggleItalic().run()}>Italic</button>
      <button type="button" className="workspace-button" onClick={() => editor?.chain().focus().toggleBulletList().run()}>Bulleted list</button>
    </div>
    <EditorContent editor={editor} />
    <MemberPicker boardId={boardId} select={(person) => {
      editor?.chain().focus().insertContent({ type: 'plannerMention', attrs: { id: person.id, label: displayName(person) } }).run();
    }} />
  </>;
}

function MemberPicker({ boardId, select }: { boardId: string; select: (person: Mention) => void }) {
  const { pathname, search } = useLocation();
  const revalidator = useRevalidator();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const binding = JSON.stringify([boardId, query, cursor, attempt]);
  const [selected, setSelected] = useState<{ binding: string; page?: RelationshipReadOutput<'boards.mentionMembers'> }>();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ q: query, limit: '10' });
    if (cursor) params.set('cursor', cursor);
    void readAffiliation('boards.mentionMembers', boardId, params, controller.signal)
      .then((page) => { if (!controller.signal.aborted) setSelected({ binding, page }); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof WorkspaceRequestError && error.status === 401) {
          window.location.replace(workspaceSignInPath(pathname + search));
        } else if (error instanceof WorkspaceRequestError && [403, 404].includes(error.status)) {
          setOpen(false);
          void revalidator.revalidate();
        } else setSelected({ binding });
      });
    return () => controller.abort();
  }, [open, boardId, query, cursor, binding, pathname, search]);

  function submit() {
    setQuery(draft.trim());
    setCursor(null);
    setAttempt((value) => value + 1);
  }

  const result = selected?.binding === binding ? selected : undefined;
  const next = result?.page?.page.nextCursor;
  return <div className="card-mention-picker">
    <button className="workspace-button" type="button" aria-expanded={open} onClick={() => {
      if (!open) { setCursor(null); setAttempt((value) => value + 1); }
      setOpen(!open);
    }}>Mention a board member</button>
    {open && <div>
      <label>Find a board member<input type="search" value={draft} maxLength={120} onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} /></label>
      <button type="button" className="workspace-button" onClick={submit}>Find members</button>
      {!result ? <p role="status">Loading board members…</p> : !result.page ? <p>Board members couldn’t load.</p> :
        !result.page.data.length ? <p>No matching board members.</p> : <ul>
          {result.page.data.map((person) => <li key={person.id}>
            <button type="button" className="workspace-button" aria-label={'Mention ' + person.name}
              onClick={() => { select(person); setOpen(false); }}>{person.name}{person.username ? ' · @' + person.username : ''}</button>
          </li>)}
        </ul>}
      {(cursor || next) && <nav aria-label="Mention results pages" className="project-actions">
        {cursor && <button type="button" className="workspace-button" onClick={() => setCursor(null)}>First members page</button>}
        {next && <button type="button" className="workspace-button" onClick={() => setCursor(next)}>Next members page</button>}
      </nav>}
    </div>}
  </div>;
}
