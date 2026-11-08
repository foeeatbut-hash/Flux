import React from 'react';
import { Btn, Dialog, Input, Select, Status } from '../ui';
import type { ProjectDocs } from './useProjectDocs';
import type { ProjectFolderBinding } from '../../lib/projectFolderBindings';
import { refOfLink } from '../../lib/docflowFiles';
import { windowsFilesRequest } from '../../lib/windowsFiles';
import { isEditedHere } from '../../lib/localEditing';
import { applyIssue, lastIssue, planIssue, undoIssue, type IssuePlanView, type IssueRowInput, type IssueResultView, type IssueStateView } from '../../lib/docflowIssueApi';
import { kindOfRevision } from '../../../shared/docflow/revisions';

/**
 * «Выпустить…» (docs/docflow-program.md, 7.1). Тело файла на сервер не уходит:
 * отпечаток считает главный процесс на этом компьютере, окно показывает его
 * человеку, а сервер сверяет присланный при подтверждении отпечаток с тем,
 * что был в предпросмотре. Проверки показаны построчно и повторены сервером.
 */
interface Local { sha256: string; busy: boolean; note: string }
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export default function IssueDialog({ projectId, docs, bindings, itemIds, onClose, onDone }: {
  projectId: string; docs: ProjectDocs; bindings: ProjectFolderBinding[]; itemIds: string[]; onClose: () => void; onDone: () => void;
}) {
  const { config } = docs;
  const files = React.useMemo(() => itemIds.map((id) => {
    const item = docs.items[id];
    const link = docs.links.find((l) => l.itemId === id && l.role === 'file' && !l.unlinkedAt && item && l.revision === item.revision) || null;
    return { id, item, link };
  }), [itemIds.join('|'), docs]);
  const defaultReason = (revision: string) => (config.reasons.find((r) => r.revKind === (kindOfRevision(revision.toUpperCase()) || 'letter')) || config.reasons[0])?.code || '';
  const [reasons, setReasons] = React.useState<Record<string, string>>({});
  const [dates, setDates] = React.useState<Record<string, string>>({});
  const [local, setLocal] = React.useState<Record<string, Local>>({});
  const [plan, setPlan] = React.useState<IssuePlanView | null>(null);
  const [result, setResult] = React.useState<IssueResultView | null>(null);
  const [last, setLast] = React.useState<IssueStateView | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [note, setNote] = React.useState('');

  /** Отпечаток и «файл открыт на запись» — только на этом компьютере; без моста выпуск невозможен. */
  const readLocal = async (): Promise<Record<string, Local>> => {
    const out: Record<string, Local> = {};
    for (const f of files) {
      if (!f.link) { out[f.id] = { sha256: '', busy: false, note: 'У строки нет связанного файла этой ревизии' }; continue; }
      const ref = await refOfLink(f.link, bindings);
      if (!ref) { out[f.id] = { sha256: '', busy: false, note: 'Папка проекта не найдена на этом компьютере: привяжите её в Проводнике' }; continue; }
      const hash = await windowsFilesRequest<{ sha256: string; size: number }>({ action: 'fileHash', ref });
      out[f.id] = hash.ok ? { sha256: hash.data.sha256, busy: isEditedHere(ref), note: '' } : { sha256: '', busy: false, note: 'Файл не прочитан. Проверьте путь и доступ' };
    }
    return out;
  };
  const inputs = (state: Record<string, Local>): IssueRowInput[] => files.filter((f) => f.link).map((f) => ({
    itemId: f.id, linkId: f.link!.id, reason: reasons[f.id] ?? defaultReason(f.item?.revision || ''), date: dates[f.id] ?? localToday(),
    sha256: state[f.id]?.sha256 || '', busy: !!state[f.id]?.busy,
  }));

  const check = async () => {
    setBusy(true); setError(''); setNote(''); setPlan(null);
    try {
      const state = await readLocal();
      setLocal(state);
      const answer = await planIssue(projectId, inputs(state));
      if (!answer.ok) throw new Error(answer.data.error || 'Не удалось проверить выпуск');
      setPlan(answer.data);
    } catch (e: any) { setError(e.message || 'Проверка не выполнена'); }
    finally { setBusy(false); }
  };
  React.useEffect(() => { void check(); }, [itemIds.join('|')]);
  React.useEffect(() => {
    let alive = true;
    void lastIssue(projectId).then((a) => { if (alive && a.ok && a.data?.result?.count) setLast(a.data); });
    return () => { alive = false; };
  }, [projectId]);

  const submit = async () => {
    if (!plan?.ok) return;
    setBusy(true); setError(''); setNote('');
    try {
      // Отпечаток читается заново в момент подтверждения: правка после предпросмотра не пройдёт
      const fresh = await readLocal();
      const changed = plan.rows.some((r) => fresh[r.itemId]?.sha256 !== r.sha256 || fresh[r.itemId]?.busy);
      if (changed) { setLocal(fresh); setNote('Файл изменился после проверки. Выпуск не выполнен — проверьте результат ещё раз.'); setPlan(null); const again = await planIssue(projectId, inputs(fresh)); if (again.ok) setPlan(again.data); return; }
      const answer = await applyIssue(projectId, plan.id, Object.fromEntries(plan.rows.map((r) => [r.itemId, fresh[r.itemId].sha256])));
      if (!answer.ok) throw new Error(answer.data.error || 'Выпуск не выполнен');
      setResult(answer.data); setLast(null); onDone();
    } catch (e: any) { setError(e.message || 'Выпуск не выполнен'); }
    finally { setBusy(false); }
  };
  const undo = async (id: string) => {
    setBusy(true); setError('');
    const answer = await undoIssue(projectId, id);
    setBusy(false);
    if (!answer.ok) { setError(answer.data.error || 'Отмена невозможна'); return; }
    setResult(null); setLast(null); setNote('Выпуск отменён: строки вернулись в прежнее состояние.'); onDone(); void check();
  };

  const statusLabel = (code: string) => config.statuses.find((s) => s.code === code)?.label || code;
  const rows = plan?.rows || [];
  return (
    <Dialog title="Выпустить документы" onClose={() => !busy && onClose()} width="max-w-4xl" busy={busy}
      footer={<><Btn disabled={busy} onClick={onClose}>{result ? 'Закрыть' : 'Отмена'}</Btn>
        {!result && <><Btn disabled={busy} onClick={() => void check()}>Проверить снова</Btn><Btn tone="primary" data-issue-submit disabled={busy || !plan?.ok} onClick={() => void submit()}>Выпустить</Btn></>}</>}>
      <div className="space-y-3 text-xs" data-issue-dialog>
        <p className="text-slate-600 dark:text-slate-300">Файл с вашего компьютера на сервер не передаётся: сервер получает только его отпечаток и сверяет с тем, что вы видите ниже. Выпуск работает при связи с сервером.</p>
        {last && !result && <div role="status" className="flex items-center gap-2 rounded border border-slate-200 p-2 dark:border-slate-700"><span>Ваш предыдущий выпуск: {last.result?.count} докум. Его можно отменить, пока нет возвратов и правок.</span><Btn size="sm" disabled={busy} onClick={() => void undo(last.id)}>Отменить выпуск</Btn></div>}
        {result ? (
          <div role="status" className="space-y-2" data-issue-done>
            <Status tone="emerald">{result.repeated ? 'Выпуск уже был записан: повтор ничего не добавил' : `Выпущено: ${result.count}`}</Status>
            <Btn size="sm" disabled={busy} onClick={() => void undo(result.id)}>Отменить выпуск</Btn>
          </div>
        ) : (
          <table className="w-full text-left" data-issue-table>
            <thead><tr className="text-slate-500"><th className="py-1 pr-2">Документ</th><th className="pr-2">Ред.</th><th className="pr-2">Файл и отпечаток</th><th className="pr-2">Причина</th><th className="pr-2">Дата</th><th>Проверки</th></tr></thead>
            <tbody>
              {files.map((f) => {
                const r = rows.find((x) => x.itemId === f.id);
                const loc = local[f.id];
                const problems = [...(!f.link ? ['У строки нет связанного файла этой ревизии'] : []), ...(loc?.note ? [loc.note] : []), ...(r?.problems || [])];
                return (
                  <tr key={f.id} data-issue-row={f.id} className="border-t border-slate-200 align-top dark:border-slate-700">
                    <td className="py-1.5 pr-2"><strong className="font-medium">{f.item?.cipher || '—'}</strong><br /><span className="text-slate-500">{f.item?.title} · {statusLabel(f.item?.status || '')}</span></td>
                    <td className="pr-2">{f.item?.revision}</td>
                    <td className="max-w-56 break-all pr-2">{f.link?.fileName || '—'}<br /><span className="font-mono text-[10px] text-slate-500" data-issue-hash>{loc?.sha256 ? `${loc.sha256.slice(0, 16)}…` : ''}</span></td>
                    <td className="pr-2"><Select value={reasons[f.id] ?? defaultReason(f.item?.revision || '')} onChange={(v) => { setReasons((s) => ({ ...s, [f.id]: v })); setPlan(null); }} options={config.reasons.map((x) => ({ value: x.code, label: x.code }))} /></td>
                    <td className="pr-2"><Input type="date" aria-label="Дата выпуска" value={dates[f.id] ?? localToday()} onChange={(e) => { setDates((s) => ({ ...s, [f.id]: e.target.value })); setPlan(null); }} /></td>
                    <td>{!plan && !problems.length ? <span className="text-slate-500">Проверяется…</span>
                      : problems.length ? <ul className="space-y-0.5 text-rose-700 dark:text-rose-400">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
                        : <span className="text-emerald-700 dark:text-emerald-400">Все проверки пройдены</span>}
                      {(r?.notes || []).map((n, i) => <p key={i} className="text-amber-700 dark:text-amber-400">{n}</p>)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {note && <p role="status">{note}</p>}
        {error && <p role="alert" className="text-rose-600 dark:text-rose-400">{error}</p>}
      </div>
    </Dialog>
  );
}
