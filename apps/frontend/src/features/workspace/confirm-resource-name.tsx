import { useId } from 'react';

// A single-line input cannot round-trip CR/LF, and ordinary text collapses repeated and edge spaces.
export function resourceNameConfirmation(name: string) {
  const special = /[^\S ]|[\p{Cc}\p{Cf}]/u;
  if (name && name.trim() === name && !name.includes('  ') && !special.test(name)) return name;

  const escaped = name.replace(/[\s\p{Cc}\p{Cf}"\\]/gu, (character) => {
    if (character === '\r') return '\\r';
    if (character === '\n') return '\\n';
    if (character === '"' || character === '\\') return '\\' + character;
    return character.split('').map((unit) => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  });
  return '"' + escaped + '"';
}

export function ConfirmResourceName({ resource, name, value, onChange }: {
  resource: 'project' | 'board'; name: string; value: string; onChange: (value: string) => void;
}) {
  const instructions = useId();
  const confirmation = resourceNameConfirmation(name);
  return <>
    <p id={instructions}>
      Enter <code>{confirmation}</code> to permanently delete this {resource}.
      {confirmation !== name && ' Include the quotation marks and type or paste the spaces and line breaks as shown.'}
    </p>
    <label>Confirm {resource} name<input name={`confirm-${resource}-name`} value={value}
      onChange={(event) => onChange(event.target.value)} aria-describedby={instructions} required autoFocus spellCheck={false} /></label>
  </>;
}
