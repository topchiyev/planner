import { mentionTokens } from '@planner/contracts';
import { signedInt64TextSchema } from '@planner/contracts/storage';
import type { ImportRecords } from './staged-records.js';

type Span = { start: number; end: number };

function escaped(text: string, start: number) {
  let first = start;
  while (first > 0 && text[first - 1] === '\\') first--;
  return (start - first) % 2 !== 0;
}

function codeBlocks(text: string) {
  const spans: Span[] = [];
  let fence: { start: number; marker: string; quoteDepth: number; listIndent: number } | undefined;
  for (const line of text.matchAll(/^[^\r\n]*/gmu)) {
    let content = line[0];
    let quoteDepth = 0;
    while (true) {
      const quote = /^ {0,3}>[ \t]?/u.exec(content);
      if (!quote) break;
      content = content.slice(quote[0].length);
      quoteDepth++;
    }
    const indent = /^[ \t]*/u.exec(content)![0];
    if (fence && (quoteDepth < fence.quoteDepth || (content.trim() && indent.length < fence.listIndent))) {
      spans.push({ start: fence.start, end: line.index });
      fence = undefined;
    }
    if (fence) {
      const boundary = /^[ \t]*(`{3,}|~{3,})[ \t]*$/u.exec(content);
      if (boundary && boundary[1][0] === fence.marker[0] && boundary[1].length >= fence.marker.length) {
        spans.push({ start: fence.start, end: line.index + line[0].length });
        fence = undefined;
      }
      continue;
    }
    // Opening fences may start at the content column of a list item. Indented code needs no fence.
    const list = /^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])[ \t]+/u.exec(content);
    const listIndent = list?.[0].length ?? 0;
    const boundary = /^ {0,3}(`{3,}|~{3,})/u.exec(content.slice(listIndent));
    if (boundary) {
      fence = { start: line.index, marker: boundary[1], quoteDepth, listIndent };
    } else if (indent.includes('\t') || indent.length >= 4) {
      spans.push({ start: line.index, end: line.index + line[0].length });
    }
  }
  if (fence) spans.push({ start: fence.start, end: text.length });
  return spans;
}

function inlineCode(text: string, fences: Span[]) {
  const spans: Span[] = [];
  const runs = [...text.matchAll(/`+/gu)].filter((run) => !escaped(text, run.index));
  let fence = 0;
  let cursor = 0;
  while (cursor <= runs.length) {
    const end = fences[fence]?.start ?? text.length;
    const section: { start: number; width: number; closes?: number }[] = [];
    while (cursor < runs.length && runs[cursor].index < end) {
      const marker = runs[cursor++];
      section.push({ start: marker.index, width: marker[0].length });
    }
    const next = new Map<number, number>();
    for (let index = section.length - 1; index >= 0; index--) {
      const run = section[index];
      run.closes = next.get(run.width);
      next.set(run.width, index);
    }
    for (let index = 0; index < section.length; index++) {
      const run = section[index];
      if (run.closes === undefined) continue;
      const close = section[run.closes];
      spans.push({ start: run.start, end: close.start + close.width });
      index = run.closes;
    }
    if (!fences[fence]) break;
    while (cursor < runs.length && runs[cursor].index < fences[fence].end) cursor++;
    fence++;
  }
  return spans;
}

function links(text: string, code: Span[]) {
  const brackets: number[] = [];
  const destinations: { start: number; remaining: number }[] = [];
  const spans: Span[] = [];
  let skipped = 0;
  for (let index = 0; index < text.length; index++) {
    const literal = code[skipped];
    if (literal && index === literal.start) {
      index = literal.end - 1;
      skipped++;
      continue;
    }
    const character = text[index];
    if (character === '\\') { index++; continue; }
    const destination = destinations.at(-1);
    if (character === '[') {
      brackets.push(index);
    } else if (character === ']' && brackets.length > 0) {
      const start = brackets.pop()!;
      if (text[index + 1] === '(' && (text[start - 1] !== '@' || escaped(text, start - 1))) {
        destinations.push({ start, remaining: 0 });
      }
    } else if (destination && character === '(') {
      destination.remaining++;
    } else if (destination && character === ')' && --destination.remaining === 0) {
      spans.push({ start: destination.start, end: index + 1 });
      destinations.pop();
    }
  }
  for (const match of text.matchAll(/(?:https?:\/\/|mailto:)[^\s<>]+/giu)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function literalSpans(text: string) {
  const fences = codeBlocks(text);
  const code = [...fences, ...inlineCode(text, fences)].sort((first, second) => first.start - second.start);
  const spans = [...code, ...links(text, code)].sort((first, second) => first.start - second.start || second.end - first.end);
  const combined: Span[] = [];
  for (const span of spans) {
    const previous = combined.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else combined.push(span);
  }
  return combined;
}

function structuredText(text: string) {
  const first = text.trimStart()[0];
  if (first !== '{' && first !== '[' && first !== '"') return false;
  try { JSON.parse(text); return true; } catch { return false; }
}

/** Rewrite the ID only. A source text never becomes a delivery event during staging. */
export async function rewriteImportedMentions(text: string, store: Pick<ImportRecords, 'resolve'>) {
  const candidates = mentionTokens(text);
  if (!candidates.length || structuredText(text)) return text;
  const literals = literalSpans(text);
  const resolved = new Map<string, string | null>();
  const chunks: string[] = [];
  let literal = 0;
  let after = 0;
  for (const token of candidates) {
    while (literals[literal] && literals[literal].end <= token.start) literal++;
    if ((literals[literal] && literals[literal].start < token.end) || !signedInt64TextSchema.safeParse(token.identifier).success) continue;
    if (!resolved.has(token.identifier)) resolved.set(token.identifier, await store.resolve('user_account', token.identifier));
    const id = resolved.get(token.identifier);
    if (!id) continue;
    chunks.push(text.slice(after, token.identifierStart), id);
    after = token.end - 1;
  }
  return chunks.length > 0 ? chunks.join('') + text.slice(after) : text;
}
