/**
 * Запуск программы на тестовой базе: тот же протокол flux-module://, та же изоляция (<iframe sandbox>, CSP) и тот же
 * мост (modules/bridge.ts), что во Flux. Окно читает данные не из Flux, а у главного процесса — из тестовой SQLite.
 * Журнал показывает каждое сообщение моста: чтения, сообщения программы (flux.log), расчёты и сбои.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { themeKeys, type LaunchContext, type ModuleManifest, type ThemeTokens } from '../../../modules/contract';
import { kindOfOp, type ConnectCall, type GrantAsk } from '../../../modules/connections/model';
import { PAGE_LIMITS, type WindowOptions } from '../../../modules/page/model';
import type { ProgramCall, ProgramReply } from '../../../modules/programs/model';
import { call } from '../call';
import RunDialog from './RunDialog';
import ProgramWindow, { type RunHost } from './run/ProgramWindow';
import RunConnectPrompt, { type RunGrantChoice } from './run/RunConnectPrompt';
import TestPrograms from './run/TestPrograms';
import { canOpenWindow, closeRequest, createPageBus, hangLimit, type LogRow, type Started, type WindowSpec } from './run/model';
import { pickedFromWire } from '../work/programDialog';

interface BaseContext { id: string; name: string; equipment: Array<{ id: string; name: string }>; tags: Array<{ id: string; name: string }> }

const ENTRIES: Record<string, string> = { start: 'Пуск', equipment: 'Карточка оборудования', tag: 'Карточка тега' };

function theme(): ThemeTokens {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(themeKeys.map(key => [key, style.getPropertyValue(key).trim()])) as ThemeTokens;
}

/** `signal` — счётчик нажатий «Запустить» сверху: каждое новое значение запускает программу; `onFail` — текст отказа запуска для списка «Проблемы» */
export default function Run({ id, signal = 0, onFail, onStarted }: { id: string; signal?: number; onFail?: (text: string) => void; onStarted?: () => void }) {
  const [contexts, setContexts] = useState<BaseContext[]>([]);
  const [pick, setPick] = useState({ projectId: 'p1', entry: 'equipment', entityId: 'p1-e-fan' });
  const [started, setStarted] = useState<Started | null>(null);
  const [error, setError] = useState('');
  const [log, setLog] = useState<LogRow[]>([]);
  const [shots, setShots] = useState('');
  // Ширина кадра страницы: так видно, как она ведёт себя в узком и широком окне Flux
  const [width, setWidth] = useState(0);
  const kept = useRef<Record<string, unknown>>({});
  const mainFrame = useRef<HTMLIFrameElement | null>(null);
  const notifiers = useRef(new Set<(kind: 'changed' | 'project-changed') => void>());
  const latest = useRef(pick);
  // Главный процесс держит только последний запуск: если два запуска идут подряд (верхняя «Запустить» и сразу
  // «Перезапустить») или сменился проект, ответ прежнего может прийти позже — окно с его сеансом мост бы отверг
  // и оно осталось бы пустым, поэтому опоздавший ответ отбрасывается
  const attempt = useRef(0);
  // Окна программы, открытые ею самой (flux.windows.open); главное окно — отдельно, считается в пределе числа окон
  const [windows, setWindows] = useState<WindowSpec[]>([]);
  const windowsRef = useRef<WindowSpec[]>([]);
  const windowSeq = useRef(0);
  const unsaved = useRef(new Map<string, string>());
  const [restartAsk, setRestartAsk] = useState<{ text: string; resolve: (allowed: boolean) => void } | null>(null);
  // Вопросы о подключении идут по одному, как во Flux: следующий — после ответа на прежний
  const [asks, setAsks] = useState<Array<{ id: string; ask: GrantAsk }>>([]);
  const asksRef = useRef(asks); asksRef.current = asks;
  latest.current = pick;

  const add = (kind: string, text: string, level: LogRow['level'] = 'info') =>
    setLog(rows => [...rows.slice(-199), { at: new Date().toLocaleTimeString('ru-RU'), kind, text, level }]);
  const setWindowList = (list: WindowSpec[]) => { windowsRef.current = list; setWindows(list); };

  useEffect(() => { attempt.current++; setStarted(null); setWindowList([]); setLog([]); setError(''); void call<{ context: BaseContext[] }>('testBase').then(b => setContexts(b.context)).catch(() => {}); }, [id]);

  // Вопрос о подключении присылает главный процесс событием; ответ человека уходит ему же. Закрытие запуска без ответа — «позже»
  useEffect(() => {
    if (!started) return;
    const off = window.studio.onConnectAsk?.(data => setAsks(list => [...list, data]));
    return () => {
      off?.();
      for (const item of asksRef.current) void call('runConnectAnswer', { id: item.id, choice: 'later' }).catch(() => undefined);
      setAsks([]);
    };
  }, [started]);
  const answerAsk = (item: { id: string; ask: GrantAsk }, choice: RunGrantChoice) => {
    setAsks(list => list.filter(x => x.id !== item.id));
    void call('runConnectAnswer', { id: item.id, choice }).catch(e => add('подключение', `ответ не доставлен: ${(e as Error).message}`, 'error'));
  };

  const bus = useMemo(() => createPageBus(), [started]);
  const manifest = useMemo(() => started && ({ ...started.manifest, author: '', contractVersion: (started.manifest.permissions || []).length ? 3 : started.manifest.ui === 'page' ? 2 : 1, logic: '' } as unknown as ModuleManifest), [started]);

  // Всё, что окна запуска берут у запуска: чтение тестовой базы, расчёт, сеть, подключения, вторая программа, файлы, окна
  const host: RunHost | null = started && manifest ? {
    started, log: add, bus, kept, manifest, notifiers: notifiers.current, mainFrame, hangMs: hangLimit(),
    base: {
      context: () => ({ projectId: latest.current.projectId || null, entry: latest.current.entry as LaunchContext['entry'], entityId: latest.current.entityId || null }),
      theme,
      read: async (resource, entityId) => {
        const t = Date.now();
        try { const data = await call('runRead', { resource, entityId }); add('чтение', `${resource} — ${Date.now() - t} мс`); return data as never; }
        catch (e) { add('чтение', `${resource}: ${(e as Error).message}`, 'warn'); throw e; }
      },
      compute: started.language === 'typescript' ? undefined : async input => {
        const reply = await call<{ output?: never; code?: string }>('runCompute', { input });
        if (!reply.output) { add('расчёт', `ошибка ${reply.code}`, 'error'); throw Object.assign(new Error(reply.code), { code: reply.code }); }
        add('расчёт', started.language); return reply.output;
      },
      // Обращение по полному адресу: решает главный процесс Studio по тем же правилам, что Flux (разрешение — permissions манифеста)
      net: async request => {
        const t = Date.now(), hostName = (() => { try { return new URL(request.url).hostname; } catch { return '?'; } })();
        const reply = await call<{ ok: boolean; data?: { status: number }; code?: string }>('runNet', { call: request });
        if (reply.ok) { add('сеть', `${request.method} ${hostName} — ${reply.data?.status}, ${Date.now() - t} мс`); return { ok: true, data: reply.data }; }
        add('сеть', `${request.method} ${hostName}: ${reply.code}`, 'warn');
        return { ok: false, code: (reply.code || 'FAILED') as never };
      },
      // Подключение по объявлению манифеста: объявление, пределы и память решений — у главного процесса Studio; вопрос человеку — окно ниже
      connect: async (connection: string, request: ConnectCall) => {
        const t = Date.now();
        const reply = await call<{ ok: boolean; data?: unknown; code?: string }>('runConnect', { connection, call: request }).catch(() => ({ ok: false, code: 'FAILED' } as const));
        add('подключение', `${kindOfOp(request.op)}, ${connection}, ${reply.ok ? 'выполнено' : reply.code}, ${Date.now() - t} мс`, reply.ok ? 'info' : 'warn');
        return reply.ok ? { ok: true, data: (reply as { data: unknown }).data } : { ok: false, code: (reply.code || 'FAILED') as never };
      },
      // Другая программа: та, что поставлена в тестовую базу; остальные отвечают NOT_INSTALLED, как у человека без неё
      program: async (request: ProgramCall) => {
        const t = Date.now();
        const reply = await call<ProgramReply>('runProgram', { call: request }).catch(() => ({ ok: false, code: 'FAILED' } as ProgramReply));
        add('программа', `${request.program}.${request.method}: ${reply.ok ? 'ответ получен' : (reply as { code: string }).code}, ${Date.now() - t} мс`, reply.ok ? 'info' : 'warn');
        return reply;
      },
      onComputeError: code => add('сбой', `расчёт остановлен: ${code}`, 'error'),
      onLog: (level, text) => add('flux.log', text, level),
      onFailure: kind => add('сбой', String(kind), 'error'),
    },
    // Файл пользователю: системный диалог сохранения показывает главный процесс; программа узнаёт только «сохранён» или «отказ»
    offerFile: async file => {
      if (file.bytes.length > PAGE_LIMITS.saveChars) { add('файл', `${file.name}: больше предела — не предложен`, 'warn'); return 'cancelled'; }
      try {
        const answer = await call<'saved' | 'cancelled'>('runSaveFile', { name: file.name, mime: file.mime, bytes: file.bytes });
        add('файл', `${file.name} (${file.bytes.length} Б) — ${answer === 'saved' ? 'сохранён' : 'человек отказался сохранять'}`);
        return answer;
      } catch (e) { add('файл', `${file.name}: ${(e as Error).message}`, 'error'); return 'cancelled'; }
    },
    // Файл пользователя: диалог показывает главный процесс Studio, как Flux в настоящем запуске; программа получает только выбранный файл
    pickFile: async request => pickedFromWire(await call('runPickFile', { accept: request.accept }), (text, level) => add('файл', text, level)),
    openWindow: (page: string, params: Record<string, unknown>, options?: WindowOptions) => {
      const note = options ? ` (${[options.title && `заголовок «${options.title}»`, options.width && `ширина ${options.width}`, options.height && `высота ${options.height}`].filter(Boolean).join(', ')})` : '';
      if (page !== 'index.html' && !(started.manifest.pages || []).includes(page)) { add('окно', `${page}: такой страницы нет в manifest.json`, 'warn'); return false; }
      // Главное окно считается: предел, как во Flux, — число окон программы
      if (!canOpenWindow(1 + windowsRef.current.length)) { add('окно', `${page}: предел числа окон программы`, 'warn'); return false; }
      const spec: WindowSpec = { key: `w${++windowSeq.current}`, page, params, title: options?.title || '', width: options?.width, height: options?.height };
      setWindowList([...windowsRef.current, spec]);
      add('окно', `${page} ${JSON.stringify(params)}${note} — открыто, окон ${1 + windowsRef.current.length}`);
      return true;
    },
    setUnsaved: (key, text) => { if (text === null) unsaved.current.delete(key); else unsaved.current.set(key, text); },
  } : null;

  const project = contexts.find(c => c.id === pick.projectId);
  const entities = pick.entry === 'equipment' ? project?.equipment : pick.entry === 'tag' ? project?.tags : [];
  const start = async () => {
    // Перезапуск закрывает все окна программы: несохранённое спрашивается тем же вопросом, что при закрытии окна
    if (unsaved.current.size) {
      const allowed = await new Promise<boolean>(resolve => setRestartAsk({ text: [...unsaved.current.values()].find(Boolean) || '', resolve }));
      if (!allowed) return;
    }
    const mine = ++attempt.current;
    setError(''); setLog([]); setStarted(null); setWindowList([]); unsaved.current.clear();
    try {
      const reply = await call<Started>('runStart', { id, ...pick, entityId: pick.entry === 'start' ? '' : pick.entityId });
      if (mine !== attempt.current) return;
      setStarted(reply); onStarted?.();
    } catch (e) {
      if (mine !== attempt.current) return;
      setError((e as Error).message); onFail?.((e as Error).message);
    }
  };
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => { if (signal > 0) void startRef.current(); }, [signal]);
  const shoot = async () => {
    setShots('');
    // Тема окна — класс dark на <html>, как во Flux; на время снимков переключаем его и возвращаем как было
    const root = document.documentElement, before = root.classList.contains('dark');
    const tell = () => notifiers.current.forEach(notify => notify('changed'));
    try {
      for (const name of ['light', 'dark']) {
        root.classList.toggle('dark', name === 'dark'); tell();
        // Окно программы перерисовывается после «changed»; сигнала готовности у него нет, поэтому короткая пауза
        await new Promise(r => setTimeout(r, 500));
        const box = mainFrame.current!.getBoundingClientRect();
        await call('runShot', { id, theme: name, rect: { x: box.x, y: box.y, width: box.width, height: box.height } });
      }
      setShots('Снимки обеих тем сохранены в проекте (store/light.png, store/dark.png).');
    } catch (e) { setError((e as Error).message); }
    finally { root.classList.toggle('dark', before); tell(); }
  };
  const declared = started ? (started.manifest.connections.length > 0 || (started.manifest.permissions || []).length > 0) : false;

  return (
    <div className="panel" aria-labelledby="run-title">
      <h3 id="run-title">Запуск на тестовой базе</h3>
      <div className="grid">
        <div className="field"><label htmlFor="run-project">Проект</label>
          <select id="run-project" value={pick.projectId} onChange={e => setPick({ ...pick, projectId: e.target.value, entityId: '' })}>
            {contexts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div className="field"><label htmlFor="run-entry">Откуда открыта</label>
          <select id="run-entry" value={pick.entry} onChange={e => setPick({ ...pick, entry: e.target.value, entityId: '' })}>
            {Object.entries(ENTRIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label htmlFor="run-entity">Позиция или тег</label>
          <select id="run-entity" value={pick.entityId} disabled={pick.entry === 'start'} onChange={e => setPick({ ...pick, entityId: e.target.value })}>
            <option value="">—</option>{(entities || []).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
      </div>
      <TestPrograms id={id} onChange={line => add('программа', line)} />
      {error && <p className="fx-error" role="alert">{error}</p>}
      <div className="row">
        <button className="fx-btn fx-btn-primary" onClick={start}>{started ? 'Перезапустить' : 'Запустить'}</button>
        {started && <button className="fx-btn" onClick={shoot}>Снять обе темы</button>}
      </div>
      {shots && <p className="fx-hint" role="status">{shots}</p>}
      {started && started.language === 'python' && <p className="fx-hint">Python исполняет общая среда Flux, в Studio её нет: форма откроется, расчёт — нет. Его проверит Flux при первом запуске выпуска.</p>}
      {declared && <p className="fx-hint" data-testid="studio-admin-hint">Политики администратора в Studio нет: во Flux администратор может запретить подключение или вызов другой программы, и тогда программа получит отказ.</p>}
      {started?.manifest.ui === 'page' && (
        <div className="row" role="group" aria-label="Ширина окна">
          {[[360, 'Узкое'], [640, 'Среднее'], [960, 'Широкое'], [0, 'Во всю ширину']].map(([w, label]) => (
            <button key={w} className={width === w ? 'fx-btn fx-btn-primary' : 'fx-btn'} onClick={() => setWidth(Number(w))}>{label}</button>))}
        </div>
      )}
      {host && <ProgramWindow key={started!.session} host={host} spec={null} width={width} />}
      {host && windows.length > 0 && (
        <div className="run-windows" role="group" aria-label="Окна программы">
          {windows.map(spec => <ProgramWindow key={spec.key} host={host} spec={spec} onClose={() => setWindowList(windowsRef.current.filter(w => w.key !== spec.key))} />)}
        </div>
      )}
      {restartAsk && <RunDialog program={started?.manifest.name || 'Программа'} request={closeRequest(restartAsk.text)} onAnswer={answer => { const { resolve } = restartAsk; setRestartAsk(null); resolve(answer === true); }} />}
      {asks[0] && <RunConnectPrompt key={asks[0].id} ask={asks[0].ask} onChoose={choice => answerAsk(asks[0], choice)} />}
      <h4>Журнал сообщений моста</h4>
      {log.length === 0 ? <div className="empty small">Сообщений пока нет.</div> : (
        <table className="log"><thead><tr><th>Время</th><th>Вид</th><th>Сообщение</th></tr></thead>
          <tbody>{log.map((r, i) => <tr key={i} className={r.level}><td>{r.at}</td><td>{r.kind}</td><td className="code">{r.text}</td></tr>)}</tbody></table>
      )}
    </div>
  );
}
