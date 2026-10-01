import { useFileProject } from '../lib/useFileProject';
/**
 * Редактор заметки Блокнота — Markdown Flux Office (GenOffice) во фрейме.
 *
 * Хозяин не знает, где лежит текст: заметка Блокнота, стикер или файл .md
 * Проводника отдают ему `load` и `save`. Он держит переписку с мостом
 * (tools/genoffice/md-bridge.js):
 *   - «open» — текст и путь вещи; «save» — текст на запись;
 *   - «dirty» — есть несохранённое: через SAVE_MS окно само просит редактор
 *     сохранить (Блокнот сохраняет сам, кнопки «Сохранить» ждать не надо);
 *   - «exportDocx» — редактор собрал настоящий .docx: он ложится файлом в
 *     «Выгрузки» и открывается Документом;
 *   - «print» — редактор собрал страницу для печати в PDF.
 * Снаружи — flush(): перед сменой заметки и закрытием окна несохранённое
 * записывается, а не теряется.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import { usePaneId } from '../lib/paneTitle';
import { guardClose } from '../lib/closeGuard';
import { isOfficeMsg, targetOrigin, fromOwnFrame } from '../lib/officeBridge';
import { saveNewFile, editorHref } from '../lib/officeFiles';
import { dataService } from '../services/dataService';
import { useTagNavigationStore } from '../store/tagNavigationStore';
import FluxPanel from '../components/office/FluxPanel';
import { Empty } from '../components/ui';

const EDITOR_URL = 'genoffice/markdown/index.html';
const HELLO_MS = 15_000;
/** Через сколько после первой правки заметка записывается сама */
const SAVE_MS = 3_000;

export type NoteSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface NoteEditorHandle {
  /** Записать несохранённое; false — записать не удалось */
  flush(): Promise<boolean>;
  /** Выгрузить в настоящий .docx (ляжет в «Выгрузки» и откроется Документом) */
  exportDocx(): void;
  print(): void;
}

interface Props {
  /** Путь вещи для редактора: flux://note/<id> или flux://file/<id> */
  path: string;
  /** Имя для выгрузки и печати */
  name: string;
  load: () => Promise<string>;
  save: (text: string) => Promise<void>;
  /** Стикер: без ленты */
  compact?: boolean;
  /** Открыта только на чтение: правка и запись закрыты */
  readOnly?: boolean;
  onState?: (s: NoteSaveState) => void;
  /** Редактор открыл текст — можно просить его о выгрузке и печати */
  onReady?: (ed: NoteEditorHandle) => void;
}

const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Напечатать готовую страницу, не печатая окно Flux целиком */
function printHtml(html: string): Promise<void> {
  return new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;right:100%;bottom:100%;width:0;height:0;border:0';
    f.onload = () => {
      try { f.contentWindow?.focus(); f.contentWindow?.print(); } finally {
        setTimeout(() => { f.remove(); resolve(); }, 1000);
      }
    };
    f.srcdoc = html;
    document.body.appendChild(f);
  });
}

const fileName = (name: string) => (String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'Заметка').slice(0, 120);

