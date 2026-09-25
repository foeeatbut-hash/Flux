/**
 * Полоса над PDF: «К файлу есть N прежних замечаний из Просмотра — перенести».
 *
 * Прежний Просмотр держал замечания в базе, рядом с файлом; новый редактор
 * пишет пометки в сам PDF. Замечания не переносятся молча: человек видит,
 * сколько их, и переносит одной кнопкой. Сами строки в базе остаются
 * (server/routes/pdfMarkupTransfer.ts) — перенос можно откатить версией файла.
 */
import React, { useEffect, useState } from 'react';
import { Btn } from '../ui';
import { openPdf, releasePdf } from '../../import/pdfShared';
import { drawingsFor, type LegacyMarkup, type PageBox } from '../../lib/pdfMarkupTransfer';

const sha256 = async (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map((b) => b.toString(16).padStart(2, '0')).join('');

const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'прежнее замечание'
  : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'прежних замечания' : 'прежних замечаний');

export default function LegacyMarkupBar({ fileId, canWrite, unsaved, onDone }: {
  fileId: string;
  /** Можно ли сейчас писать файл (я держатель или правлю один) */
  canWrite: boolean;
  /** Есть ли несохранённые правки в редакторе: перенос перечитает файл */
  unsaved: () => boolean;
  onDone: (message: string, ok: boolean) => void;
}) {
  const [markups, setMarkups] = useState<LegacyMarkup[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/office/files/${encodeURIComponent(fileId)}/legacy-markups`)
      .then((r) => (r.ok ? r.json() : { markups: [] }))
      .then((j) => { if (alive) setMarkups(Array.isArray(j?.markups) ? j.markups : []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [fileId]);

  if (!markups.length) return null;

  const transfer = async () => {
    if (unsaved()) { onDone('Сначала сохраните свои правки (Ctrl+S): перенос перечитает файл', false); return; }
    setBusy(true);
    let data: ArrayBuffer | null = null;
    try {
      const raw = await fetch(`/api/files/${encodeURIComponent(fileId)}/raw`);
      if (!raw.ok) throw new Error('Файл не прочитался');
      data = await raw.arrayBuffer();
      const baseSha = await sha256(data);
      const doc = await openPdf(data.slice(0));
      const pages: PageBox[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i);
        pages.push({ view: p.view as [number, number, number, number], rotate: Number(p.rotate) || 0 });
      }
      const drawings = markups.flatMap((m) => drawingsFor(m, pages));
      const res = await fetch(`/api/office/files/${encodeURIComponent(fileId)}/legacy-markups/transfer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseSha, ids: markups.map((m) => m.id), drawings }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(j?.error || `сервер ответил ${res.status}`));
      setMarkups([]);
      onDone(`Перенесено в файл: ${j.transferred ?? markups.length}. Прежняя версия файла — в откате`, true);
    } catch (err: any) {
      onDone(`Замечания не перенесены: ${String(err?.message || err)}`, false);
    } finally {
      setBusy(false);
      if (data) void releasePdf(data).catch(() => {});
    }
  };

  return (
    <div role="status" aria-label="Прежние замечания"
      className="flex shrink-0 items-center gap-3 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
      <span className="min-w-0 flex-1">К файлу есть {markups.length} {plural(markups.length)} из Просмотра. В новом редакторе пометки хранятся в самом PDF</span>
      <Btn onClick={transfer} disabled={busy || !canWrite} title={canWrite ? undefined : 'Файл сейчас правит другой сотрудник'}>
        {busy ? 'Переношу…' : 'Перенести в файл'}
      </Btn>
    </div>
  );
}
