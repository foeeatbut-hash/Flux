import React from 'react';
import { Btn, Dialog, Select, Status } from '../ui';
import { planFileCreation, claimFileCreation, completeFileCreation, stateFileCreation, lastFileCreation, undoFileCreationPlan, undoFileCreation, cancelFileCreation,
  type FileCreatePlan, type FileCreateResult, type FileCreationState } from '../../lib/docflowCreateApi';
import { prepareCreateFiles, publishCreateFiles, removeCreatedFiles, prepareUndoCreateFiles, openCreateRow, type PreparedCreateFile } from '../../lib/docflowCreateDisk';

/** Создание и связь подтверждаются вместе; при обрыве файлы сохраняются для повтора. */
export default function CreateFilesDialog({ projectId, itemIds, onClose, onDone }: {
  projectId: string; itemIds: string[]; onClose: () => void; onDone: () => void;
}) {
  const [format, setFormat] = React.useState('docx');
  const [useTemplates, setUseTemplates] = React.useState(true);
  const [plan, setPlan] = React.useState<FileCreatePlan | null>(null);
  const [last, setLast] = React.useState<FileCreationState | null>(null);
  const [result, setResult] = React.useState<FileCreateResult | null>(null);
  const [ready, setReady] = React.useState(false);
  const [started, setStarted] = React.useState(false);
  const [undoReady, setUndoReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const prepared = React.useRef<PreparedCreateFile[]>([]);
  const idsKey = itemIds.join('|');
  React.useEffect(() => {
    let alive = true;
    void lastFileCreation(projectId, itemIds.length === 1 ? itemIds[0] : undefined).then(answer => {
      if (alive && answer.ok && answer.data?.result?.count) setLast(answer.data);
    });
    return () => { alive = false; prepared.current = []; };
  }, [projectId, idsKey]);
  const accept = (answer: FileCreateResult) => {
    setResult(answer); setReady(false); setUndoReady(false); setLast(null); prepared.current = []; onDone();
  };
  const resetPlan = (change: () => void) => { change(); setPlan(null); setReady(false); setError(''); prepared.current = []; };
  const preview = async () => {
    setBusy(true); setError(''); setReady(false); setPlan(null); prepared.current = [];
    try {
      const answer = await planFileCreation({ projectId, itemIds, format, useTemplates });
      if (!answer.ok) throw new Error(answer.data.error || 'Не удалось построить план');
      setPlan(answer.data);
      prepared.current = await prepareCreateFiles(answer.data);
      setReady(true);
    } catch (e: any) { setError(e.message || 'Не удалось проверить рабочую папку'); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!plan || !ready) return;
    setBusy(true); setError('');
    try {
      const claim = await claimFileCreation(projectId, plan.id, prepared.current.map(f => ({ itemId: f.row.itemId, sha256: f.sha256, size: f.size })));
      if (!claim.ok) throw new Error(claim.data.error || 'Нет разрешения на создание файлов');
      if (claim.data.applied && claim.data.result) { accept(claim.data.result); return; }
      setStarted(true);
      await publishCreateFiles(plan, prepared.current);
      const answer = await completeFileCreation(projectId, plan.id);
      if (answer.ok) { accept(answer.data); return; }
      const state = await stateFileCreation(projectId, plan.id);
      if (state.ok && state.data.state === 'applied' && state.data.result) { accept(state.data.result); return; }
      throw new Error(answer.data.error || 'Файлы созданы, но связь с реестром не подтверждена. Повторите создание или отмените подготовку.');
    } catch (e: any) { setError(e.message || 'Создание не завершено'); }
    finally { setBusy(false); }
  };
  const checkUndo = async () => {
    if (!plan || !result) return;
    setBusy(true); setError('');
    try {
      const answer = await undoFileCreationPlan(projectId, plan.id);
      if (!answer.ok) throw new Error(answer.data.error || 'Отмена недоступна');
      prepared.current = await prepareUndoCreateFiles(plan, answer.data.files);
      setUndoReady(true);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const undo = async () => {
    if (!plan || !undoReady) return;
    setBusy(true); setError('');
    try {
      const checked = await undoFileCreationPlan(projectId, plan.id);
      if (!checked.ok) throw new Error(checked.data.error || 'Отмена больше недоступна');
      await removeCreatedFiles(plan, prepared.current);
      const answer = await undoFileCreation(projectId, plan.id);
      if (!answer.ok) {
        const state = await stateFileCreation(projectId, plan.id);
        if (!state.ok || state.data.state !== 'undone') throw new Error(answer.data.error || 'Отмена связей не подтверждена. Повторите отмену; файлы можно вернуть журналом Проводника.');
      }
      onDone(); onClose();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!plan) { onClose(); return; }
    setBusy(true); setError('');
    try {
      const state = await stateFileCreation(projectId, plan.id);
      if (!state.ok) throw new Error(state.data.error || 'Не удалось проверить состояние. Файлы сохранены.');
      if (state.data.state === 'applied' && state.data.result) { accept(state.data.result); return; }
      if (state.data.state !== 'preview') throw new Error('Подготовка уже отменена в другом окне. Файлы сохранены — проверьте их в Проводнике.');
      const checked = await cancelFileCreation(projectId, plan.id, true);
      if (!checked.ok) throw new Error(checked.data.error || 'Подготовку нельзя отменить');
      await removeCreatedFiles(plan, prepared.current);
      const answer = await cancelFileCreation(projectId, plan.id);
      if (!answer.ok) throw new Error(answer.data.error || 'Не удалось завершить отмену. Проверьте файлы в Проводнике.');
      onDone(); onClose();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const close = () => {
    if (busy) return;
    if (undoReady && error && prepared.current.some(file => file.removed)) { setError('Отмена не завершена. Повторите её или верните файлы журналом Проводника. Состояние можно явно сохранить и закрыть окно.'); return; }
    if (started && !result) { setError('Создание не завершено. Повторите его, отмените подготовку или явно оставьте файлы для ручного назначения.'); return; }
    onClose();
  };
  const count = plan?.rows.filter(row => row.action === 'create').length || 0;
  return <Dialog title="Создать и связать файлы — предпросмотр" width="max-w-5xl" busy={busy} onClose={close}
    footer={<><Btn disabled={busy} onClick={close}>{result ? 'Готово' : 'Закрыть'}</Btn>
      {result && undoReady && error && prepared.current.some(file => file.removed) && <Btn disabled={busy} onClick={onClose}>Сохранить состояние и закрыть</Btn>}
      {result ? undoReady ? <Btn tone="danger" disabled={busy} onClick={() => void undo()}>Отменить создание ({result.count})</Btn>
        : <Btn disabled={busy || !result.count} onClick={() => void checkUndo()}>Проверить отмену создания</Btn>
        : <>{started && <><Btn disabled={busy} onClick={() => void cancel()}>Отменить подготовку</Btn><Btn disabled={busy} onClick={onClose}>Оставить файлы и закрыть</Btn></>}
          {!started && <Btn disabled={busy} onClick={() => void preview()}>Показать план</Btn>}
          <Btn tone="primary" disabled={busy || !ready || !count} onClick={() => void apply()}>{started ? 'Повторить создание' : `Создать и связать (${count})`}</Btn></>}
    </>}>
    <p className="fx-note mb-3">Файлы появятся в рабочей папке проекта и будут связаны с указанными строками. Их увидят участники проекта с доступом к папке. Шаблон копируется без заполнения; новые файлы пустые.</p>
    {!result && <div className="flex flex-wrap items-center gap-3 mb-3">
      <label className="fx-field w-40"><span className="fx-label">Пустой формат</span><Select aria-label="Формат нового файла" value={format} onChange={v => resetPlan(() => setFormat(v))} disabled={busy || started} options={['docx', 'xlsx', 'pdf', 'txt'].map(value => ({ value, label: value.toUpperCase() }))} /></label>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={useTemplates} disabled={busy || started} onChange={e => resetPlan(() => setUseTemplates(e.target.checked))} /> Использовать шаблоны типов документов</label>
      {last && !started && <Btn disabled={busy} onClick={() => { setPlan(last); setResult(last.result); setStarted(true); setReady(false); setLast(null); setError(''); prepared.current = []; }}>Последнее создание ({last.result!.count})…</Btn>}
    </div>}
    {busy && <p role="status">Проверка и создание…</p>}
    {error && <Status tone="rose">{error}</Status>}
    {started && !result && <p className="fx-note">При обрыве созданные файлы сохраняются. Повтор использует тот же пакет. Если оставить файлы, проверьте и назначьте их вручную в Реестре.</p>}
    {result && !error && <Status tone="emerald">Файлы созданы и связаны. Отмена доступна 30 дней, пока документы не изменили или не выпустили.</Status>}
    {undoReady && <Status tone="amber">Будут перемещены в корзину {result?.count} созданных файлов; их связи останутся в истории.</Status>}
    {plan && <div className="overflow-x-auto"><table className="fx-table w-full whitespace-nowrap" aria-label="План создания файлов"><thead><tr><th>Файл</th><th>Ревизия</th><th>Папка и путь</th><th>Источник</th><th>Действие</th></tr></thead><tbody>
      {plan.rows.map(row => { const link = result?.links.find(link => link.itemId === row.itemId && link.revision === row.revision) || row.link; return <tr key={row.itemId}>
        <td className="font-mono">{row.fileName}</td><td>{row.revision}</td><td>{row.binding?.label || '—'}/{row.relativePath}</td><td>{row.template || (row.action === 'create' ? `Пустой ${row.format.toUpperCase()}` : 'Связанный файл')}</td>
        <td>{link ? <Btn disabled={busy} onClick={() => void openCreateRow({ ...row, link }).catch(e => setError(e.message))}>Ред. {row.revision} уже есть — открыть</Btn> : undoReady ? 'В корзину' : 'Создать и связать'}</td>
      </tr>; })}
    </tbody></table></div>}
  </Dialog>;
}