function tagAtClick(doc: Document, event: MouseEvent): string | null {
  const root = doc.querySelector('.ProseMirror');
  if (!root) return null;
  const extended = doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null; caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  let node: Node | null = null;
  let offset = -1;
  const range = extended.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (range) { node = range.startContainer; offset = range.startOffset; }
  else {
    const caret = extended.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (caret) { node = caret.offsetNode; offset = caret.offset; }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null;
  const text = node.textContent || '';
  const re = /(^|[^\p{L}\p{N}_])#([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*)/gu;
  for (let m: RegExpExecArray | null; (m = re.exec(text));) {
    const start = m.index + m[1].length;
    const end = start + m[0].length - m[1].length;
    if (offset >= start && offset < end) return m[2];
  }
  return null;
}

const NoteEditorHost = forwardRef<NoteEditorHandle, Props>(function NoteEditorHost(
  { path, name, load, save, compact = false, readOnly = false, onState, onReady }, ref,
) {
  const navigate = useNavigate();
  const paneId = usePaneId();
  const theme = useStore((s) => s.theme);
  const addToast = useToastStore((s) => s.addToast);
  const linkedFileId = path.startsWith('flux://file/') ? path.slice('flux://file/'.length) : '';
  const activeProjectId = useFileProject(linkedFileId);
  const frame = useRef<HTMLIFrameElement>(null);
  const [fluxOpen, setFluxOpen] = useState(false);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'missing'>('loading');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waits = useRef(new Map<string, (v: any) => void>());
  // Последние load/save/name — без перезапуска переписки на каждую отрисовку
  const io = useRef({ load, save, name, onState, onReady, readOnly });
  io.current = { load, save, name, onState, onReady, readOnly };
  const handle = useRef<NoteEditorHandle | null>(null);
  const tagClickOpener = useRef<(value: string, byId?: boolean) => void>(() => {});
  const clickBinding = useRef<{ doc: Document; handler: (event: MouseEvent) => void } | null>(null);

  const openKnownTag = useCallback(async (value: string, byId = false) => {
    const projectId = activeProjectId;
    if (!projectId || !value) return;
    try {
      const result = await dataService.getTags(projectId);
      const tags = result?.tags || [];
      const tag = byId
        ? tags.find((item: any) => String(item.id) === value)
        : tags.find((item: any) => String(item.identifier || '').trim().toLocaleLowerCase() === value.trim().toLocaleLowerCase());
      if (tag) useTagNavigationStore.getState().open({ projectId, tagId: tag.id, identifier: tag.identifier });
    } catch { /* неизвестный или недоступный тег не превращаем в ссылку */ }
  }, [activeProjectId]);
  tagClickOpener.current = (value, byId) => { void openKnownTag(value, byId); };

  const send = useCallback((msg: object) => {
    frame.current?.contentWindow?.postMessage({ flux: 'office', ...msg }, targetOrigin(window.location.origin));
  }, []);
  const state = (s: NoteSaveState) => io.current.onState?.(s);

  /** Событие редактору и ожидание ответа; молчание — null */
  const askFrame = useCallback(<T,>(event: string, payload: unknown, answer: string, ms: number): Promise<T | null> =>
    new Promise((resolve) => {
      const done = (v: any) => { if (waits.current.get(answer) === done) waits.current.delete(answer); resolve(v); };
      waits.current.set(answer, done);
      send({ event, payload });
      setTimeout(() => done(null), ms);
    }), [send]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (phaseRef.current !== 'ready' || !dirty.current) return true;
    const ok = await askFrame<boolean>('closeSave', null, 'closeSaveResult', 30_000);
    return ok === true;
  }, [askFrame]);

  useImperativeHandle(ref, () => {
    handle.current = {
      flush,
      exportDocx: () => send({ event: 'export', payload: 'docx' }),
      print: () => send({ event: 'print', payload: null }),
    };
    return handle.current;
  }, [flush, send]);

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (!fromOwnFrame(e.source, frame.current?.contentWindow, e.origin, window.location.origin)) return;
      const m = e.data;
      if (!isOfficeMsg(m)) return;
      if (m.op === 'hello') {
        setPhase('ready');
        send({ event: 'compact', payload: compact || readOnly });
        send({ event: 'readOnly', payload: readOnly });
        return;
      }
      if (m.op === 'flux:open-panel') { setFluxOpen(true); return; }
      const wait = waits.current.get(m.op);
      if (wait) { wait(m.payload); return; }
      if (m.op === 'dirty') {
        dirty.current = m.payload === true;
        if (dirty.current) {
          state('dirty');
          if (!timer.current) {
            timer.current = setTimeout(() => { timer.current = null; send({ event: 'saveRequest', payload: 'save' }); }, SAVE_MS);
          }
        }
        return;
      }
      if (m.op === 'notice') { addToast(String(m.payload || ''), 'info'); return; }
      if (m.op === 'openLink') {
        const tag = /^flux:tag\/(.+)$/.exec(String(m.payload || ''));
        if (tag) tagClickOpener.current(tag[1], true);
        return;
      }
      if (m.id === undefined) return;
      const reply = (result: unknown) => send({ reply: m.id, result });
      try {
        if (m.op === 'open') {
          reply({ path, text: await io.current.load() });
          // Редактору нужно мгновение, чтобы разложить текст, — потом он готов к выгрузке
          setTimeout(() => { if (handle.current) io.current.onReady?.(handle.current); }, 300);
        } else if (m.op === 'theme') {
          reply(theme);
        } else if (m.op === 'save') {
          if (io.current.readOnly) { reply({ ok: false, error: 'Заметка открыта только на чтение' }); return; }
          state('saving');
          await io.current.save(String(m.payload?.text ?? ''));
          state('saved');
          reply({ ok: true });
        } else if (m.op === 'exportDocx') {
          const made = await saveNewFile(b64ToBytes(String(m.payload?.base64 || '')), `${fileName(io.current.name)}.docx`, 'exports');
          addToast(`Выгружено в «Выгрузки»: ${made.name}`, 'success');
          navigate(editorHref(made));
          reply({ ok: true, path: made.name });
        } else if (m.op === 'print') {
          // «Выгрузить в PDF» редактора: страница печати — в системную печать,
          // там «Сохранить как PDF»
          await printHtml(String(m.payload?.html || ''));
          reply({ ok: true });
        } else reply(null);
      } catch (err: any) {
        if (m.op === 'save') state('error');
        send({ reply: m.id, result: { ok: false, error: String(err?.message || err) } });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [path, compact, readOnly, theme, send, addToast, navigate]);

  useEffect(() => { if (phase === 'ready') send({ event: 'theme', payload: theme }); }, [theme, phase, send]);
  useEffect(() => { if (phase === 'ready') send({ event: 'compact', payload: compact || readOnly }); }, [compact, readOnly, phase, send]);

  // Закрытие окна: несохранённое записывается, окно не закрывается, пока
  // запись не удалась
  useEffect(() => {
    if (!paneId.startsWith('win:')) return;
    return guardClose(paneId.slice(4), async () => {
      if (await flush()) return true;
      addToast('Заметка не записана. Окно оставлено открытым, чтобы текст не пропал', 'error');
      return false;
    });
  }, [paneId, flush, addToast]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onFrameLoad = useCallback(() => {
    if (clickBinding.current) clickBinding.current.doc.removeEventListener('click', clickBinding.current.handler, true);
    try {
      const doc = frame.current?.contentDocument;
      const title = doc?.title;
      if (title !== undefined && title !== 'Flux Office') { setPhase('missing'); return; }
      if (doc) {
        const handler = (event: MouseEvent) => {
          const target = event.target as Element | null;
          if (target?.nodeType === 1 && typeof target.closest === 'function' && target.closest('a')) return;
          const identifier = tagAtClick(doc, event);
          if (identifier) tagClickOpener.current(identifier);
        };
        doc.addEventListener('click', handler, true);
        clickBinding.current = { doc, handler };
      }
    } catch (_) { /* с диска документ фрейма закрыт — ждём моста */ }
    setTimeout(() => { if (phaseRef.current === 'loading') setPhase('missing'); }, HELLO_MS);
  }, []);

  useEffect(() => () => {
    if (clickBinding.current) clickBinding.current.doc.removeEventListener('click', clickBinding.current.handler, true);
  }, []);

  if (phase === 'missing') {
    return <Empty title="Редактор не установлен" text="В этой сборке нет редактора Блокнота Flux Office. Обновите программу." />;
  }
  return (
    <div className="relative flex h-full min-w-0 w-full">
    <div className="relative min-w-0 h-full flex-1">
      <iframe
        key={path}
        ref={frame}
        src={EDITOR_URL}
        title="Flux Office — Блокнот"
        onLoad={onFrameLoad}
        className="absolute inset-0 h-full w-full border-0 bg-white dark:bg-slate-900"
      />
      {phase === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/70 dark:bg-slate-900/70 text-sm text-slate-500">
          Открывается…
        </div>
      )}
    </div>
      {fluxOpen && <FluxPanel fileId="" projectId={activeProjectId} editorKind="note" fileName={name} readOnly={readOnly} onClose={() => setFluxOpen(false)}
        onInsertField={f => send({ event: 'fluxInsertText', payload: f.value })}
        onInsertTable={async rows => { const r = await askFrame<{ok: boolean}>('fluxInsertTable', { rows }, 'flux:table-inserted', 10000); return !!r?.ok; }}
        onReadText={async () => { await flush(); return io.current.load(); }}
        onInsertText={text => send({ event: 'fluxInsertText', payload: text })} />}
    </div>
  );
});

export default NoteEditorHost;
