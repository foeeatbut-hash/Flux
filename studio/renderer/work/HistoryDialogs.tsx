/**
 * Окна истории версий: «Сравнить» (любые две версии или версия и текущие файлы) и «Откатить…» (предпросмотр и подтверждение).
 * Откат ничего не пишет, пока человек не нажал «Откатить»; перед записью главный процесс сохраняет текущее состояние
 * версией «Перед откатом» (studio/shared/history.ts).
 */
import React, { useEffect, useState } from 'react';
import { Status } from '../../../src/components/ui/controls';
import type { Comparison, PlanEntry, RollbackPlan, SnapshotInfo } from '../../shared/history';
import { call } from '../call';
import Modal from './Modal';
import DiffView, { bytesText, FILE_STATUS_TEXT } from './DiffView';
import { snapshotTitle } from './historyText';

const CURRENT = 'current';

/** Список файлов слева и разница выбранного справа: общий вид и сравнения, и предпросмотра отката */
function Files({ files, label, onPick, active }: { files: Array<{ path: string; text: string; tone: 'slate' | 'emerald' | 'amber' | 'rose'; size: string }>; label: string; onPick: (p: string) => void; active: string }) {
  return (
    <div className="studio-diff-files" role="list" aria-label={label}>
      {files.map(f => (
        <button key={f.path} type="button" role="listitem" className="studio-diff-file" aria-current={f.path === active} onClick={() => onPick(f.path)} title={f.path}>
          <span className="studio-diff-file-name code">{f.path}</span><Status tone={f.tone}>{f.text}</Status>
          {f.size && <span className="fx-hint">{f.size}</span>}
        </button>))}
    </div>
  );
}

export function CompareDialog({ id, snapshots, from: first, to: second, onClose }: { id: string; snapshots: SnapshotInfo[]; from: string; to: string; onClose: () => void }) {
  const [from, setFrom] = useState(first), [to, setTo] = useState(second);
  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState('');
  const [path, setPath] = useState('');
  useEffect(() => {
    let live = true;
    setData(null); setError('');
    call<Comparison>('historyCompare', { id, from, to }).then(d => { if (live) { setData(d); setPath(p => d.files.some(f => f.path === p) ? p : d.files[0]?.path || ''); } }).catch(e => live && setError((e as Error).message));
    return () => { live = false; };
  }, [id, from, to]);
  const options = [{ value: CURRENT, label: 'Текущие файлы проекта' }, ...snapshots.map(s => ({ value: s.id, label: snapshotTitle(s) }))];
  const shown = data?.files.find(f => f.path === path);
  return (
    <Modal title="Сравнение версий" onClose={onClose} huge>
      <div className="studio-compare-pick">
        <label className="fx-hint" htmlFor="cmp-from">Было</label>
        <select id="cmp-from" className="fx-input" value={from} onChange={e => setFrom(e.target.value)}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        <label className="fx-hint" htmlFor="cmp-to">Стало</label>
        <select id="cmp-to" className="fx-input" value={to} onChange={e => setTo(e.target.value)}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      </div>
      {error && <p className="fx-error" role="alert">{error}</p>}
      {!data && !error && <p className="fx-hint">Считаем разницу…</p>}
      {data && (data.files.length === 0
        ? <p className="fx-hint" role="status">Файлы одинаковые{data.same ? `: ${data.same}` : ''}.</p>
        : <div className="studio-diff-split">
          <Files label="Изменённые файлы" active={path} onPick={setPath}
            files={data.files.map(f => ({ path: f.path, text: FILE_STATUS_TEXT[f.status], tone: f.status === 'added' ? 'emerald' : f.status === 'removed' ? 'rose' : 'amber', size: f.binary ? bytesText(f.sizeAfter ?? f.sizeBefore) : '' }))} />
          <div className="studio-diff-pane">{shown && <DiffView file={shown} />}</div>
        </div>)}
      {data && data.files.length > 0 && <p className="fx-hint">Изменено файлов: {data.files.length}, без изменений: {data.same}.</p>}
      <div className="row studio-modal-actions"><button type="button" className="fx-btn" onClick={onClose}>Закрыть</button></div>
    </Modal>
  );
}

const ACTION: Record<PlanEntry['action'], { text: string; tone: 'amber' | 'emerald' | 'rose' }> = {
  modify: { text: 'Изменится', tone: 'amber' }, create: { text: 'Появится', tone: 'emerald' }, delete: { text: 'Исчезнет', tone: 'rose' },
};

