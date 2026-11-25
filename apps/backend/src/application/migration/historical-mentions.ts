import { mentionTokens } from '@planner/contracts';
import { publicIdSchema, signedInt64TextSchema } from '@planner/contracts/storage';
import { Marked } from 'marked';
import type { ImportRecords } from './staged-records.js';

const markdown = new Marked({ extensions: [{
  name: 'migrationMention',
  level: 'inline',
  start: (source) => source.indexOf('@['),
  tokenizer(source) {
    if (this.lexer.state.inLink) return;
    const match = /^@\[(?:[^\[\]\\\r\n]|\\[\[\]\\])+\]\(([\da-f-]{36})\)/u.exec(source);
    if (!match || !publicIdSchema.safeParse(match[1]).success) return;
    return { type: 'migrationMention', raw: match[0], identifier: match[1] };
  },
}, {
  // Marked handles bare web URLs and angle autolinks. Bare mailto: references also stay literal.
  name: 'migrationMailto',
  level: 'inline',
  start: (source) => /mailto:/iu.exec(source)?.index,
  tokenizer(source) {
    const match = /^mailto:[^\s<>]+/iu.exec(source);
    if (match) return { type: 'migrationMailto', raw: match[0] };
  },
}] });

function structuredText(text: string) {
  const first = text.trimStart()[0];
  if (first !== '{' && first !== '[' && first !== '"') return false;
  try { JSON.parse(text); return true; } catch { return false; }
}

function mentionsInText(text: string) {
  const candidates = mentionTokens(text);
  if (candidates.length === 0 || structuredText(text)) return [];

  // Marked normalizes container indentation. Probe with distinct UUIDs and retain the original
  // offsets so the rewrite preserves every source byte outside a recognized ID.
  const occupied = new Set(text.match(/00000000-0000-4000-8000-[\da-f]{12}/gu));
  const probes: { marker: string; token: (typeof candidates)[number] }[] = [];
  const chunks: string[] = [];
  let after = 0;
  let next = 0;
  for (const token of candidates) {
    if (!signedInt64TextSchema.safeParse(token.identifier).success) continue;
    let marker: string;
    do { marker = '00000000-0000-4000-8000-' + (next++).toString(16).padStart(12, '0'); }
    while (occupied.has(marker));
    probes.push({ marker, token });
    chunks.push(text.slice(after, token.identifierStart), marker);
    after = token.end - 1;
  }
  if (probes.length === 0) return [];

  const seen = new Set<string>();
  const source = chunks.join('') + text.slice(after);
  markdown.walkTokens(markdown.lexer(source), (token) => {
    if (token.type === 'migrationMention' && typeof token.identifier === 'string') seen.add(token.identifier);
  });
  return probes.filter(({ marker }) => seen.has(marker)).map(({ token }) => token);
}

/** Rewrite the ID only. A source text never becomes a delivery event during staging. */
export async function rewriteImportedMentions(text: string, store: Pick<ImportRecords, 'resolve'>) {
  const resolved = new Map<string, string | null>();
  const chunks: string[] = [];
  let after = 0;
  for (const token of mentionsInText(text)) {
    if (!resolved.has(token.identifier)) resolved.set(token.identifier, await store.resolve('user_account', token.identifier));
    const id = resolved.get(token.identifier);
    if (!id) continue;
    chunks.push(text.slice(after, token.identifierStart), id);
    after = token.end - 1;
  }
  return chunks.length > 0 ? chunks.join('') + text.slice(after) : text;
}
