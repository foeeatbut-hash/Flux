/**
 * Окно программы в запуске Studio: свой кадр (<iframe sandbox>), свой мост и своя рамка с заголовком «Программа — заголовок».
 * Главное окно и окна из flux.windows.open — один и тот же компонент, как во Flux окна одной программы — один и тот же
 * ModuleFrame. Диалог программы, вопрос «Закрыть без сохранения?» и «Программа не отвечает» живут здесь, в своём окне:
 * закрытие окна убирает их без ответа, соседние окна не блокируются.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createModuleBridge, type ModuleBridgeOptions } from '../../../../modules/bridge';
import { MODULE_SANDBOX } from '../../../../modules/protocol';
import { pageHung, type WindowOptions, type PageDialog, type PageDialogAnswer } from '../../../../modules/page/model';
import type { ModuleManifest } from '../../../../modules/contract';
import RunDialog from '../RunDialog';
import { dialogAnswerLine, dialogStartLine } from '../../work/programDialog';
import { CLOSE_TITLE, DEFAULT_WINDOW, closeRequest, windowTitle, type Log, type PageBus, type Started, type WindowSpec } from './model';

/** Общее для всех окон запуска: то, что не зависит от окна (чтение, расчёт, сеть, подключения, другие программы, файлы) */
export interface RunHost {
  started: Started;
  log: Log;
  bus: PageBus;
  /** Состояние окна программы (flux.state): одно на программу, как во Flux */
  kept: { current: Record<string, unknown> };
  /** То, что мост берёт у запуска как есть */
  base: Pick<ModuleBridgeOptions, 'context' | 'theme' | 'read' | 'compute' | 'net' | 'connect' | 'program' | 'onComputeError' | 'onLog' | 'onFailure'>;
  manifest: ModuleManifest;
  offerFile: (file: { name: string; mime: string; bytes: Uint8Array }) => Promise<'saved' | 'cancelled'>;
  pickFile: NonNullable<NonNullable<ModuleBridgeOptions['page']>['pickFile']>;
  /** Открыть ещё одно окно; false — предел числа окон или такой страницы нет */
  openWindow: (page: string, params: Record<string, unknown>, options?: WindowOptions) => boolean;
  /** Окно сообщает, есть ли в нём несохранённое (текст — для вопроса); null — нет */
  setUnsaved: (key: string, text: string | null) => void;
  /** Кому сказать «changed» при смене темы */
  notifiers: Set<(kind: 'changed' | 'project-changed') => void>;
  mainFrame: { current: HTMLIFrameElement | null };
  hangMs: number;
}

interface Props { host: RunHost; spec: WindowSpec | null; onClose?: () => void; width?: number }