export function RollbackDialog({ id, snapshot, getDirty, saveAll, onClose, onDone }: {
  id: string; snapshot: SnapshotInfo; getDirty: () => string[]; saveAll: () => Promise<boolean>; onClose: () => void; onDone: (restorePoint: SnapshotInfo) => void;
}) {
  const [plan, setPlan] = useState<RollbackPlan | null>(null);
  const [diff, setDiff] = useState<Comparison | null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState<string[]>(getDirty());
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setPlan(null); setDiff(null); setError('');
    Promise.all([call<RollbackPlan>('historyPlan', { id, snapshot: snapshot.id }), call<Comparison>('historyCompare', { id, from: CURRENT, to: snapshot.id })])
      .then(([p, d]) => { if (live) { setPlan(p); setDiff(d); setPath(prev => p.entries.some(e => e.path === prev) ? prev : p.entries[0]?.path || ''); } })
      .catch(e => live && setError((e as Error).message));
    return () => { live = false; };
  }, [id, snapshot.id, reload]);

  // Все вкладки записаны; getDirty() до перерисовки ещё видит старое, поэтому список сбрасывается сразу
  const saveEdits = async () => { if (await saveAll()) { setDirty([]); setReload(n => n + 1); } };
  const rollback = async () => {
    if (!plan) return;
    setBusy(true); setError('');
    try { const r = await call<{ restorePoint: SnapshotInfo }>('historyRollback', { id, snapshot: snapshot.id, token: plan.token }); onDone(r.restorePoint); }
    catch (e) { setError((e as Error).message); setReload(n => n + 1); }
    setBusy(false);
  };
  const shown = diff?.files.find(f => f.path === path);
  return (
    <Modal title="Откатить к версии" onClose={onClose} huge>
      <p>Проект вернётся к версии «{snapshotTitle(snapshot)}»{snapshot.note ? `: ${snapshot.note}` : ''}.</p>
      <p className="fx-hint">Прежде чем что-то менять, Studio сохранит нынешнее состояние версией «Перед откатом» — к ней можно вернуться тем же способом.</p>
      {dirty.length > 0 && (
        <p className="fx-note fx-note-warn" role="status">Есть несохранённые правки в редакторе: {dirty.join(', ')}. Откат их не сохраняет: после отката Studio спросит про каждый такой файл — перечитать с диска или оставить ваш текст.{' '}
          <button type="button" className="fx-btn fx-btn-sm" onClick={() => void saveEdits()}>Сохранить правки в проект</button></p>)}
      {error && <p className="fx-error" role="alert">{error}</p>}
      {!plan && !error && <p className="fx-hint">Готовим предпросмотр…</p>}
      {plan && plan.entries.length === 0 && <p className="fx-hint" role="status">Проект уже совпадает с этой версией: откатывать нечего.</p>}
      {plan && plan.entries.length > 0 && (<>
        <p role="status">Изменится файлов: {plan.entries.filter(e => e.action === 'modify').length}, появится: {plan.entries.filter(e => e.action === 'create').length}, исчезнет: {plan.entries.filter(e => e.action === 'delete').length}. Остальные ({plan.unchanged}) не тронуты.</p>
        {plan.shadowed.length > 0 && <p className="fx-note fx-note-warn">Эти файлы не входят в историю (так задано в .fluxignore), но будут перезаписаны: {plan.shadowed.join(', ')}. Их нынешний вид сохранится в версии «Перед откатом».</p>}
        <div className="studio-diff-split">
          <Files label="Что произойдёт с файлами" active={path} onPick={setPath} files={plan.entries.map(e => ({ path: e.path, text: ACTION[e.action].text, tone: ACTION[e.action].tone, size: '' }))} />
          <div className="studio-diff-pane">{shown ? <DiffView file={shown} /> : <p className="fx-hint studio-diff-binary">Выберите файл слева.</p>}</div>
        </div>
        <p className="fx-hint">В разнице «−» — то, что есть сейчас и исчезнет, «+» — то, что вернётся из версии.</p>
      </>)}
      <div className="row studio-modal-actions">
        <button type="button" className="fx-btn fx-btn-primary" disabled={busy || !plan || plan.entries.length === 0} onClick={() => void rollback()}>{busy ? 'Откатываем…' : 'Откатить'}</button>
        <button type="button" className="fx-btn" onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  );
}
