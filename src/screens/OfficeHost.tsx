/**
 * Документ Flux Office: редактор Word внутри окна Flux.
 *
 * Сам редактор — собранный интерфейс GenOffice (tools/genoffice/build.mjs),
 * он живёт во фрейме и ничего не знает ни о сервере, ни о диске. Всё, что ему
 * нужно от внешнего мира, он спрашивает через мост (flux-bridge.js), а
 * отвечает это окно:
 *   - «открыть» — байты файла Проводника и его хеш;
 *   - «сохранить» — запись целиком со сверкой: если файл поменял кто-то
 *     другой, запись не идёт, и человек сам решает, что делать;
 *   - «сохранить как» — копия в той же папке;
 *   - закрытие окна — спросить редактор, есть ли несохранённое, и сохранить;
 *   - комната файла: правит один (держатель), остальные смотрят и после
 *     каждого его сохранения получают свежую версию на месте
 *     (components/collab/useOfficeRoom.ts, server/officeRooms.ts).
 *
 * Правила переписки — lib/officeBridge.ts. Сервер — server/routes/officeFiles.ts.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Btn, Dialog, Empty } from '../components/ui';
import { useOfficeRoom } from '../components/collab/useOfficeRoom';
import OfficePresence from '../components/collab/OfficePresence';
import { useWindowTitle, usePaneId } from '../lib/paneTitle';
import { guardClose } from '../lib/closeGuard';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import { fileBytes } from '../lib/fileBytes';
import {
  isOfficeMsg, pathOf, fileIdOf, targetOrigin, fromOwnFrame, sha256Hex, copyName,
} from '../lib/officeBridge';

const EDITOR_URL = 'genoffice/docs/index.html';
/** Сколько ждать первого слова моста, прежде чем сказать «редактор не собран» */
const HELLO_MS = 15_000;

type Phase = 'loading' | 'ready' | 'missing';
/** stale — файл сохранил другой; locked — правку держит другой */
interface Conflict { fileId: string; bytes: ArrayBuffer; why: 'stale' | 'locked'; holder?: string }

