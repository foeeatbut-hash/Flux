/**
 * Стартовый экран «Мои программы»: свои программы (на этом компьютере и уже отправленные), «Новая программа»,
 * «Открыть папку как проект». Короткая подсказка «5 шагов» показывается при первом запуске и закрывается.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Plus, X } from 'lucide-react';
import { Empty, SectionHead, Status } from '../../../src/components/ui/controls';
import { call, REQUEST_STATES, STATE_TONE, type DraftSummary, type RequestRow } from '../call';
import { TONE } from '../Modules';
import NewProgram from './NewProgram';
import Modal from './Modal';

export const STEPS = ['Создайте программу (кнопка «Новая программа»).', 'Нажмите «Запустить» и посмотрите её в окне снизу.', 'Правьте файлы слева, «Проверить» покажет, что исправить.',
  'Нажмите «Опубликовать»: Studio проверит и отправит владельцу.', 'Владелец проверит и выпустит: программа появится во Flux Store.'];
const HINT_KEY = 'studio_steps_hint_closed';

export default function Home({ onOpen }: { onOpen: (id: string) => void }) {
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<DraftSummary | null>(null);
  const [hint, setHint] = useState(() => { try { return localStorage.getItem(HINT_KEY) !== '1'; } catch { return true; } });
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const load = useCallback(async () => {
    try { setDrafts(await call<DraftSummary[]>('drafts')); } catch (e) { fail(e); }
    try { setRequests(await call<RequestRow[]>('requests')); } catch { setRequests([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const last = new Map<string, RequestRow>();
  for (const r of [...requests].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) last.set(r.moduleId, r);
  const remote = [...last.values()].filter(r => !drafts?.some(d => d.id === r.moduleId));

  const openFolder = async () => {
    setError('');
    try { const r = await call<{ id: string; canceled?: boolean }>('projectOpenFolder'); if (!r.canceled) onOpen(r.id); } catch (e) { fail(e); }
  };
  const importArchive = async () => {
    setError('');
    try { const r = await call<{ id: string; canceled?: boolean }>('projectImportArchive'); if (!r.canceled) onOpen(r.id); } catch (e) { fail(e); }
  };
  const importRequest = async (row: RequestRow) => {
    setError('');
    try { onOpen((await call<{ id: string }>('draftImport', { requestId: row.id })).id); } catch (e) { fail(e); }
  };
  const closeHint = () => { setHint(false); try { localStorage.setItem(HINT_KEY, '1'); } catch { /* без памяти подсказка вернётся */ } };

  const stateOf = (id: string) => { const r = last.get(id); return r ? <Status tone={TONE[STATE_TONE[r.state] || 'muted']}>{REQUEST_STATES[r.state] || r.state}</Status> : <span className="fx-hint">Не отправлялась</span>; };

  return (
    <section aria-label="Мои программы" className="fx-page">
      <SectionHead title="Мои программы" count={drafts ? `${drafts.length + remote.length}` : undefined}
        actions={<>
          <button type="button" className="fx-btn" onClick={() => void openFolder()}><FolderOpen />Открыть папку…</button>
          <button type="button" className="fx-btn" onClick={() => void importArchive()}>Импортировать архив…</button>
          <button type="button" className="fx-btn fx-btn-primary" onClick={() => setCreating(true)}><Plus />Новая программа</button>
        </>} />
      <div className="fx-page-body">
        {hint && (
          <aside className="studio-steps" aria-label="Как пройти путь за 5 шагов">
            <div className="studio-steps-head"><strong>Как пройти путь за 5 шагов</strong>
              <button type="button" className="fx-ibtn" aria-label="Закрыть подсказку" onClick={closeHint}><X /></button></div>
            <ol>{STEPS.map(s => <li key={s}>{s}</li>)}</ol>
          </aside>
        )}
        {error && <p className="fx-error p-4" role="alert">{error}</p>}
        {drafts && drafts.length + remote.length === 0 && (
          <Empty title="Программ пока нет" text="Создайте первую из примера или откройте папку с готовым проектом.">
            <button type="button" className="fx-btn fx-btn-primary" onClick={() => setCreating(true)}><Plus />Новая программа</button>
          </Empty>
        )}
        {drafts && drafts.length + remote.length > 0 && (
          <table className="fx-table">
            <thead><tr><th>Программа</th><th>Версия</th><th>Состояние</th><th>Папка</th><th></th></tr></thead>
            <tbody>
              {drafts.map(d => (
                <tr key={d.id}>
                  <td><button type="button" className="studio-link" onClick={() => onOpen(d.id)}>{d.name}</button> <span className="code fx-hint">{d.id}</span></td>
                  <td className="data">{d.version}</td><td>{stateOf(d.id)}</td><td className="code" title={d.folder}>{d.folder}</td>
                  <td className="end"><button type="button" className="fx-btn" onClick={() => onOpen(d.id)}>Открыть</button>{' '}
                    <button type="button" className="fx-btn fx-btn-quiet" onClick={() => setRemoving(d)}>Убрать из списка</button></td>
                </tr>))}
              {remote.map(r => (
                <tr key={r.moduleId}>
                  <td>{r.moduleId} <span className="fx-hint">(не на этом компьютере)</span></td><td className="data">{r.version}</td><td>{stateOf(r.moduleId)}</td><td></td>
                  <td className="end"><button type="button" className="fx-btn" onClick={() => void importRequest(r)}>Открыть как проект</button></td>
                </tr>))}
            </tbody>
          </table>
        )}
      </div>
      {creating && <NewProgram onClose={() => setCreating(false)} onCreated={id => { setCreating(false); onOpen(id); }} />}
      {removing && (
        <Modal title="Убрать из списка?" onClose={() => setRemoving(null)}>
          <p>Программа «{removing.name}» пропадёт из списка Studio. Папка и файлы в ней останутся на месте: {removing.folder}</p>
          <div className="row studio-modal-actions">
            <button type="button" className="fx-btn fx-btn-primary" onClick={async () => { try { await call('draftRemove', { id: removing.id }); setRemoving(null); await load(); } catch (e) { fail(e); setRemoving(null); } }}>Убрать</button>
            <button type="button" className="fx-btn" onClick={() => setRemoving(null)}>Отмена</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
