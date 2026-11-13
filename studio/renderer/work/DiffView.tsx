/**
 * Разница одного файла: построчно для текста, «изменён, N байт» для двоичного.
 * Строки считает общий код `modules/trust/diff.ts` (его же использует окно владельца); здесь только показ.
 */
import React, { useMemo } from 'react';
import type { FileChange } from '../../shared/history';

export const FILE_STATUS_TEXT: Record<FileChange['status'], string> = { added: 'Добавлен', removed: 'Удалён', changed: 'Изменён' };
const BINARY_TEXT: Record<FileChange['status'], string> = { added: 'добавлен', removed: 'удалён', changed: 'изменён' };

export const bytesText = (n: number | null) => n === null ? '—' : n < 1024 ? `${n} байт` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} КиБ`;

/** Номер строки — в новом файле; у удалённых строк номера нет */
export function numbered(lines: FileChange['lines']): Array<{ n: number | null; op: string; text: string }> {
  let n = 0;
  return lines.map(l => { if (l.op !== '-') n++; return { n: l.op === '-' ? null : n, op: l.op, text: l.text }; });
}

/** Вокруг каждой правки остаётся по CONTEXT строк, длинные куски без изменений сворачиваются в одну строку-разрыв */
const CONTEXT = 3;
export type DiffRow = { n: number | null; op: string; text: string } | { gap: number };
export function collapse(rows: Array<{ n: number | null; op: string; text: string }>): DiffRow[] {
  const near = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => { if (r.op !== ' ') for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) near[k] = true; });
  const out: DiffRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (near[i]) { out.push(rows[i]); continue; }
    let j = i;
    while (j < rows.length && !near[j]) j++;
    out.push({ gap: j - i });
    i = j - 1;
  }
  return out;
}

export default function DiffView({ file }: { file: FileChange }) {
  const rows = useMemo(() => file.status === 'changed' ? collapse(numbered(file.lines)) : numbered(file.lines), [file]);
  if (file.binary) {
    const size = file.status === 'removed' ? file.sizeBefore : file.sizeAfter;
    return <p className="fx-hint studio-diff-binary" data-testid="diff-binary">Двоичный файл: {BINARY_TEXT[file.status]}, {size ?? 0} байт{file.status === 'changed' && file.sizeBefore !== null ? ` (было ${file.sizeBefore})` : ''}.</p>;
  }
  return (
    <>
      <pre className="studio-diff code" data-testid="diff-code" aria-label={`Разница в ${file.path}`}>
        {rows.map((r, i) => 'gap' in r
          ? <span key={i} className="studio-diff-line studio-diff-gap">{`⋯ ${r.gap} ${r.gap === 1 ? 'строка' : r.gap < 5 ? 'строки' : 'строк'} без изменений`}{'\n'}</span>
          : (
            <span key={i} className={`studio-diff-line${r.op === '+' ? ' add' : r.op === '-' ? ' del' : ''}`}>
              <span className="studio-diff-n">{r.n ?? ''}</span>{`${r.op} ${r.text}`}{'\n'}
            </span>))}
      </pre>
      {file.truncated && <p className="fx-hint">Показаны первые строки разницы: файл изменился сильнее, чем помещается в окно.</p>}
    </>
  );
}