export default function OfficeHost() {
  const [params, setParams] = useSearchParams();
  const fileId = params.get('file') || '';
  const paneId = usePaneId();
  const theme = useStore((s) => s.theme);
  const addToast = useToastStore((s) => s.addToast);

  const frame = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [name, setName] = useState('');
  const [frameKey, setFrameKey] = useState(0);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState(false);
  /** С какой версии каждого файла началась правка — для сверки при записи */
  const base = useRef(new Map<string, string>());
  const names = useRef(new Map<string, string>());
  /** Ответы редактора на вопросы окна: закрытие ждёт их */
  const waits = useRef(new Map<string, (v: any) => void>());
  const phaseRef = useRef<Phase>('loading');
  phaseRef.current = phase;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  /** Правлю ли я сейчас. До ответа комнаты — нет: сначала узнать, не правит ли другой */
  const [editable, setEditable] = useState(false);
  const editableRef = useRef(false);
  editableRef.current = editable;
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const room = useOfficeRoom(fileId, () => {
    // Держатель сохранил — зрителю показать свежее. Правящему не нужно:
    // сохранял либо он сам, либо (после обрыва) он уже не держатель
    if (!editableRef.current) void refreshRef.current();
  });
  const holderName = room.roster?.holder && room.roster.holder.clientId !== room.clientId ? room.roster.holder.name : '';
  const holderRef = useRef('');
  holderRef.current = holderName;

  useWindowTitle(name);

  const send = useCallback((msg: object) => {
    frame.current?.contentWindow?.postMessage({ flux: 'office', ...msg }, targetOrigin(window.location.origin));
  }, []);

  /** Событие редактору и ожидание его ответа; молчание — null */
  const askFrame = useCallback(<T,>(event: string, answer: string, ms: number): Promise<T | null> =>
    new Promise((resolve) => {
      const done = (v: any) => { if (waits.current.get(answer) === done) waits.current.delete(answer); resolve(v); };
      waits.current.set(answer, done);
      send({ event });
      setTimeout(() => done(null), ms);
    }), [send]);

  const open = useCallback(async () => {
    if (!fileId) return null;
    const [bytes, meta] = await Promise.all([
      fileBytes(fileId),
      fetch(`/api/office/files/${encodeURIComponent(fileId)}/meta`).then((r) => r.json()),
    ]);
    // Хеш считаем от тех байтов, что отдали редактору, а не берём у сервера:
    // между двумя запросами файл мог смениться, и сверка шла бы не с тем
    const sha = await sha256Hex(bytes);
    base.current.set(fileId, sha);
    names.current.set(fileId, String(meta?.name || 'Документ'));
    setName(String(meta?.name || ''));
    return { fileId, name: String(meta?.name || 'Документ.docx'), bytes, sha256: sha };
  }, [fileId]);

  const save = useCallback(async (p: { path?: string; bytes: ArrayBuffer; auto?: boolean }) => {
    const id = fileIdOf(p?.path) || fileId;
    const from = base.current.get(id);
    if (!id || !from) return { ok: false, error: 'Файл не открыт — сохранять некуда' };
    // Правку держит другой. Сюда попадают правки, сделанные до того, как её
    // забрали (обрыв связи дольше паузы): их не выбрасываем, а предлагаем
    // сохранить рядом
    if (id === fileId && !editableRef.current) {
      if (p.auto) return { ok: false, reason: 'external-modified' };
      // Ctrl+S у зрителя без правок — не повод для окна выбора: редактор
      // сохраняет и нетронутый документ
      const st = await askFrame<{ dirty: boolean }>('closeCheck', 'closeCheck', 2000);
      if (!st?.dirty) {
        addToast(holderRef.current ? `Только просмотр: файл правит ${holderRef.current}` : 'Только просмотр', 'info');
        return { ok: false, reason: 'external-modified' };
      }
      setConflict((c) => c || { fileId: id, bytes: p.bytes.slice(0), why: 'locked', holder: holderRef.current });
      return { ok: false, reason: 'external-modified' };
    }
    const res = await fetch(`/api/office/files/${encodeURIComponent(id)}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Base-Sha256': from },
      body: p.bytes,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      base.current.set(id, data.sha256);
      if (id === fileId && !data.unchanged) room.saved(data.sha256);
      return { ok: true };
    }
    if (res.status === 409 || res.status === 423) {
      // Правка человека не пропадает: байты держим до его решения
      setConflict((c) => c || {
        fileId: id, bytes: p.bytes.slice(0),
        why: res.status === 423 ? 'locked' : 'stale', holder: String(data?.holder || ''),
      });
      return { ok: false, reason: 'external-modified' };
    }
    return { ok: false, error: String(data?.error || `сервер ответил ${res.status}`) };
  }, [fileId, room.saved, askFrame, addToast]);

  const saveCopy = useCallback(async (fromId: string, wanted: string, bytes: ArrayBuffer) => {
    const res = await fetch(`/api/office/files/${encodeURIComponent(fromId)}/copy?name=${encodeURIComponent(wanted)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.id) throw new Error(String(data?.error || `сервер ответил ${res.status}`));
    base.current.set(data.id, data.sha256);
    names.current.set(data.id, data.name);
    return data as { id: string; name: string };
  }, []);

  // Переписка с редактором
  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (!fromOwnFrame(e.source, frame.current?.contentWindow, e.origin, window.location.origin)) return;
      const m = e.data;
      if (!isOfficeMsg(m)) return;
      if (m.op === 'hello') { setPhase('ready'); return; }
      const wait = waits.current.get(m.op);
      if (wait) { wait(m.payload); return; }
      if (m.id === undefined) return;
      const reply = (result: unknown) => send({ reply: m.id, result });
      try {
        if (m.op === 'open') reply(await open());
        else if (m.op === 'isBlank') reply(false);
        else if (m.op === 'theme') reply(themeRef.current);
        else if (m.op === 'save') reply(await save(m.payload));
        else if (m.op === 'saveCopy') {
          const from = fileIdOf(m.payload?.path) || fileId;
          const made = await saveCopy(from, String(m.payload?.name || ''), m.payload?.bytes);
          setName(made.name);
          addToast(`Сохранено копией: «${made.name}»`, 'success');
          reply({ ok: true, path: pathOf(made.id) });
        } else reply(null);
      } catch (err: any) {
        const error = String(err?.message || err);
        send({ reply: m.id, result: { ok: false, error } });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [open, save, saveCopy, send, fileId, addToast]);

  // Тема Flux — тема редактора
  useEffect(() => { if (phase === 'ready') send({ event: 'theme', payload: theme }); }, [theme, phase, send]);

  /** Свежая версия файла — в редактор на месте, без перезагрузки окна */
  const refresh = useCallback(async () => {
    const r = await open().catch(() => null);
    if (r) send({ event: 'open', payload: r });
  }, [open, send]);
  refreshRef.current = refresh;

  // Правлю или смотрю — по комнате. Перед тем как дать правку, показать то,
  // что сейчас в файле: зритель мог смотреть на версию до последнего
  // сохранения, и правка поверх неё ушла бы в отказ сверки
  useEffect(() => {
    if (phase !== 'ready') return;
    const mine = room.mode === 'edit' || room.mode === 'alone';
    if (!mine) { setEditable(false); return; }
    if (editableRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const meta = await fetch(`/api/office/files/${encodeURIComponent(fileId)}/meta`).then((r) => r.json());
        if (!cancelled && meta?.sha256 && meta.sha256 !== base.current.get(fileId)) await refresh();
      } catch (_) { /* без сверки: сохранение всё равно сверит хеш */ }
      if (!cancelled) setEditable(true);
    })();
    return () => { cancelled = true; };
  }, [room.mode, phase, fileId, refresh]);

  useEffect(() => { if (phase === 'ready') send({ event: 'readOnly', payload: !editable }); }, [editable, phase, send]);

  const takeEdit = async () => {
    const why = await room.take();
    if (why) addToast(why, 'error');
  };

  // Мост молчит — значит, редактора нет (не собран) или вместо него отдали
  // чужую страницу. Белый фрейм без объяснений хуже честного «нет»
  const onFrameLoad = useCallback(() => {
    try {
      const title = frame.current?.contentDocument?.title;
      if (title !== undefined && title !== 'Flux Office') { setPhase('missing'); return; }
    } catch (_) { /* с диска документ фрейма закрыт — ждём моста */ }
    setTimeout(() => { if (phaseRef.current === 'loading') setPhase('missing'); }, HELLO_MS);
  }, []);

  // Закрытие окна: несохранённое сохраняется, а не теряется
  useEffect(() => {
    if (!paneId.startsWith('win:')) return;
    return guardClose(paneId.slice(4), async () => {
      if (phaseRef.current !== 'ready') return true;
      const state = await askFrame<{ dirty: boolean }>('closeCheck', 'closeCheck', 4000);
      if (!state?.dirty) return true;
      const ok = await askFrame<boolean>('closeSave', 'closeSaveResult', 120_000);
      if (ok) return true;
      addToast('Документ не сохранён. Окно оставлено открытым, чтобы правка не пропала', 'error');
      return false;
    });
  }, [paneId, askFrame, addToast]);

  const reopen = (id: string) => {
    base.current.delete(id);
    setPhase('loading');
    setConflict(null);
    if (id !== fileId) setParams({ file: id }, { replace: true });
    setFrameKey((k) => k + 1);
  };

  const keepMine = async () => {
    if (!conflict) return;
    setBusy(true);
    try {
      const made = await saveCopy(conflict.fileId, copyName(names.current.get(conflict.fileId) || name), conflict.bytes);
      addToast(`Ваши правки сохранены рядом: «${made.name}»`, 'success');
      reopen(made.id);
    } catch (err: any) {
      addToast(`Копия не сохранена: ${err?.message || err}`, 'error');
    } finally { setBusy(false); }
  };

  if (!fileId) {
    return <Empty title="Файл не выбран" text="Откройте документ Word из Проводника: «Открыть в: Документ (проба)»." />;
  }
  if (phase === 'missing') {
    return (
      <Empty title="Редактор не установлен"
        text="В этой сборке нет нового редактора Flux Office. Откройте файл прежним Документом или обновите программу." />
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <OfficePresence roster={room.roster} clientId={room.clientId} mode={room.mode} editable={editable} onTake={takeEdit} />
      <div className="relative min-h-0 flex-1">
      <iframe
        key={`${fileId}:${frameKey}`}
        ref={frame}
        src={EDITOR_URL}
        title="Документ Flux Office"
        onLoad={onFrameLoad}
        className="absolute inset-0 h-full w-full border-0 bg-white"
      />
      {phase === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/70 dark:bg-slate-900/70 text-sm text-slate-500">
          Открывается…
        </div>
      )}
      </div>
      {conflict && (
        <Dialog title={conflict.why === 'locked' ? 'Файл сейчас правит другой сотрудник' : 'Файл изменили, пока он был открыт'}
          onClose={() => setConflict(null)} busy={busy} width="max-w-lg"
          footer={<>
            <Btn tone="ghost" disabled={busy} onClick={() => setConflict(null)}>Отмена</Btn>
            <Btn tone="danger" disabled={busy} onClick={() => reopen(conflict.fileId)}>Открыть свежую версию</Btn>
            <Btn tone="primary" disabled={busy} onClick={keepMine}>Сохранить мои правки рядом</Btn>
          </>}>
          {conflict.why === 'locked'
            ? <p>{conflict.holder ? `Правку файла держит ${conflict.holder}` : 'Правку файла держит другой сотрудник'}: пока не было связи, её отдали ему. Ваши правки не записаны поверх — его работа не пропала.</p>
            : <p>Кто-то сохранил этот документ после того, как вы его открыли. Ваши правки не записаны поверх — чужая работа не пропала.</p>}
          <p className="mt-2">«Сохранить мои правки рядом» положит ваш вариант отдельным файлом в ту же папку. «Открыть свежую версию» покажет сохранённое другим, а ваши несохранённые правки будут потеряны.</p>
        </Dialog>
      )}
    </div>
  );
}
