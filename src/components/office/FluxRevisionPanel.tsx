import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, GitCompareArrows, History, LoaderCircle, LockKeyhole, RotateCcw } from 'lucide-react';
import { Btn } from '../ui';

type Revision = {
  id: string; fileId: string; parentRevisionId: string | null; revision: number; status: 'ISSUED' | 'DRAFT';
  sha256: string; sourceSha: string; sourceKind: string | null; sourceRevision: string | null;
  schemaVersion: number; createdById: string | null; createdAt: string;
};
type CompareResult = {
  from: Revision; to: Revision; beforeSha: string; afterSha: string; documentChanged: boolean; sourceChanged: boolean; sourceKnown: boolean;
  bindings: { added: Array<{ entityId: string; entityType: string; sourceId: string }>; removed: Array<{ entityId: string; entityType: string; sourceId: string }>; changed: Array<{ entityId: string; entityType: string; fields: Array<{ anchorId: string; before: unknown; after: unknown }> }> };
  text: { added: string[]; removed: string[] };
  bindingSchemas: { before: number | null; after: number | null };
};

interface Props {
  fileId: string;
  fileName: string;
  readOnly?: boolean;
  beforeIssue?: () => Promise<boolean>;
  onIssued?: (fileId: string, revisionId: string) => void;
  onDraftCreated?: (fileId: string) => void;
}

