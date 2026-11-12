/**
 * Раздел «Проект программы»: создать из заготовки, открыть свой запрос как проект, тестовая база, запуск.
 * Черновик хранится на этом компьютере (studio/shared/drafts.ts); в общую базу уходит только отправка.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { SectionHead } from '../../../src/components/ui/controls';
import { call, type DraftSummary, type RequestRow } from '../call';
import Run from './Run';

interface Template { id: string; title: string; note: string }
interface Tree { files: Array<{ path: string; size: number; text: boolean }> }
interface BaseView { counts: Record<string, number>; context: unknown[] }

const LABELS: Record<string, string> = {
  projects: 'Проекты', tags: 'Теги', systems: 'Системы', installations: 'Установки', equipment: 'Оборудование',
  files: 'Файлы Проводника', specifications: 'Спецификации', vdr: 'ВДР', families: 'Семейства каталога',
};
const kb = (n: number) => n < 1024 ? `${n} Б` : n < 1048576 ? `${(n / 1024).toFixed(1)} КиБ` : `${(n / 1048576).toFixed(1)} МиБ`;

export default function Projects({ current, onOpen }: { current: string; onOpen: (id: string) => void }) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [base, setBase] = useState<BaseView | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ template: 'typescript', kind: 'form', id: '', name: '' });
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const reload = useCallback(async () => {
    try {
      setDrafts(await call<DraftSummary[]>('drafts'));
      setBase(await call<BaseView>('testBase'));
    } catch (e) { fail(e); }
  }, []);
  useEffect(() => { void reload(); void call<Template[]>('templates').then(setTemplates).catch(fail); }, [reload]);
  useEffect(() => { void call<RequestRow[]>('requests').then(setRequests).catch(() => setRequests([])); }, []);
  useEffect(() => { if (current) void call<Tree>('draftTree', { id: current }).then(setTree).catch(() => setTree(null)); else setTree(null); }, [current, drafts]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    try { const made = await call<{ id: string }>('draftCreate', form); setForm({ ...form, id: '', name: '' }); await reload(); onOpen(made.id); } catch (e) { fail(e); }
  };
  const importRequest = async (id: string) => {
    setError('');
    try { const made = await call<{ id: string }>('draftImport', { requestId: id }); await reload(); onOpen(made.id); } catch (e) { fail(e); }
  };
  // Свои программы, которых ещё нет на этом компьютере: по последнему запросу каждой
  const own = requests ? [...new Map(requests.map(r => [r.moduleId, r])).values()].filter(r => !drafts.some(d => d.id === r.moduleId)) : [];

  return (
    <section aria-label="Проект программы" className="fx-page">
      <SectionHead title="Проект программы" />
      <div className="fx-page-body p-4 studio-body">
      <p className="fx-hint">Черновик лежит на этом компьютере. В общую базу уходит только запрос на публикацию.</p>
      {error && <p className="fx-error" role="alert">{error}</p>}

      <form className="panel" onSubmit={create} aria-labelledby="new-title">
        <h3 id="new-title">Новый проект из заготовки</h3>
        <div className="grid">
          <div className="field"><label htmlFor="tpl">Язык</label>
            <select id="tpl" value={form.template} onChange={e => setForm({ ...form, template: e.target.value })}>
              {templates.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select></div>
          <div className="field"><label htmlFor="kind">Экран</label>
            <select id="kind" value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}>
              <option value="form">Форма (form.json)</option>
              <option value="page">Своя страница (HTML, CSS, JS)</option>
            </select></div>
          <div className="field"><label htmlFor="pid">Идентификатор</label>
            <input id="pid" value={form.id} maxLength={64} placeholder="my-calculation" onChange={e => setForm({ ...form, id: e.target.value })} /></div>
          <div className="field"><label htmlFor="pname">Название</label>
            <input id="pname" value={form.name} maxLength={80} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
        </div>
        <p className="fx-hint">{templates.find(t => t.id === form.template)?.note}{form.kind === 'page' ? ' Экран рисует ваша страница ui/index.html: поля, таблицы, графики на canvas или SVG; Flux даёт только мост flux.* и необязательный набор оформления.' : ''}</p>
        <div className="row"><button className="fx-btn fx-btn-primary" type="submit" disabled={!form.id.trim() || !form.name.trim()}>Создать проект</button></div>
      </form>

      <h3>Проекты на этом компьютере</h3>
      {drafts.length === 0 ? <div className="empty">Проектов пока нет. Создайте новый из заготовки или откройте свою программу ниже.</div> : (
        <table className="fx-table"><thead><tr><th>Проект</th><th>Язык</th><th>Версия</th><th></th></tr></thead>
          <tbody>{drafts.map(d => (
            <tr key={d.id} aria-selected={d.id === current}>
              <td>{d.name} <span className="muted code">{d.id}</span></td><td>{d.language}</td><td>{d.version}</td>
              <td className="end"><button className="fx-btn" onClick={() => onOpen(d.id)} disabled={d.id === current}>{d.id === current ? 'Открыт' : 'Открыть'}</button></td>
            </tr>))}</tbody></table>
      )}

      {own.length > 0 && <>
        <h3>Ваши программы в общей базе</h3>
        <table className="fx-table"><thead><tr><th>Программа</th><th>Версия</th><th>Последняя отправка</th><th></th></tr></thead>
          <tbody>{own.map(r => (
            <tr key={r.moduleId}><td className="code">{r.moduleId}</td><td>{r.version}</td><td>{r.createdAt.slice(0, 10)}</td>
              <td className="end"><button className="fx-btn" onClick={() => importRequest(r.id)}>Открыть как проект</button></td></tr>))}</tbody></table>
      </>}

      {current && tree && <>
        <h3>Файлы проекта «{current}»</h3>
        <table className="fx-table"><thead><tr><th>Файл</th><th>Размер</th></tr></thead>
          <tbody>{tree.files.map(f => <tr key={f.path}><td className="code">{f.path}</td><td>{kb(f.size)}</td></tr>)}</tbody></table>
        <Run id={current} />
      </>}

      <h3>Тестовая база</h3>
      <p className="fx-hint">SQLite с образцами в каталоге данных Studio. Рабочей базы в ней нет; сброс возвращает образцы.</p>
      {base && <div className="counts">{Object.entries(base.counts).map(([k, v]) => <span key={k} className="chip">{LABELS[k] || k}: {v}</span>)}</div>}
      <div className="row"><button className="fx-btn" onClick={async () => { try { await call('testBaseReset'); await reload(); } catch (e) { fail(e); } }}>Сбросить тестовую базу</button></div>
      </div>
    </section>
  );
}
