import { mentionTokens } from '@planner/contracts';
import { signedInt64TextSchema } from '@planner/contracts/storage';
import type { ImportRecords } from './staged-records.js';

type Span = { start: number; end: number };

function escaped(text: string, start: number) {
  let first = start;
  while (first > 0 && text[first - 1] === '\\') first--;
  return (start - first) % 2 !== 0;
}

function fencedCode(text: string) {
  const spans: Span[] = [];
  let fence: { start: number; marker: string } | undefined;
  for (const line of text.matchAll(/^[^\r\n]*/gmu)) {
    const boundary = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/u.exec(line[0]);
    if (!boundary) continue;
    const [, marker, suffix] = boundary;
    if (!fence) {
      fence = { start: line.index, marker };
    } else if (fence.marker[0] === marker[0] && marker.length >= fence.marker.length && !suffix.trim()) {
      spans.push({ start: fence.start, end: line.index + line[0].length });
      fence = undefined;
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
  const fences = fencedCode(text);
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