async function responseJson(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Сервер ответил ${response.status}`);
  return data;
}

const shortHash = (value: string) => value ? `${value.slice(0, 10)}…${value.slice(-6)}` : '—';
const titleOf = (revision: Revision) => `R${revision.revision}${revision.status === 'ISSUED' ? ' · выпущена' : ' · черновик'}`;

export default function FluxRevisionPanel({ fileId, fileName, readOnly = false, beforeIssue, onIssued, onDraftCreated }: Props) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [comparison, setComparison] = useState<CompareResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await responseJson(await fetch(`/api/office/revisions/${encodeURIComponent(fileId)}`));
      const rows: Revision[] = Array.isArray(data.revisions) ? data.revisions : [];
      setRevisions(rows);
      setFromId((current) => rows.some((row) => row.id === current) ? current : (rows.find((row) => row.status === 'ISSUED')?.id || ''));
      setToId((current) => rows.some((row) => row.id === current) ? current : (rows.at(-1)?.id || ''));
    } catch (cause: any) { setError(String(cause?.message || cause)); }
    finally { setLoading(false); }
  }, [fileId]);

  useEffect(() => { void load(); }, [load]);

  const issuedForFile = useMemo(() => revisions.some((row) => row.fileId === fileId && row.status === 'ISSUED'), [fileId, revisions]);
  const firstIssued = revisions.find((row) => row.status === 'ISSUED');
  const canIssue = !readOnly && !issuedForFile;
  const compareReady = !!fromId && !!toId && fromId !== toId;

  const issue = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      if (beforeIssue && !(await beforeIssue())) return;
      const meta = await responseJson(await fetch(`/api/office/files/${encodeURIComponent(fileId)}/meta`));
      const data = await responseJson(await fetch(`/api/office/revisions/${encodeURIComponent(fileId)}/issue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceSha: meta.sha256 }),
      }));
      setNotice(data.unchanged ? 'Эта ревизия уже выпущена.' : `${titleOf(data.revision)} сохранена и защищена от изменений.`);
      onIssued?.(fileId, data.revision.id);
      await load();
    } catch (cause: any) { setError(String(cause?.message || cause)); }
    finally { setBusy(false); }
  };

  const createDraft = async (revision: Revision) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await responseJson(await fetch(`/api/office/revisions/${encodeURIComponent(fileId)}/draft`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revisionId: revision.id, sourceSha: revision.sha256 }),
      }));
      setNotice(`Черновик R${data.revision.revision} создан. Исходная ревизия осталась без изменений.`);
      onDraftCreated?.(data.fileId);
      await load();
    } catch (cause: any) { setError(String(cause?.message || cause)); }
    finally { setBusy(false); }
  };

  const compare = async () => {
    setBusy(true); setError(''); setComparison(null);
    try {
      const query = new URLSearchParams({ from: fromId, to: toId });
      const data = await responseJson(await fetch(`/api/office/revisions/${encodeURIComponent(fileId)}/compare?${query}`));
      setComparison(data);
    } catch (cause: any) { setError(String(cause?.message || cause)); }
    finally { setBusy(false); }
  };

  return <section className="flex min-h-0 flex-col gap-3 p-3" aria-label="Ревизии документа">
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-dark-text-main"><History className="h-4 w-4" />Ревизии</h3>
        <p className="mt-1 truncate text-xs text-slate-500 dark:text-dark-text-muted" title={fileName}>{fileName}</p>
      </div>
      <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" onClick={() => void load()} disabled={loading || busy} aria-label="Обновить ревизии"><RotateCcw className="h-3.5 w-3.5" /></button>
    </header>

    {canIssue && <div className="flex items-center justify-between gap-3 rounded border border-slate-200 p-3 dark:border-slate-700">
      <div className="min-w-0 text-xs text-slate-600 dark:text-dark-text-muted">
        <div className="font-medium text-slate-800 dark:text-dark-text-main">Выпуск документа</div>
        <div className="mt-1">После выпуска файл станет неизменяемым. Для правок создайте черновик.</div>
      </div>
      <Btn tone="primary" onClick={() => void issue()} disabled={loading || busy} title="Сохранить и выпустить текущую версию"><LockKeyhole className="h-4 w-4" />Выпустить</Btn>
    </div>}

    {loading ? <div className="flex items-center gap-2 py-3 text-xs text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />Загрузка журнала…</div>
      : revisions.length === 0 ? <p className="rounded bg-slate-50 p-3 text-xs text-slate-600 dark:bg-dark-panel dark:text-dark-text-muted">Ревизии ещё не выпускались. Выпустите текущий документ, чтобы зафиксировать R1.</p>
        : <ol className="max-h-48 space-y-2 overflow-auto" aria-label="Список ревизий">
          {revisions.map((revision) => <li key={revision.id} className="flex items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2 dark:border-slate-700">
            <div className="min-w-0 text-xs">
              <div className="font-medium text-slate-800 dark:text-dark-text-main">{titleOf(revision)}</div>
              <div className="mt-0.5 truncate text-slate-500 dark:text-dark-text-muted">{new Date(revision.createdAt).toLocaleString('ru-RU')}</div>
              {(revision.sourceKind || revision.sourceRevision) && <div className="mt-0.5 truncate text-slate-500 dark:text-dark-text-muted">Источник: {sourceLabel(revision.sourceKind || 'document')}</div>}
            </div>
            {revision.status === 'ISSUED' && <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm shrink-0" disabled={busy} onClick={() => void createDraft(revision)} title="Создать новый документ на основе этой ревизии"><ArrowDownToLine className="h-3.5 w-3.5" />Черновик</button>}
          </li>)}
        </ol>}

    {revisions.length > 1 && <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
      <h4 className="text-xs font-semibold text-slate-700 dark:text-dark-text-main">Сравнить ревизии</h4>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
        <select aria-label="Старая ревизия" className="fx-input min-w-0" value={fromId} onChange={(event) => setFromId(event.target.value)}>{revisions.map((revision) => <option key={revision.id} value={revision.id}>{titleOf(revision)}</option>)}</select>
        <select aria-label="Новая ревизия" className="fx-input min-w-0" value={toId} onChange={(event) => setToId(event.target.value)}>{revisions.map((revision) => <option key={revision.id} value={revision.id}>{titleOf(revision)}</option>)}</select>
        <Btn onClick={() => void compare()} disabled={!compareReady || busy}><GitCompareArrows className="h-4 w-4" />Сравнить</Btn>
      </div>
      {comparison && <div className="space-y-1 rounded bg-slate-50 p-3 text-xs text-slate-700 dark:bg-dark-panel dark:text-dark-text-main" aria-live="polite">
        <div>{comparison.documentChanged ? 'Содержимое документа изменилось.' : 'Содержимое документа совпадает.'} {!comparison.sourceKnown ? 'Состояние источника не определено.' : comparison.sourceChanged ? 'Источник изменился.' : 'Источник совпадает.'}</div>
        {comparison.sourceChanged && <div className="break-all">Отпечаток источника: {shortHash(comparison.from.sourceRevision || '')} → {shortHash(comparison.to.sourceRevision || '')}</div>}
        <div>Строки данных: +{comparison.bindings.added.length}, −{comparison.bindings.removed.length}, изменено {comparison.bindings.changed.length}.</div>
        {!!(comparison.text.added.length || comparison.text.removed.length) && <div>Текст документа: +{comparison.text.added.length}, −{comparison.text.removed.length} фрагментов.</div>}
        {!!comparison.text.added.length && <ul className="max-h-24 list-inside list-disc overflow-auto">{comparison.text.added.slice(0, 8).map((text, index) => <li key={`add-${index}`}>Добавлено: {text}</li>)}</ul>}
        {!!comparison.text.removed.length && <ul className="max-h-24 list-inside list-disc overflow-auto">{comparison.text.removed.slice(0, 8).map((text, index) => <li key={`remove-${index}`}>Удалено: {text}</li>)}</ul>}
        {!!comparison.bindings.added.length && <p>Новые: {comparison.bindings.added.slice(0, 8).map((row) => row.entityId).join(', ')}</p>}
        {!!comparison.bindings.removed.length && <p>Удалены: {comparison.bindings.removed.slice(0, 8).map((row) => row.entityId).join(', ')}</p>}
        {!!comparison.bindings.changed.length && <ul className="max-h-28 list-inside list-disc overflow-auto">{comparison.bindings.changed.slice(0, 12).map((row) => <li key={row.entityId}>{row.entityId}: {row.fields.map((field) => `${field.anchorId} «${String(field.before ?? '—')}» → «${String(field.after ?? '—')}»`).join('; ') || 'изменился источник строки'}</li>)}</ul>}
        <details className="text-slate-500 dark:text-dark-text-muted"><summary className="cursor-pointer">Технические сведения</summary><div className="break-all">SHA: {shortHash(comparison.beforeSha)} → {shortHash(comparison.afterSha)}</div></details>
      </div>}
    </div>}

    {notice && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">{notice}</p>}
    {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    {firstIssued && issuedForFile && <p className="text-xs text-slate-500 dark:text-dark-text-muted">Выпущенный документ защищён. Все изменения продолжайте в отдельном черновике.</p>}
  </section>;
}

function sourceLabel(source: string) {
  const labels: Record<string, string> = { equipment: 'Оборудование', tags: 'Теги', management: 'Менеджмент', e3: 'E3Flux', document: 'Документ' };
  return source.split(',').map((value) => labels[value] || value).join(', ');
}