export default function ProgramWindow({ host, spec, onClose, width }: Props) {
  const main = !spec;
  const { started } = host;
  const isPage = started.manifest.ui === 'page';
  const key = spec?.key || 'main';
  const [session] = useState(() => (main ? started.session : crypto.randomUUID()));
  const [custom, setCustom] = useState(spec?.title || '');
  const [hung, setHung] = useState(false);
  const [restarts, setRestarts] = useState(0);
  const [asked, setAsked] = useState<{ request: PageDialog; resolve: (answer: PageDialogAnswer) => void } | null>(null);
  const [closing, setClosing] = useState<{ text: string; resolve: (allowed: boolean) => void } | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<ReturnType<typeof createModuleBridge> | null>(null);
  const beats = useRef(0), lastBeat = useRef(Date.now());
  const unsaved = useRef({ on: false, text: '' });
  const hungRef = useRef(hung); hungRef.current = hung;
  const live = useRef({ asked, closing }); live.current = { asked, closing };
  const hostRef = useRef(host); hostRef.current = host;
  // Строки журнала окна, открытого из программы, начинаются с его страницы: видно, чьё сообщение
  const log: Log = (kind, text, level) => hostRef.current.log(kind, main ? text : `${spec!.page}: ${text}`, level);

  // Страница шлёт сигнал «жива»; тишина дольше предела — зависла (кадр — отдельный процесс, Studio при этом работает)
  useEffect(() => {
    if (!isPage) return;
    beats.current = 0; lastBeat.current = Date.now(); setHung(false);
    // Отсчёт идёт только у страницы, уже подавшей сигнал, и только пока окно видно; при возврате в окно — заново
    const visible = () => { if (document.visibilityState === 'visible') lastBeat.current = Date.now(); };
    document.addEventListener('visibilitychange', visible);
    const timer = setInterval(() => {
      if (pageHung({ beats: beats.current, lastBeat: lastBeat.current, now: Date.now(), hidden: document.visibilityState !== 'visible', hangMs: hostRef.current.hangMs })) setHung(true);
    }, 500);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [isPage, restarts]);

  useEffect(() => {
    if (main) host.mainFrame.current = frame.current;
  });

  useEffect(() => {
    const h = hostRef.current;
    const manifest = h.manifest;
    const params = spec?.params || {};
    const b = createModuleBridge({
      ...h.base,
      frame: () => frame.current?.contentWindow || null, session, manifest,
      page: isPage ? {
        loadState: () => hostRef.current.kept.current, keepState: state => { hostRef.current.kept.current = state; },
        offerFile: file => hostRef.current.offerFile(file),
        pickFile: request => hostRef.current.pickFile(request),
        onBeat: () => { beats.current++; lastBeat.current = Date.now(); setHung(false); },
        openWindow: (page, p, options) => hostRef.current.openWindow(page, p, options),
        dialog: request => new Promise<PageDialogAnswer>(resolve => {
          log('диалог', dialogStartLine(request));
          setAsked({ request, resolve: answer => { log('диалог', dialogAnswerLine(request, answer)); resolve(answer); } });
        }),
        setTitle: text => { setCustom(text); log('заголовок окна', text ? `«${windowTitle(manifest.name, text)}»` : 'возвращено название программы'); },
        setUnsaved: (on, text) => {
          unsaved.current = { on, text };
          hostRef.current.setUnsaved(key, on ? text : null);
          log('несохранённое', on ? `есть${text ? `: «${text}»` : ''} — при закрытии окна спросят «${CLOSE_TITLE}»` : 'нет');
        },
        params: () => params,
        broadcast: data => { log('обмен', JSON.stringify(data).slice(0, 120)); bus?.send(data); },
      } : undefined,
    });
    const bus = isPage ? h.bus.join(data => b.deliver(data)) : null;
    bridge.current = b;
    const notify = (kind: 'changed' | 'project-changed') => b.notify(kind);
    h.notifiers.add(notify);
    const listener = (event: MessageEvent) => { void b.handle(event); };
    window.addEventListener('message', listener);
    return () => {
      window.removeEventListener('message', listener);
      h.notifiers.delete(notify);
      bus?.leave();
      b.dispose(); bridge.current = null;
      h.setUnsaved(key, null);
      // Окно ушло: открытые вопросы закрываются без ответа
      live.current.asked?.resolve(null); live.current.closing?.resolve(false);
    };
    // Мост живёт, пока живёт окно: общее у запуска берётся через hostRef на каждый вызов
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Закрытие окна: несохранённое спрашивает Studio, как Flux; зависшую программу закрывают без вопроса — отвечать ей некому
  const requestClose = () => {
    if (!unsaved.current.on || hungRef.current) { onClose?.(); return; }
    if (live.current.closing) return;
    void new Promise<boolean>(resolve => setClosing({ text: unsaved.current.text, resolve })).then(allowed => { if (allowed) onClose?.(); });
  };

  const title = windowTitle(started.manifest.name, custom);
  const style = main ? (width ? { width, maxWidth: '100%' } : undefined) : { width: spec!.width || DEFAULT_WINDOW.width, maxWidth: '100%' };
  // Остальные страницы лежат рядом с главной: адрес берётся от адреса запуска (в проверке в браузере он на loopback)
  const src = main ? started.url : new URL(spec!.page, started.url).href;
  return (
    <section className="run-window" data-testid="program-window" data-window={key} aria-label={title} style={{ position: 'relative', ...style }}>
      {(isPage || !main) && <header className="run-window-head">
        <h4 data-testid="program-window-title" title={title}>{title}</h4>
        {!main && <button type="button" className="fx-btn" aria-label={`Закрыть окно «${title}»`} onClick={requestClose}>Закрыть окно</button>}
      </header>}
      {hung && <p className="fx-error" role="alert" data-testid="module-hung">Программа {started.manifest.name} не отвечает. Остальная Studio работает.{' '}
        <button type="button" className="fx-btn" onClick={() => setRestarts(n => n + 1)}>Перезапустить</button></p>}
      <iframe key={restarts} ref={frame} title={main ? started.manifest.name : title} className="module-frame" data-testid={main ? 'studio-module-frame' : 'studio-window-frame'}
        style={main ? undefined : { height: spec!.height || DEFAULT_WINDOW.height }}
        sandbox={MODULE_SANDBOX} referrerPolicy="no-referrer" src={`${src}#${session}`}
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" />
      {closing ? <RunDialog scoped program={started.manifest.name} request={closeRequest(closing.text)} onAnswer={answer => { const { resolve } = closing; setClosing(null); resolve(answer === true); }} />
        : asked ? <RunDialog scoped program={started.manifest.name} request={asked.request} onAnswer={answer => { const { resolve } = asked; setAsked(null); resolve(answer); }} /> : null}
    </section>
  );
}
