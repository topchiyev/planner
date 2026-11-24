import { useEffect, useRef, useState } from 'react';
import { Node } from '@tiptap/core';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { cardMentionToken, maximumCardDescriptionLength } from '@planner/contracts';
import { publicIdSchema } from '@planner/contracts/storage';
import { MemberPicker, type Mention } from '../affiliations/member-picker.js';

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
    immediatelyRender: false, extensions, content: description, contentType: 'markdown', editable: false,
    editorProps: { attributes: { class: 'card-rendered-description' } },
  });
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.setContent(description, { contentType: 'markdown', emitUpdate: false });
  }, [editor, description]);
  return <EditorContent editor={editor} />;
}

export function CardMarkdownInput({ value, original, mode, boardId, disabled, onMode, onChange }: {
  value: string; original: string; mode: EditorMode; boardId: string; disabled: boolean;
  onMode: (mode: EditorMode) => void; onChange: (value: string) => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  return <div className="card-description-editor">
    <div className="project-actions" role="group" aria-label="Description editor mode">
      <button type="button" className="workspace-button" aria-pressed={mode === 'wysiwyg'} onClick={() => onMode('wysiwyg')}>Rich text</button>
      <button type="button" className="workspace-button" aria-pressed={mode === 'markup'} onClick={() => onMode('markup')}>Markdown</button>
    </div>
    {mode === 'wysiwyg' ? <RichInput value={value} boardId={boardId} disabled={disabled} onChange={onChange} /> : <>
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

function RichInput({ value, boardId, disabled, onChange }: { value: string; boardId: string; disabled: boolean; onChange: (value: string) => void }) {
  const emitted = useRef<string | null>(null);
  const editor = useEditor({
    immediatelyRender: false, extensions, content: value, contentType: 'markdown', editable: !disabled,
    editorProps: { attributes: { role: 'textbox', 'aria-label': 'Description', 'aria-multiline': 'true', class: 'card-rich-input' } },
    onUpdate: ({ editor }) => {
      if (disabled) return;
      const source = editor.getMarkdown();
      emitted.current = source;
      onChange(source);
    },
  });

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(!disabled, false);
  }, [editor, disabled]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || value === emitted.current) return;
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
