import React, { useEffect, useRef, useState } from 'react';
import { createModuleBridge } from '../../../modules/bridge';
import { useRealTimeSync } from '../SocketProvider';
import { subscribeModuleRefresh } from '../../services/moduleRefresh';
import { recordModuleCrash } from '../../services/moduleCrashQueue';
import { MODULE_SANDBOX } from '../../../modules/protocol';
import { languageOf } from '../../../modules/engine/types';
import { cancelModuleCompute, moduleCompute } from '../../services/moduleComputeHost';
import { ensureControls, resetControls, type ControlsGate } from '../../services/moduleControlsGate';
import { createConnector, type GrantChoice } from '../../services/moduleConnections';
import { journalEvent } from '../../services/moduleJournalClient';
import { bridge as hostBridge } from '../../services/moduleReleaseService';
import type { GrantAsk } from '../../../modules/connections/model';
import { pageState, pageStateKey, joinPageBus, openModuleWindow, offerFileToUser, pickFileForProgram, pageTimings } from '../../services/modulePage';
import { pageHung } from '../../../modules/page/model';
import { useStore } from '../../store/store';
import ConnectionPrompt from './ConnectionPrompt';
import {
  themeKeys, type LaunchContext, type ModuleManifest, type ModuleReader, type ThemeTokens, type ModuleFailureKind,
} from '../../../modules/contract';

