/**
 * Рабочее окно проекта: сверху три кнопки («Запустить», «Проверить», «Опубликовать»), слева дерево файлов, в центре вкладки
 * открытых файлов, внизу панель с «Запуском», «Проблемами», «Публикацией» и «Сбоями у пользователей».
 * Проект — папка на диске: главный процесс следит за ней, и всё, что добавили снаружи, появляется здесь сразу.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, FolderOpen, Hammer, Play, Search, Send, ShieldCheck } from 'lucide-react';
import { Status } from '../../../src/components/ui/controls';
import { call, type CheckReport } from '../call';
import FileTree, { type Entry } from './FileTree';
import EditorArea, { type EditorAreaHandle } from './EditorArea';
import BottomPanel, { type PanelTab } from './BottomPanel';
import PublishDialog from './PublishDialog';
import { buildProblems, isTsSource, problemsOf, type BuildReport, type Problem } from './helpers';
import { RIGHT_TEXT, RIGHT_TONE, type useKey } from './useKey';
import { formatTime, REASON_TEXT } from './historyText';
import type { AnchoredNote } from '../../shared/ownerNotes';

type Key = ReturnType<typeof useKey>;
interface Tree { folder: string; entries: Entry[] }
interface Hit { path: string; line: number; text: string }

export default function ProjectWindow({ id, onBack, keyState }: { id: string; onBack: () => void; keyState: Key }) {
  const [tree, setTree] = useState<Tree | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [panel, setPanel] = useState<PanelTab>('run');
  const [panelOpen, setPanelOpen] = useState(true);
  const [runSignal, setRunSignal] = useState(0);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [busy, setBusy] = useState('');
  const [requestsVersion, setRequestsVersion] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [notes, setNotes] = useState<{ version: string; notes: AnchoredNote[] } | null>(null);
  const [dirty, setDirty] = useState<string[]>([]);
  const [find, setFind] = useState<{ q: string; hits: Hit[] | null } | null>(null);
  const [name, setName] = useState(id);
  const area = useRef<EditorAreaHandle>(null);
  useEffect(() => { void call<Array<{ id: string; name: string }>>('drafts').then(l => setName(l.find(d => d.id === id)?.name || id)).catch(() => {}); }, [id]);

  const reload = useCallback(async () => {
    try { const t = await call<Tree>('draftTree', { id }); setTree({ folder: t.folder, entries: t.entries }); setError(''); } catch (e) { setError((e as Error).message); }
  }, [id]);

  // Слежение за папкой живёт, пока открыто окно проекта; при уходе останавливается
  useEffect(() => {
    void reload();
    void call('projectWatch', { id }).catch(e => setError((e as Error).message));
    const off = window.studio.onProject(data => {
      if (data.id !== id) return;
      void reload();
      area.current?.external(data.changes);
    });
    return () => { off(); void call('projectUnwatch').catch(() => {}); };
  }, [id, reload]);

  // Замечания владельца к строкам: читаются с сервера и переносятся на сегодняшние файлы; перечитываются после правок файлов и отправки
  const treeSignature = (tree?.entries || []).filter(e => !e.dir).map(e => `${e.path}:${e.size}:${e.mtime}`).join('|');
  useEffect(() => {
    let live = true;
    call<{ request: { version: string } | null; notes: AnchoredNote[] }>('ownerNotes', { id })
      .then(r => { if (live) setNotes(r.request ? { version: r.request.version, notes: r.notes } : null); }).catch(() => { if (live) setNotes(null); });
    return () => { live = false; };
  }, [id, requestsVersion, historyVersion, treeSignature]);

  const goto = useCallback((path: string, line?: number) => area.current?.open(path, line), []);
  const saved = useCallback(async () => { await area.current?.saveAll(); }, []);

  // «Запустить»: сохраняет открытое и запускает; ошибки запуска попадают в «Проблемы» и на вкладку запуска
  const run = async () => {
    if (!(await area.current?.saveAll())) return;
    setPanel('run'); setPanelOpen(true); setRunSignal(n => n + 1);
  };
  // «Собрать»: TypeScript собирается внутри Studio; ошибки идут в «Проблемы» с файлом и строкой
  const hasTs = (tree?.entries || []).some(e => !e.dir && isTsSource(e.path));
  const build = async () => {
    if (!(await area.current?.saveAll())) return;
    setBusy('build'); setNote('');
    try {
      const r = await call<BuildReport>('build', { id });
      setProblems(buildProblems(r.problems));
      setPanelOpen(true);
      setHistoryVersion(n => n + 1); // успешная сборка сама сохраняет версию
      if (r.problems.length) setPanel('problems'); else setNote(`Сборка прошла: файлов TypeScript — ${r.files.length}, ошибок нет.${r.historyError ? ` ${r.historyError}` : ' Версия сохранена в истории.'}`);
    } catch (e) { setProblems([{ source: 'Сборка', title: (e as Error).message, detail: '' }]); setPanel('problems'); setPanelOpen(true); }
    finally { setBusy(''); }
  };
  const check = async (forPublish = false): Promise<CheckReport | null> => {
    if (!(await area.current?.saveAll())) return null;
    setBusy('check'); setNote('');
    try {
      const report = await call<CheckReport>('check', { id });
      // Перед публикацией «что нового» не считается проблемой: его вводят в окне публикации, а отправка перепроверит всё
      const list = problemsOf(forPublish ? { items: report.items.filter(i => i.id !== 'changelog') } : report);
      setProblems(list);
      setPanelOpen(true);
      if (list.length) setPanel('problems');
      else setNote('Проверка пройдена: проблем нет.');
      return report;
    } catch (e) { setProblems([{ source: 'Проверка', title: (e as Error).message, detail: '' }]); setPanel('problems'); setPanelOpen(true); return null; }
    finally { setBusy(''); }
  };
  // «Опубликовать» сама запускает проверку: есть проблемы — список, нет — окно «что нового»
  const publish = async () => {
    const report = await check(true);
    if (report && report.items.every(i => i.status !== 'fail' || i.id === 'changelog')) setPublishing(true);
  };

  const doFind = async (q: string) => {
    setFind({ q, hits: null });
    if (q.trim().length < 2) return;
    try { setFind({ q, hits: await call<Hit[]>('fileSearch', { id, query: q }) }); } catch (e) { setError((e as Error).message); }
  };
  const bad = new Set(problems.map(p => p.path).filter(Boolean) as string[]);

  return (
    <section aria-label={`Программа ${id}`} className="studio-project studio-body">
      <header className="studio-project-bar">
        <button type="button" className="fx-btn fx-btn-quiet" onClick={onBack}><ArrowLeft />Мои программы</button>
        <div className="studio-project-title"><strong>{name}</strong><span className="code fx-hint" title={tree?.folder}>{tree?.folder}</span></div>
        <div className="studio-actions" role="toolbar" aria-label="Запуск, проверка, публикация">
          <button type="button" className="fx-btn" onClick={() => void run()}><Play />Запустить</button>
          <button type="button" className="fx-btn" disabled={busy === 'check'} onClick={() => void check()}><ShieldCheck />{busy === 'check' ? 'Проверяем…' : 'Проверить'}</button>
          <button type="button" className="fx-btn fx-btn-primary" disabled={busy === 'check'} onClick={() => void publish()}><Send />Опубликовать</button>
        </div>
        <div className="studio-project-tools">
          {hasTs && <button type="button" className="fx-ibtn" aria-label="Собрать TypeScript" title={busy === 'build' ? 'Собираем…' : 'Собрать TypeScript: ошибки по файлам и строкам'} disabled={busy === 'build'} onClick={() => void build()}><Hammer /></button>}
          <button type="button" className="fx-ibtn" aria-label="Поиск по проекту" title="Поиск по проекту" onClick={() => setFind(find ? null : { q: '', hits: null })}><Search /></button>
          <button type="button" className="fx-ibtn" aria-label="Скачать проект архивом" title="Скачать проект архивом" onClick={() => void call('projectExport', { id }).then(r => setNote((r as { saved?: boolean }).saved ? 'Архив проекта сохранён.' : '')).catch(e => setError(e.message))}><Download /></button>
          <button type="button" className="fx-ibtn" aria-label="Папка проекта" title={tree?.folder} onClick={() => setNote(`Папка проекта: ${tree?.folder}. Любой редактор и git видят те же файлы.`)}><FolderOpen /></button>
        </div>
        <Status tone={RIGHT_TONE[keyState.right]} title={RIGHT_TEXT[keyState.right]}>{RIGHT_TEXT[keyState.right].split(':')[0]}</Status>
      </header>
      {error && <p className="fx-error px-4 py-1" role="alert">{error}</p>}
      {note && <p className="fx-note px-4" role="status">{note}</p>}
      {dirty.length > 0 && <p className="fx-hint px-4" role="status">Не сохранено: {dirty.join(', ')} (Ctrl+S).</p>}
      <div className="studio-project-main">
        <aside className="studio-side">
          {find && (
            <div className="studio-find">
              <input className="fx-input" autoFocus aria-label="Поиск по проекту" placeholder="Найти в файлах" value={find.q} onChange={e => void doFind(e.target.value)} />
              {find.hits && (find.hits.length === 0 ? <p className="fx-hint">Ничего не найдено.</p> :
                <ul className="studio-hits">{find.hits.map((h, i) => <li key={i}><button type="button" onClick={() => goto(h.path, h.line)}><span className="code">{h.path}:{h.line}</span> {h.text}</button></li>)}</ul>)}
            </div>)}
          <FileTree id={id} entries={tree?.entries || []} active="" problems={bad} onOpen={p => goto(p)} onChanged={() => void reload()}
            onRenamed={(a, b) => area.current?.renamed(a, b)} onDeleted={p => area.current?.deleted(p)} onError={setError} />
        </aside>
        <div className="studio-center">
          <EditorArea ref={area} id={id} entries={tree?.entries || []} notes={notes?.notes || []} onDirty={setDirty} onError={setError} onSaved={() => void reload()} />
        </div>
      </div>
      <BottomPanel id={id} tab={panel} onTab={setPanel} open={panelOpen} onToggle={() => setPanelOpen(o => !o)} runSignal={runSignal}
        problems={problems} onProblems={setProblems} onGo={goto} right={keyState.right} onRequestRight={() => void keyState.request()} rightError={keyState.error} requestsVersion={requestsVersion} notes={notes}
        history={{ version: historyVersion, getDirty: () => area.current?.dirty() ?? [], saveAll: async () => (await area.current?.saveAll()) ?? false, onNote: setNote,
          onRolledBack: restorePoint => { setNote(`Проект возвращён к выбранной версии. Прежнее состояние сохранено: «${REASON_TEXT[restorePoint.reason]}» от ${formatTime(restorePoint.time)}.`); setHistoryVersion(n => n + 1); void reload(); } }} />
      {publishing && <PublishDialog id={id} right={keyState.right} onRequestRight={() => void keyState.request()} onClose={() => setPublishing(false)}
        onDone={message => { setPublishing(false); setNote(message); setPanel('publication'); setPanelOpen(true); setRequestsVersion(n => n + 1); setHistoryVersion(n => n + 1); void keyState.refresh(); void saved(); }} />}
    </section>
  );
}
