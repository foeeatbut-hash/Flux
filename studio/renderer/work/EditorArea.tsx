/**
 * Центр рабочего окна: вкладки открытых файлов.
 *
 * form.json открывается существующими редакторами формы и кода (editors/index.tsx), остальной текст — редактором кода
 * с подсветкой (HTML, CSS, JS, TS и др.), картинки — просмотром. Явное сохранение (Ctrl+S) с отметкой несохранённого —
 * как в Visual Studio: правка не уходит на диск полусловом, а git и внешние редакторы не спорят с набором на лету;
 * перед запуском, проверкой и публикацией несохранённое сохраняется само. Файл, изменённый снаружи при несохранённых
 * правках, не перезаписывается молча: вкладка спрашивает «перечитать / оставить моё» (studio/shared/conflict.ts).
 */
import React, { Suspense, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { EditorDraft } from '../../shared/editorContract';
import { reconcile } from '../../shared/conflict';
import { call } from '../call';
import { CodeView, type MarkedLine } from '../editors/CodeView';
import type { AnchoredNote } from '../../shared/ownerNotes';
import { IMAGE_FILE, languageOfFile, MIME } from './helpers';
import type { Entry } from './FileTree';

const Editors = React.lazy(() => import('studio-editors'));
const FORM_VIEW = 'form.json';

interface Buffer { saved: string; text: string; state: 'text' | 'image' | 'binary' | 'missing'; size: number; image?: string; conflict?: string | null; removed?: boolean }
export interface EditorAreaHandle {
  open: (path: string, line?: number) => void;
  saveAll: () => Promise<boolean>;
  external: (changes: Array<{ path: string; kind: string }>) => void;
  renamed: (from: string, to: string) => void;
  deleted: (path: string) => void;
  dirty: () => string[];
}

const EditorArea = forwardRef<EditorAreaHandle, { id: string; entries: Entry[]; notes?: AnchoredNote[]; onDirty: (paths: string[]) => void; onError: (text: string) => void; onSaved: () => void }>(function EditorArea({ id, entries, notes, onDirty, onError, onSaved }, ref) {
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState('');
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const [reveal, setReveal] = useState<{ path: string; line: number; nonce: number } | null>(null);
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const live = useRef(buffers);
  live.current = buffers;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  useEffect(() => { onDirty(Object.entries(buffers).filter(([, b]) => b.text !== b.saved).map(([p]) => p)); }, [buffers]);

  const read = useCallback(async (path: string): Promise<Buffer> => {
    const entry = entriesRef.current.find(e => e.path === path);
    if (IMAGE_FILE.test(path) && !path.endsWith('.svg')) {
      const r = await call<{ base64?: string; size: number }>('draftBinary', { id, path }).catch(() => null);
      return { saved: '', text: '', state: r ? 'image' : 'binary', size: r?.size ?? entry?.size ?? 0, image: r?.base64 ? `data:${MIME[path.split('.').pop()!.toLowerCase()]};base64,${r.base64}` : undefined };
    }
    const r = await call<{ text: string | null; size: number }>('draftFile', { id, path });
    return r.text === null ? { saved: '', text: '', state: 'binary', size: r.size } : { saved: r.text, text: r.text, state: 'text', size: r.size };
  }, [id]);

  const open = useCallback(async (path: string, line?: number) => {
    try {
      if (!live.current[path] && path !== FORM_VIEW) { const b = await read(path); setBuffers(x => ({ ...x, [path]: b })); }
      setTabs(t => t.includes(path) ? t : [...t, path]);
      setActive(path);
      if (line) setReveal({ path, line, nonce: Date.now() });
    } catch (e) { onError((e as Error).message); }
  }, [read, onError]);

  const loadDraft = useCallback(async () => {
    const files: Record<string, string> = {};
    const list = entriesRef.current.filter(e => !e.dir && !e.ignored);
    for (const f of list.filter(x => x.text)) files[f.path] = (await call<{ text: string | null }>('draftFile', { id, path: f.path })).text ?? '';
    setDraft({ files, binary: list.filter(x => !x.text).map(x => x.path) });
  }, [id]);
  // Редакторы формы и кода видят проект целиком; перечитываем при открытии и когда файлы проекта изменились
  const signature = entries.filter(e => !e.dir && !e.ignored).map(e => `${e.path}:${e.size}`).join('|');
  useEffect(() => { if (tabs.includes(FORM_VIEW)) void loadDraft().catch(e => onError((e as Error).message)); }, [tabs.includes(FORM_VIEW), signature]);

  const save = useCallback(async (path: string) => {
    const b = live.current[path];
    if (!b || b.state !== 'text' || b.text === b.saved && !b.removed) return true;
    try {
      await call('draftSave', { id, path, text: b.text });
      setBuffers(x => ({ ...x, [path]: { ...x[path], saved: b.text, conflict: null, removed: false } }));
      onSaved();
      return true;
    } catch (e) { onError(`${path}: ${(e as Error).message}`); return false; }
  }, [id, onError, onSaved]);

  useImperativeHandle(ref, () => ({
    open: (path, line) => { void open(path, line); },
    saveAll: async () => {
      for (const [path, b] of Object.entries(live.current)) if (b.state === 'text' && (b.text !== b.saved || b.removed)) if (!(await save(path))) return false;
      return true;
    },
    dirty: () => Object.entries(live.current).filter(([, b]) => b.text !== b.saved).map(([p]) => p),
    external: changes => {
      for (const ch of changes) {
        const b = live.current[ch.path];
        if (!b || b.state !== 'text') { if (b && ch.kind !== 'removed') void read(ch.path).then(nb => setBuffers(x => ({ ...x, [ch.path]: nb }))).catch(() => {}); continue; }
        if (ch.kind === 'removed') { setBuffers(x => ({ ...x, [ch.path]: { ...x[ch.path], removed: true } })); continue; }
        void call<{ text: string | null }>('draftFile', { id, path: ch.path }).then(r => {
          const cur = live.current[ch.path];
          if (!cur || r.text === null) return;
          const verdict = reconcile(cur.saved, cur.text, r.text);
          if (verdict === 'reload') setBuffers(x => ({ ...x, [ch.path]: { ...x[ch.path], saved: r.text!, text: r.text!, conflict: null, removed: false } }));
          else if (verdict === 'ask') setBuffers(x => ({ ...x, [ch.path]: { ...x[ch.path], conflict: r.text } }));
        }).catch(() => {});
      }
      if (draft) void loadDraft().catch(() => {});
    },
    renamed: (from, to) => {
      setTabs(t => t.map(p => p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p));
      setActive(a => a === from ? to : a.startsWith(`${from}/`) ? `${to}${a.slice(from.length)}` : a);
      setBuffers(x => Object.fromEntries(Object.entries(x).map(([p, b]) => [p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p, b])));
    },
    deleted: path => {
      const gone = (p: string) => p === path || p.startsWith(`${path}/`);
      setTabs(t => t.filter(p => !gone(p)));
      setBuffers(x => Object.fromEntries(Object.entries(x).filter(([p]) => !gone(p))));
      setActive(a => gone(a) ? '' : a);
    },
  }), [open, read, save, id, draft, loadDraft]);

  // Ctrl+S сохраняет открытый файл
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (active) void save(active); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, save]);

  const close = (path: string) => {
    const b = buffers[path];
    if (b && b.text !== b.saved && !window.confirm(`В «${path}» есть несохранённые правки. Закрыть без сохранения?`)) return;
    setTabs(t => { const n = t.filter(p => p !== path); if (active === path) setActive(n[n.length - 1] || ''); return n; });
    setBuffers(x => { const { [path]: _gone, ...rest } = x; return rest; });
  };

  // Метка владельца у строки; текст — по наведению (подсказка редактора). Изменившаяся с тех пор строка помечена в тексте
  const marks: MarkedLine[] = useMemo(() => (notes || []).filter(n => n.path === active && n.currentLine).map(n => ({
    line: n.currentLine!, column: 1, severity: 'warning' as const, message: `Владелец: ${n.text}${n.changed ? ' (строка с тех пор изменилась)' : ''}`,
  })), [notes, active]);
  const b = buffers[active];
  return (
    <div className="studio-editor">
      <div className="studio-tabs" role="tablist" aria-label="Открытые файлы">
        {tabs.map(p => {
          const dirty = buffers[p] && buffers[p].text !== buffers[p].saved;
          return (
            <div key={p} className={`studio-tab${active === p ? ' is-on' : ''}`} role="presentation">
              <button type="button" role="tab" aria-selected={active === p} onClick={() => setActive(p)} title={p}>
                {p.split('/').pop()}{dirty && <span className="studio-dirty" aria-label="не сохранён" title="Не сохранён">●</span>}</button>
              <button type="button" className="studio-tab-x" aria-label={`Закрыть ${p}`} onClick={() => close(p)}><X /></button>
            </div>);
        })}
      </div>
      <div className="studio-editor-body">
        {!active && <div className="fx-empty-note">Откройте файл слева. Запустить, проверить и опубликовать программу можно кнопками сверху.</div>}
        {active === FORM_VIEW && (
          <Suspense fallback={<div className="fx-empty-note">Загрузка редактора…</div>}>
            {draft && <Editors moduleId={id} draft={draft} onChange={async changed => {
              try { for (const [path, text] of Object.entries(changed)) await call('draftSave', { id, path, text }); await loadDraft(); onSaved(); return ''; } catch (e) { return (e as Error).message; }
            }} />}
          </Suspense>)}
        {active && active !== FORM_VIEW && b?.state === 'text' && (<>
          {b.conflict != null && (
            <div className="studio-banner warn" role="alert">Файл изменён снаружи, а у вас есть несохранённые правки.
              <button type="button" className="fx-btn" onClick={() => setBuffers(x => ({ ...x, [active]: { ...x[active], saved: b.conflict!, text: b.conflict!, conflict: null } }))}>Перечитать с диска</button>
              <button type="button" className="fx-btn" onClick={() => setBuffers(x => ({ ...x, [active]: { ...x[active], saved: b.conflict!, conflict: null } }))}>Оставить моё</button></div>)}
          {b.removed && <div className="studio-banner warn" role="alert">Файл удалён снаружи. Сохраните (Ctrl+S), чтобы создать его заново, или закройте вкладку.</div>}
          <CodeView key={active} value={b.text} language={languageOfFile(active)} label={`Файл ${active}`} testId="file-editor"
            reveal={reveal && reveal.path === active ? reveal : null} marks={marks}
            onChange={text => setBuffers(x => x[active] ? { ...x, [active]: { ...x[active], text } } : x)} />
        </>)}
        {active && active !== FORM_VIEW && b?.state === 'image' && <div className="studio-image"><img src={b.image} alt={active} /></div>}
        {active && active !== FORM_VIEW && b?.state === 'binary' && <div className="fx-empty-note">Двоичный файл ({Math.ceil(b.size / 1024)} КиБ): в Studio он не редактируется.</div>}
      </div>
    </div>
  );
});
export default EditorArea;