export interface ModuleFrameProps {
  manifest: ModuleManifest;
  context: LaunchContext;
  theme: string;
  channel?: 'test' | 'production';
  createReadCycle: () => ModuleReader;
  /** Страница программы-приложения (договор v2) внутри ui/; без поля — главная ui/index.html */
  page?: string;
  /** Параметры, с которыми открыто это окно (flux.windows.params) */
  windowParams?: Record<string, unknown>;
}
function themeTokens(): ThemeTokens {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(themeKeys.map(key => [key, style.getPropertyValue(key).trim()])) as ThemeTokens;
}
export default function ModuleFrame({ manifest, context, theme, createReadCycle, channel = 'production', page = 'index.html', windowParams }: ModuleFrameProps) {
  const { isConnected } = useRealTimeSync();
  const connected = useRef(isConnected);
  connected.current = isConnected;
  const frame = useRef<HTMLIFrameElement>(null);
  const [session] = useState(() => crypto.randomUUID());
  const [failure, setFailure] = useState<ModuleFailureKind | null>(null);
  const language = languageOf(manifest);
  const [gate, setGate] = useState<ControlsGate | 'checking'>(language === 'typescript' ? 'ok' : 'checking');
  const [recheck, setRecheck] = useState(0);
  const isPage = manifest.ui === 'page';
  // Страница шлёт сигнал «жива»; тишина дольше предела — зависла (кадр отдельный процесс, Flux при этом работает)
  const [hung, setHung] = useState(false);
  const [restarts, setRestarts] = useState(0);
  const lastBeat = useRef(Date.now());
  const beats = useRef(0);
  const paramsRef = useRef(windowParams || {});
  const userId = useStore(state => state.user?.id || '');
  useEffect(() => {
    if (!isPage) return;
    beats.current = 0; lastBeat.current = Date.now(); setHung(false);
    // Отсчёт идёт только у страницы, уже подавшей сигнал, и только пока окно видно; при возврате в окно — заново
    const visible = () => { if (document.visibilityState === 'visible') lastBeat.current = Date.now(); };
    document.addEventListener('visibilitychange', visible);
    const timer = setInterval(() => {
      if (pageHung({ beats: beats.current, lastBeat: lastBeat.current, now: Date.now(), hidden: document.visibilityState !== 'visible', hangMs: pageTimings.hangMs })) setHung(true);
    }, 1000);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [isPage, restarts, page]);
  // Вопрос о подключении и отказ: вопрос показывает человеку окно Flux, ответ записывает главный процесс
  const [asking, setAsking] = useState<{ ask: GrantAsk; resolve: (choice: GrantChoice) => void } | null>(null);
  const [denied, setDenied] = useState<{ connection: string; app: string } | null>(null);
  useEffect(() => {
    if (language === 'typescript') return;
    let current = true;
    setGate('checking');
    void ensureControls(manifest).then(result => { if (current) setGate(result); });
    return () => { current = false; };
  }, [manifest, language, recheck]);
  const latest = useRef({ context, createReadCycle });
  latest.current = { context, createReadCycle };
  const bridgeRef = useRef<ReturnType<typeof createModuleBridge> | null>(null);
  const refreshRef = useRef<ReturnType<typeof subscribeModuleRefresh> | null>(null);
  useEffect(() => {
    let reader = latest.current.createReadCycle();
    const opened = Date.now();
    const base = { moduleId: manifest.id, version: manifest.version };
    journalEvent({ ...base, category: 'lifecycle', event: 'open', detail: language });
    let chain: Promise<void> = Promise.resolve();
    const connector = createConnector({
      moduleId: manifest.id, version: manifest.version, session,
      apps: Object.fromEntries((manifest.connections || []).map(c => [c.id, c.app])),
      // Вопросы по разным подключениям показываются по одному, друг друга не перекрывают
      ask: ask => { const run = chain.then(() => new Promise<GrantChoice>(resolve => setAsking({ ask, resolve }))); chain = run.then(() => undefined, () => undefined); return run; },
      onDenied: info => setDenied(info),
    });
    const stateKey = pageStateKey(userId, manifest.id, channel);
    const bus = isPage ? joinPageBus(manifest.id, data => bridgeRef.current?.deliver(data)) : null;
    const bridge = createModuleBridge({
      page: isPage ? {
        loadState: () => pageState.load(stateKey), keepState: state => pageState.keep(stateKey, state),
        offerFile: file => offerFileToUser(manifest.name, file),
        pickFile: request => pickFileForProgram(manifest.name, request.accept),
        onBeat: () => { beats.current++; lastBeat.current = Date.now(); setHung(false); },
        openWindow: (target, params) => openModuleWindow(manifest.id, target, params),
        params: () => paramsRef.current,
        broadcast: data => bus?.send(data),
      } : undefined,
      frame: () => frame.current?.contentWindow || null, session, manifest,
      context: () => latest.current.context, theme: themeTokens,
      beginReadCycle: () => { reader = latest.current.createReadCycle(); },
      read: async (resource, entityId) => {
        const started = Date.now();
        try {
          const data = await reader(resource, entityId);
          // В журнал уходят вид данных и объём, но не содержимое
          journalEvent({ ...base, category: 'read', event: 'read', detail: String(resource), outcome: 'ok', ms: Date.now() - started, bytesIn: JSON.stringify(data ?? null).length });
          return data;
        } catch (error) {
          journalEvent({ ...base, category: 'read', level: 'warn', event: 'read', detail: String(resource), outcome: 'failed', ms: Date.now() - started });
          throw error;
        }
      },
      connect: (connection, call) => connector.connect(connection, call),
      onLog: (level, text) => journalEvent({ ...base, category: 'log', level, event: 'message', detail: text }),
      onFailure: kind => { journalEvent({ ...base, category: 'failure', level: 'error', event: kind, outcome: kind }); recordModuleCrash(manifest.id, manifest.version, kind); setFailure(kind); },
      compute: language === 'typescript' ? undefined : async input => {
        const started = Date.now();
        try {
          const output = await moduleCompute().compute({ moduleId: manifest.id, version: manifest.version, language }, input,
            document.visibilityState === 'visible' ? 'active' : 'background');
          journalEvent({ ...base, category: 'compute', event: 'compute', detail: language, outcome: 'ok', ms: Date.now() - started });
          return output;
        } catch (error) {
          const code = String((error as { code?: string })?.code || 'CRASH');
          journalEvent({ ...base, category: 'compute', level: 'error', event: 'compute', detail: language, outcome: code.toLowerCase(), ms: Date.now() - started });
          throw error;
        }
      },
      // Счётчик сбоев пишет сам расчёт; здесь только плашка «программа остановилась»
      onComputeError: code => setFailure(code === 'TIMEOUT' ? 'timeout' : code === 'MEMORY' ? 'memory' : code === 'CRASH' || code === 'ABI' || code === 'BAD_OUTPUT' || code === 'NUMBER' ? 'crash' : null),
    });
    bridgeRef.current = bridge;
    const listener = (event: MessageEvent) => { void bridge.handle(event); };
    window.addEventListener('message', listener);
    const unsubscribe = subscribeModuleRefresh(() => bridge.notify('changed'), () => connected.current);
    refreshRef.current = unsubscribe;
    return () => {
      journalEvent({ ...base, category: 'lifecycle', event: 'close', detail: language, ms: Date.now() - opened });
      connector.close();
      bus?.leave();
      setAsking(current => { current?.resolve('later'); return null; });
      bridge.dispose(); bridgeRef.current = null;
      cancelModuleCompute(manifest.id);
      unsubscribe();
      refreshRef.current = null;
      window.removeEventListener('message', listener);
    };
  }, [session, manifest, language, userId, channel]);
  useEffect(() => { refreshRef.current?.connectionChanged(); }, [isConnected]);
  useEffect(() => { bridgeRef.current?.notify('project-changed'); }, [context.projectId, context.entry, context.entityId]);
  useEffect(() => { bridgeRef.current?.notify('changed'); }, [theme]);
  return <div className="flex h-full min-h-0 flex-1 flex-col">
    {failure && <div role="alert" className="flex items-center gap-3 border-b border-[var(--flux-line)] bg-[var(--flux-surface)] p-3 text-sm text-[var(--flux-text)]">
      <span>Программа {manifest.name} остановилась — отправить отчёт разработчику?</span>
      <button type="button" className="text-[var(--flux-accent)] underline" onClick={() => {
        window.dispatchEvent(new CustomEvent('flux:report-module', { detail: { source: 'running', moduleId: manifest.id, name: manifest.name, version: manifest.version, channel, moduleDiagnostics: { code: failure } } }));
        setFailure(null);
      }}>Отправить отчёт</button>
      <button type="button" onClick={() => setFailure(null)}>Закрыть</button>
    </div>}
    {denied && <div role="alert" className="flex items-center gap-3 border-b border-[var(--flux-line)] bg-[var(--flux-surface)] p-3 text-sm text-[var(--flux-text)]" data-testid="module-denied">
      <span>Нет доступа к «{denied.app}»: подключение не разрешено. Программа работает без него.</span>
      <button type="button" className="text-[var(--flux-accent)] underline" onClick={() => {
        // Сброс решения делает главный процесс; следующий обмен данными снова спросит человека
        void hostBridge()?.invoke('modules:grants-reset', { moduleId: manifest.id }).then(() => { setDenied(null); bridgeRef.current?.notify('changed'); });
      }}>Разрешить…</button>
      <button type="button" onClick={() => setDenied(null)}>Закрыть</button>
    </div>}
    {hung && <div role="alert" className="flex items-center gap-3 border-b border-[var(--flux-line)] bg-[var(--flux-surface)] p-3 text-sm text-[var(--flux-text)]" data-testid="module-hung">
      <span>Программа {manifest.name} не отвечает. Остальной Flux работает.</span>
      <button type="button" className="text-[var(--flux-accent)] underline" onClick={() => { setRestarts(n => n + 1); }}>Перезапустить</button>
    </div>}
    {asking && <ConnectionPrompt ask={asking.ask} onChoose={choice => { asking.resolve(choice); setAsking(null); }} />}
    {gate === 'checking' && <div className="fx-empty"><div className="fx-empty-title">Проверка расчёта на этом компьютере…</div></div>}
    {(gate === 'failed' || gate === 'retry') && <div className="fx-empty" role="alert"><div className="fx-empty-title">Программа не запущена</div>
      <div className="fx-empty-text">{gate === 'failed' ? 'Контрольные примеры на этом компьютере не сошлись. Сообщение о сбое отправлено разработчику.'
        : 'Контрольные примеры не удалось выполнить (не хватило времени или памяти). Это могло быть разовым.'}</div>
      <button type="button" className="fx-btn" onClick={() => { void resetControls(manifest).then(() => setRecheck(n => n + 1)); }}>Проверить снова</button></div>}
    {gate === 'ok' && <iframe key={restarts} ref={frame} name={session} title={manifest.name} data-testid="flux-module-frame" sandbox={MODULE_SANDBOX}
    referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
    src={`flux-module://${manifest.id}/${isPage ? `ui/${page}` : 'index.html'}#${session}`}
    className="h-full w-full min-h-0 flex-1 border-0" />}
  </div>;
}
