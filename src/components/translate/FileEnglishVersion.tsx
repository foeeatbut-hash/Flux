/**
 * «Английская версия…» файла Word или Excel: сверка перед выпуском.
 *
 * Ни один документ не уходит заказчику «нажал — получил». Сначала таблица:
 * слева русский абзац или ячейка, справа перевод и откуда он взялся (память
 * проекта, словарь, узоры). Строку можно поправить — правка тут же ложится в
 * память, и следующая ревизия переведётся ею сама.
 *
 * Английская версия — отдельный файл «<имя> (EN)» рядом с оригиналом
 * (server/routes/officeEnglish.ts); оригинал не трогается. Повторный выпуск
 * пишет в тот же файл — ссылку на него могли уже отправить.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn, Dialog, Empty } from '../ui';
import SegmentRows, { type Row } from './SegmentRows';
import { readiness } from '../../translate/engine';
import { useTranslateStore } from '../../store/translateStore';
import { useToastStore } from '../../store/toastStore';
import { editorHref } from '../../lib/officeFiles';

interface Link { sourceId: string; sourceName: string; targetId: string; targetName: string; isSource: boolean; stale: boolean }

export default function FileEnglishVersion({ fileId, name, onClose, beforeIssue }: {
  fileId: string; name: string; onClose: () => void;
  /** Окно редактора записывает несохранённое до выпуска */
  beforeIssue?: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const { addToast } = useToastStore();
  const one = useTranslateStore((s) => s.one);
  const remember = useTranslateStore((s) => s.remember);
  const [keys, setKeys] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [fingerprint, setFingerprint] = useState('');
  const [link, setLink] = useState<Link | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError(''); setRows(null);
    try {
      const l = await fetch(`/api/office/files/${encodeURIComponent(fileId)}/english`).then((r) => r.json());
      setLink(l?.link || null);
      // Открыли перевод — сверка идёт по оригиналу
      const from = l?.link && !l.link.isSource ? l.link.sourceId : fileId;
      if (l?.link && !l.link.isSource) return;
      await beforeIssue?.();
      const r = await fetch(`/api/office/files/${encodeURIComponent(from)}/english/segments`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || `сервер ответил ${r.status}`);
      setKeys((d.segments || []).map((s: any) => s.key));
      setRows((d.segments || []).map((s: any) => one(String(s.text), 'ru', 'en')));
      setFingerprint(String(d.fingerprint || ''));
    } catch (e: any) { setError(String(e?.message || e)); }
  };
  useEffect(() => { void load(); }, [fileId]);

  const ready = useMemo(() => (rows ? readiness(rows) : { ready: 0, total: 0 }), [rows]);

  const change = (i: number, dst: string) => setRows((rs) => rs && rs.map((r, j) => (j === i ? { ...r, dst, ok: true } : r)));
  const confirm = (i: number) => setRows((rs) => rs && rs.map((r, j) => (j === i ? { ...r, ok: true } : r)));

  const issue = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      const pairs: Record<string, string> = {};
      rows.forEach((r, i) => { if (r.dst.trim()) pairs[keys[i]] = r.dst; });
      const r = await fetch(`/api/office/files/${encodeURIComponent(fileId)}/english`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairs, fingerprint }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { addToast(d?.error || `Не выпустилось: сервер ответил ${r.status}`, 'error'); return; }
      // Подтверждённое человеком — в память: следующая ревизия переведётся сама
      const units = rows.filter((x) => x.ok && x.dst.trim()).map((x) => ({ src: x.src, dst: x.dst, from: 'ru' as const, to: 'en' as const, docId: fileId }));
      if (units.length) await remember(units).catch(() => {});
      addToast(d.updated ? `«${d.name}» обновлена` : `Рядом создана «${d.name}»`, 'success');
      onClose();
      navigate(editorHref(d));
    } finally { setBusy(false); }
  };

  const openOther = (l: Link) => { onClose(); navigate(editorHref(l.isSource ? { id: l.targetId, name: l.targetName } : { id: l.sourceId, name: l.sourceName })); };

  return (
    <Dialog title={`Английская версия — ${name}`} onClose={onClose} busy={busy} width="max-w-4xl"
      footer={(
        <>
          {link && <Btn tone="ghost" onClick={() => openOther(link)} disabled={busy}>{link.isSource ? 'Открыть перевод' : 'Открыть оригинал'}</Btn>}
          <span className="flex-1" />
          <Btn onClick={onClose} disabled={busy}>Закрыть</Btn>
          {rows && rows.length > 0 && (
            <Btn tone="primary" onClick={() => void issue()} disabled={busy}>
              {link?.isSource ? 'Обновить английскую версию' : 'Создать английскую версию'}
            </Btn>
          )}
        </>
      )}>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {link && !link.isSource && (
        <Empty title="Это английская версия" text={`Оригинал — «${link.sourceName}». Сверка и выпуск делаются из оригинала.`} />
      )}
      {!error && !(link && !link.isSource) && rows === null && <p className="text-sm text-slate-400">Переводится…</p>}
      {rows && !rows.length && <Empty title="Переводить нечего" text="В файле нет русского текста: только числа, коды и поля данных проекта." />}
      {rows && rows.length > 0 && (
        <>
          <p className="mb-2 text-sm text-slate-500 dark:text-slate-400">
            Готово {ready.ready} из {ready.total}.
            {link?.stale && ' Оригинал правили после прошлого выпуска — английская версия устарела.'}
            {' '}Поля данных проекта и числа не переводятся; оформление файла сохраняется.
          </p>
          <div className="h-[55vh] rounded border border-slate-200 dark:border-slate-800">
            <SegmentRows rows={rows} side showOrigin onChange={change} onConfirm={confirm} />
          </div>
        </>
      )}
    </Dialog>
  );
}
