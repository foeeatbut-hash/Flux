import type {
  BridgeError, ComputeHostMessage, ConnectHostMessage, HostMessage, ProgramHostMessage, LaunchContext, ModuleManifest, ModuleOutput, ReadData,
  ReadRequest, Resource, ThemeTokens, ModuleFailureKind, PageHostMessage, PageOp,
} from './contract';
import { validMessage } from './schemas';
import { ComputeError, codeOf, type ComputeErrorCode } from './engine/types';
import { encodeJson } from './engine/json';
import type { ConnectCall, ConnectErrorCode, NetCall } from './connections/model';
import { hasNetPermission, hasProgramPermission } from './permissions/registry';
import { PROGRAM_LIMITS, type ProgramCall, type ProgramCallErrorCode, type ProgramReply } from './programs/model';
import { DIALOG_LIMITS, hasControlChars, openAcceptProblem, PAGE_LIMITS, saveNameProblem, WINDOW_LIMITS, WINDOW_OPTION_LIMITS, type PageDialog, type PageDialogAnswer, type WindowOptions } from './page/model';

export interface ModuleBridgeOptions {
  frame: () => Window | null;
  session: string;
  manifest: ModuleManifest;
  context: () => LaunchContext;
  theme: () => ThemeTokens;
  read: <R extends Resource>(resource: R, entityId?: string) => Promise<ReadData[R]>;
  beginReadCycle?: () => void;
  onFailure?: (kind: ModuleFailureKind) => void;
  /**
   * Расчёт логики на Python или WebAssembly (src/services/moduleCompute.ts). Язык и файл выбирает
   * не программа, а подписанный манифест: программа присылает только вход.
   */
  compute?: (input: Record<string, unknown>) => Promise<ModuleOutput>;
  /** Расчёт закончился ошибкой: окно показывает «программа остановилась»; счётчик сбоев пишет сам расчёт */
  onComputeError?: (code: ComputeErrorCode) => void;
  /**
   * Сквозной вызов подключения (src/services/moduleConnections.ts → главный процесс). Окно не решает, можно ли:
   * разрешение, адрес и пределы проверяет главный процесс по подписанному манифесту выпуска.
   */
  connect?: (connection: string, call: ConnectCall) => Promise<{ ok: true; data: unknown } | { ok: false; code: ConnectErrorCode }>;
  /** Обращение по полному адресу (flux.net.fetch(url)); окончательно решает главный процесс */
  net?: (call: NetCall) => Promise<{ ok: true; data: unknown } | { ok: false; code: ConnectErrorCode }>;
  /**
   * Обращение к другой программе (flux.programs.call). Окно сверяет разрешение и размеры, главный процесс — всё остальное
   * и ведёт журнал; сам расчёт идёт в окне движком вызываемой программы. Нет поля — хост этого не умеет.
   */
  program?: (call: ProgramCall) => Promise<ProgramReply>;
  /** Программа закрыта: подключения, которые она открыла, закрываются (главный процесс сам держит их список) */
  onClose?: () => void;
  /** Строка из flux.log программы; окно пишет её в журнал */
  onLog?: (level: 'info' | 'warn' | 'error', text: string) => void;
  /**
   * Страница программы (договор v2). Действия страницы выполняет окно Flux: состояние держит оно,
   * файл пользователю отдаёт через свой диалог (страница на диск не пишет). Без этого поля, как и
   * без `ui: 'page'` в манифесте, любое действие страницы — отказ DENIED.
   */
  page?: {
    loadState: () => Record<string, unknown>;
    keepState: (state: Record<string, unknown>) => void;
    offerFile: (file: { name: string; mime: string; bytes: Uint8Array }) => Promise<'saved' | 'cancelled'>;
    /**
     * Файл пользователя (flux.openFile, добавлено к v2): окно Flux показывает системный диалог, человек выбирает файл,
     * программа получает имя и содержимое только его. Нет поля — хост этого не умеет, программе отвечают DENIED.
     */
    pickFile?: (request: { accept: string[] }) => Promise<{ name: string; mime: string; bytes: Uint8Array } | 'cancelled' | 'limit'>;
    onBeat: () => void;
    /** Свои окна программы: Flux открывает обычное окно с этой страницей пакета; false — предел или страницы нет */
    openWindow: (page: string, params: Record<string, unknown>, options?: WindowOptions) => boolean;
    /**
     * Диалог Flux (flux.dialogs, добавлено к v2): окно Flux рисует свой диалог с названием программы; ответ — по виду
     * (confirm — true/false, alert — null, prompt — строка или null). Окно программы закрылось — диалог закрыт без ответа.
     * Нет поля — хост этого не умеет, программе отвечают DENIED.
     */
    dialog?: (request: PageDialog) => Promise<PageDialogAnswer>;
    /** Заголовок своего окна (flux.window.setTitle); пустая строка — вернуть название программы */
    setTitle?: (text: string) => void;
    /** Пометка «в окне есть несохранённое» (flux.window.setUnsaved): при закрытии Flux спросит сам, программа закрытие не блокирует */
    setUnsaved?: (unsaved: boolean, text: string) => void;
    /** Параметры, с которыми открыто это окно */
    params: () => Record<string, unknown>;
    /** Сообщение остальным окнам этой же программы (чужим не доходит) */
    broadcast: (data: unknown) => void;
  };
}

function messageBytes(message: unknown): number {
  // Лимит задан в байтах: строка с кириллицей не должна занимать вдвое
  // больше разрешённого только потому, что JS считает UTF-16 символы.
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}
function writeLike(message: Record<string, unknown>): boolean {
  const verb = /(?:^|[.:_-])(?:set[a-z0-9]*|write|create|update|patch|delete|remove|save|insert|put|upsert|rename|mutate)(?:$|[.:_-])/i;
  return [message.type, message.op].some(value => typeof value === 'string' && verb.test(value.replace(/([a-z0-9])([A-Z])/g, '$1-$2')))
    || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(message.method || '').toUpperCase());
}

export function createModuleBridge(options: ModuleBridgeOptions) {
  let disposed = false;
  let generation = 0;
  let ready = false;
  const pending = new Set<string>();
  let budget = 100;
  let budgetAt = Date.now();
  const computing = new Set<string>();
  const connecting = new Set<string>();
  const calling = new Set<string>();
  let logAt = 0;
  let logs = 0;
  function post(message: HostMessage | ComputeHostMessage | ConnectHostMessage | PageHostMessage | ProgramHostMessage) {
    if (!disposed && validMessage(message.type, message)) {
      // Получатель — только сохранённое окно iframe. Его opaque origin
      // нельзя указать строкой targetOrigin, поэтому здесь нужен '*'.
      options.frame()?.postMessage(message, '*');
    }
  }
  const error = (id: string, code: BridgeError) => {
    if (code !== 'NO_PROJECT') options.onFailure?.('bridge');
    post({ flux: 'module', v: 1, session: options.session, type: 'error', id, code });
  };
  async function runCompute(message: { id: string; input: Record<string, unknown> }) {
    const fail = (code: ComputeErrorCode) => post({ flux: 'module', v: 1, session: options.session, type: 'compute-error', id: message.id, code });
    if (!options.compute) { fail('UNAVAILABLE'); return; }
    if (computing.size >= 4 || computing.has(message.id)) { fail('BUSY'); return; }
    const epoch = generation;
    computing.add(message.id);
    try {
      // Числа проверяются здесь, а не в программе: NaN и целое больше 2^53 в обход frame.ts не пройдут
      encodeJson(message.input);
      const output = await options.compute(message.input);
      if (disposed || epoch !== generation) return;
      const result: ComputeHostMessage = { flux: 'module', v: 1, session: options.session, type: 'compute-result', id: message.id, output };
      if (messageBytes(result) > 1024 * 1024 || !validMessage('compute-result', result)) { fail('BAD_OUTPUT'); options.onComputeError?.('BAD_OUTPUT'); }
      else post(result);
    } catch (error) {
      if (disposed || epoch !== generation) return;
      const code = codeOf(error instanceof ComputeError ? error : new ComputeError('CRASH'));
      fail(code);
      options.onComputeError?.(code);
    } finally { computing.delete(message.id); }
  }
  /** Обращение по полному адресу: то же, что runConnect, но без названного подключения — в манифесте должен быть `internet` или `lan` */
  async function runNet(message: { id: string; call: NetCall }) {
    const fail = (code: ConnectErrorCode) => {
      if (code === 'LIMIT' || code === 'TIMEOUT' || code === 'DENIED') options.onFailure?.('connection');
      post({ flux: 'module', v: 1, session: options.session, type: 'connect-error', id: message.id, code });
    };
    if (!options.net) { fail('UNAVAILABLE'); return; }
    if (!hasNetPermission(options.manifest, 'internet') && !hasNetPermission(options.manifest, 'lan')) { fail('DENIED'); return; }
    if (connecting.size >= 8 || connecting.has(message.id)) { fail('LIMIT'); return; }
    connecting.add(message.id);
    try {
      const reply = await options.net(message.call);
      if (disposed) return;
      if ('code' in reply) { fail(reply.code); return; }
      const result: ConnectHostMessage = { flux: 'module', v: 1, session: options.session, type: 'connect-result', id: message.id, data: (reply as { data: unknown }).data };
      if (messageBytes(result) > 1024 * 1024 || !validMessage('connect-result', result)) fail('LIMIT');
      else post(result);
    } catch (_) { if (!disposed) fail('FAILED'); }
    finally { connecting.delete(message.id); }
  }
  /** Обращение к другой программе: разрешение и размеры проверяются здесь, остальное — в главном процессе, и окно тоже вправе ошибиться */
  async function runProgram(message: { id: string; call: ProgramCall }) {
    const fail = (code: ProgramCallErrorCode) => post({ flux: 'module', v: 1, session: options.session, type: 'program-error', id: message.id, code });
    if (!options.program) { fail('FAILED'); return; }
    if (!hasProgramPermission(options.manifest, message.call.program) || message.call.program === options.manifest.id) { fail('NOT_ALLOWED'); return; }
    if (calling.size >= PROGRAM_LIMITS.inFlight || calling.has(message.id) || messageBytes(message.call.data ?? null) > PROGRAM_LIMITS.bytes) { fail('LIMIT'); return; }
    calling.add(message.id);
    try {
      const reply = await options.program(message.call);
      if (disposed) return;
      if ('code' in reply) { fail(reply.code); return; }
      const result: ProgramHostMessage = { flux: 'module', v: 1, session: options.session, type: 'program-result', id: message.id, data: (reply as { data: unknown }).data };
      if (messageBytes((reply as { data: unknown }).data ?? null) > PROGRAM_LIMITS.bytes || !validMessage('program-result', result)) fail('LIMIT');
      else post(result);
    } catch (_) { if (!disposed) fail('FAILED'); }
    finally { calling.delete(message.id); }
  }
  async function runConnect(message: { id: string; connection: string; call: ConnectCall }) {
    const fail = (code: ConnectErrorCode) => {
      // Превышение пределов и обращение к необъявленному — признак неисправной программы: идёт в счётчики сбоев
      if (code === 'LIMIT' || code === 'TIMEOUT' || code === 'DENIED') options.onFailure?.('connection');
      post({ flux: 'module', v: 1, session: options.session, type: 'connect-error', id: message.id, code });
    };
    if (!options.connect) { fail('UNAVAILABLE'); return; }
    // Объявление есть в манифесте, который окно получило от главного процесса; окончательно решает главный процесс
    if (!(options.manifest.connections || []).some(c => c.id === message.connection)) { fail('DENIED'); return; }
    if (connecting.size >= 8 || connecting.has(message.id)) { fail('LIMIT'); return; }
    connecting.add(message.id);
    try {
      const reply = await options.connect(message.connection, message.call);
      if (disposed) return;
      if ('code' in reply) { fail(reply.code); return; }
      const result: ConnectHostMessage = { flux: 'module', v: 1, session: options.session, type: 'connect-result', id: message.id, data: (reply as { data: unknown }).data };
      if (messageBytes(result) > 1024 * 1024 || !validMessage('connect-result', result)) fail('LIMIT');
      else post(result);
    } catch (_) { if (!disposed) fail('FAILED'); }
    finally { connecting.delete(message.id); }
  }
  let offering = false;
  let dialogOpen = false;
  let dialogAt = 0;
  let picking = false;
  let pickedAt = 0;
  let offeredAt = 0;
  async function runPage(message: { id: string } & PageOp) {
    const answer = (result: { data: unknown } | { code: 'DENIED' | 'LIMIT' | 'FAILED' | 'CANCELLED' }) => {
      if (disposed) return;
      if ('code' in result) post({ flux: 'module', v: 1, session: options.session, type: 'page-error', id: message.id, code: result.code } as PageHostMessage);
      else post({ flux: 'module', v: 1, session: options.session, type: 'page-result', id: message.id, data: result.data } as PageHostMessage);
    };
    const page = options.page;
    if (options.manifest.ui !== 'page' || !page) { answer({ code: 'DENIED' }); return; }
    if (message.op === 'beat') { page.onBeat(); return; }
    if (message.op === 'params-load') { answer({ data: page.params() }); return; }
    if (message.op === 'channel-send') {
      if (messageBytes(message.data) > WINDOW_LIMITS.messageBytes) { answer({ code: 'LIMIT' }); return; }
      page.broadcast(message.data); answer({ data: null }); return;
    }
    if (message.op === 'window-title' || message.op === 'window-unsaved') {
      if (!page.setTitle && message.op === 'window-title' || !page.setUnsaved && message.op === 'window-unsaved') { answer({ code: 'DENIED' }); return; }
      const text = message.op === 'window-title' ? message.text : message.text ?? '';
      if (hasControlChars(text)) { answer({ code: 'DENIED' }); return; }
      if (message.op === 'window-title') page.setTitle!(text.trim().slice(0, WINDOW_OPTION_LIMITS.title));
      else page.setUnsaved!(message.unsaved, message.unsaved ? text.trim().slice(0, WINDOW_OPTION_LIMITS.unsavedText) : '');
      answer({ data: null }); return;
    }
    if (message.op === 'dialog-confirm' || message.op === 'dialog-alert' || message.op === 'dialog-prompt') {
      if (!page.dialog) { answer({ code: 'DENIED' }); return; }
      // Только простой текст: управляющих знаков нет, пустых надписей нет (схема), длина по DIALOG_LIMITS
      const texts = [message.title, message.text, message.op === 'dialog-confirm' ? message.ok : undefined, message.op === 'dialog-confirm' ? message.cancel : undefined,
        message.op === 'dialog-prompt' ? message.label : undefined, message.op === 'dialog-prompt' ? message.value : undefined];
      if (texts.some(item => item !== undefined && hasControlChars(item, true))) { answer({ code: 'DENIED' }); return; }
      let request: PageDialog;
      if (message.op === 'dialog-confirm') request = { kind: 'confirm', title: message.title, text: message.text, ...(message.ok ? { ok: message.ok } : {}), ...(message.cancel ? { cancel: message.cancel } : {}), ...(message.danger ? { danger: true } : {}) };
      else if (message.op === 'dialog-alert') request = { kind: 'alert', title: message.title, text: message.text };
      else {
        const maxLength = message.maxLength ?? DIALOG_LIMITS.defaultMaxLength;
        if ((message.value ?? '').length > maxLength) { answer({ code: 'DENIED' }); return; }
        request = { kind: 'prompt', title: message.title, ...(message.text ? { text: message.text } : {}), label: message.label, ...(message.value !== undefined ? { value: message.value } : {}), maxLength };
      }
      // Один диалог на окно за раз и не чаще раза в секунду: программа не заваливает человека окнами
      if (dialogOpen || Date.now() - dialogAt < 1000) { answer({ code: 'LIMIT' }); return; }
      dialogOpen = true; dialogAt = Date.now();
      try {
        const reply = await page.dialog(request);
        if (request.kind === 'confirm') answer({ data: reply === true });
        else if (request.kind === 'alert') answer({ data: null });
        else answer({ data: typeof reply === 'string' ? reply.slice(0, request.maxLength) : null });
      } catch { answer({ code: 'FAILED' }); }
      finally { dialogOpen = false; }
      return;
    }
    if (message.op === 'window-open') {
      // Страница обязана быть главной либо объявленной в подписанном манифесте; параметры невелики
      const allowed = message.page === 'index.html' || (options.manifest.pages || []).includes(message.page);
      if (!allowed) { answer({ code: 'DENIED' }); return; }
      if (messageBytes(message.params ?? {}) > WINDOW_LIMITS.paramsBytes) { answer({ code: 'LIMIT' }); return; }
      const windowOptions = message.options;
      if (windowOptions?.title !== undefined && hasControlChars(windowOptions.title)) { answer({ code: 'DENIED' }); return; }
      answer(page.openWindow(message.page, message.params ?? {}, windowOptions ? { ...(windowOptions.title?.trim() ? { title: windowOptions.title.trim() } : {}), ...(windowOptions.width ? { width: windowOptions.width } : {}), ...(windowOptions.height ? { height: windowOptions.height } : {}) } : undefined)
        ? { data: null } : { code: 'LIMIT' }); return;
    }
    if (message.op === 'state-load') { answer({ data: page.loadState() }); return; }
    if (message.op === 'state-keep') {
      if (messageBytes(message.state) > PAGE_LIMITS.stateBytes) { answer({ code: 'LIMIT' }); return; }
      page.keepState(message.state); answer({ data: null }); return;
    }
    if (message.op === 'file-pick') {
      if (!page.pickFile) { answer({ code: 'DENIED' }); return; }
      if (openAcceptProblem(message.accept)) { answer({ code: 'DENIED' }); return; }
      // Один диалог за раз и не чаще раза в секунду, как у «отдать файл»; программа не заваливает человека окнами
      if (picking || Date.now() - pickedAt < 1000) { answer({ code: 'LIMIT' }); return; }
      picking = true; pickedAt = Date.now();
      try {
        const picked = await page.pickFile({ accept: message.accept ?? [] });
        if (picked === 'cancelled') answer({ code: 'CANCELLED' });
        else if (picked === 'limit' || picked.bytes.length > PAGE_LIMITS.openBytes) answer({ code: 'LIMIT' });
        else {
          let raw = '';
          for (let i = 0; i < picked.bytes.length; i += 0x8000) raw += String.fromCharCode(...picked.bytes.subarray(i, i + 0x8000));
          // Имя без путей: даже если хост ошибётся, программа не узнает папок человека
          answer({ data: { name: picked.name.replace(/^.*[\\/]/, '').slice(0, 100), size: picked.bytes.length, mime: picked.mime || 'application/octet-stream', data: btoa(raw), encoding: 'base64' } });
        }
      } catch { answer({ code: 'FAILED' }); }
      finally { picking = false; }
      return;
    }
    // Файл пользователю: одно окно диалога за раз и не чаще раза в секунду, имя без путей
    if (saveNameProblem(message.name)) { answer({ code: 'DENIED' }); return; }
    if (offering || Date.now() - offeredAt < 1000) { answer({ code: 'LIMIT' }); return; }
    let bytes: Uint8Array;
    try {
      bytes = message.encoding === 'base64'
        ? Uint8Array.from(atob(message.data), c => c.charCodeAt(0)) : new TextEncoder().encode(message.data);
    } catch { answer({ code: 'FAILED' }); return; }
    offering = true; offeredAt = Date.now();
    try {
      const result = await page.offerFile({ name: message.name, mime: message.mime || 'application/octet-stream', bytes });
      answer(result === 'saved' ? { data: 'saved' } : { code: 'CANCELLED' });
    } catch { answer({ code: 'FAILED' }); }
    finally { offering = false; }
  }
  function notify(event: 'opened' | 'project-changed' | 'changed') {
    generation++;
    options.beginReadCycle?.();
    if (ready) post({
      flux: 'module', v: 1, session: options.session, type: 'event', event,
      context: options.context(), theme: options.theme(),
    });
  }
  async function handle(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>) {
    // Одного origin='null' мало: другой sandbox имеет тот же opaque origin.
    if (disposed || !options.frame() || event.source !== options.frame() || event.origin !== 'null') return;
    const message = event.data;
    if (!message || message.session !== options.session) return;
    if (Date.now() - budgetAt >= 1000) {
      budgetAt = Date.now();
      budget = 100;
    }
    if (--budget < 0) return;
    try {
      if (messageBytes(message) > 1024 * 1024) return;
    } catch (_) { return; }
    if (validMessage('ready', message)) {
      ready = true;
      notify('opened');
      return;
    }
    if (!ready) return;
    if (validMessage('failure', message)) {
      options.onFailure?.(message.kind as ModuleFailureKind);
      return;
    }
    // Ошибочная форма записи всё равно не становится неизвестной командой:
    // модуль получает явный запрет, а ни один обработчик чтения не вызывается.
    if (message.flux === 'module' && message.v === 1 && writeLike(message)) {
      const id = typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 160
        ? message.id : 'untracked';
      error(id, 'READ_ONLY');
      return;
    }
    if (validMessage('compute', message)) { void runCompute(message); return; }
    if (message.type === 'connect' && typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 160) {
      if (validMessage('connect', message)) void runConnect(message);
      else {
        // Чужая форма вызова (адрес внутри вызова, неизвестная операция) — явный отказ, а не молчание до таймаута
        options.onFailure?.('connection');
        post({ flux: 'module', v: 1, session: options.session, type: 'connect-error', id: message.id, code: 'DENIED' });
      }
      return;
    }
    if (message.type === 'net' && typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 160) {
      if (validMessage('net', message)) {
        void runNet(message as { id: string; call: NetCall });
      } else {
        options.onFailure?.('connection');
        post({ flux: 'module', v: 1, session: options.session, type: 'connect-error', id: message.id, code: 'DENIED' });
      }
      return;
    }
    if (message.type === 'program' && typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 160) {
      if (validMessage('program', message)) void runProgram(message as { id: string; call: ProgramCall });
      else post({ flux: 'module', v: 1, session: options.session, type: 'program-error', id: message.id, code: 'NOT_ALLOWED' });
      return;
    }
    if (message.type === 'page') {
      // Неверная форма действия страницы — понятный отказ, а не молчание до таймаута страницы
      if (typeof message.id === 'string' && message.id && message.id.length <= 160) {
        if (validMessage('page', message)) void runPage(message);
        else post({ flux: 'module', v: 1, session: options.session, type: 'page-error', id: message.id, code: 'DENIED' } as PageHostMessage);
      }
      return;
    }
    if (validMessage('log', message)) {
      // Частота и длина ограничены здесь, до журнала: программа не раздует его (5 в секунду)
      if (Date.now() - logAt >= 1000) { logAt = Date.now(); logs = 0; }
      if (++logs <= 5) options.onLog?.(message.level, String(message.text).slice(0, 200));
      return;
    }
    if (!validMessage('read', message)) return;
    const request = message as ReadRequest;
    if (!options.manifest.reads.includes(request.resource)) { error(request.id, 'DENIED'); return; }
    if (!options.context().projectId) { error(request.id, 'NO_PROJECT'); return; }
    if (pending.size >= 16 || pending.has(request.id)) { error(request.id, 'LIMIT'); return; }
    const epoch = generation;
    pending.add(request.id);
    try {
      const data = await options.read(request.resource, request.entityId);
      if (disposed || epoch !== generation) return;
      const result: HostMessage = {
        flux: 'module', v: 1, session: options.session, type: 'result',
        id: request.id, resource: request.resource, data,
      };
      if (messageBytes(result) > 1024 * 1024 || !validMessage('result', result)) error(request.id, 'LIMIT');
      else post(result);
    } catch (_) {
      if (!disposed && epoch === generation) error(request.id, 'FAILED');
    } finally { pending.delete(request.id); }
  }
  return {
    handle, notify,
    /** Сообщение от другого окна этой же программы */
    deliver: (data: unknown) => post({ flux: 'module', v: 1, session: options.session, type: 'page-message', data } as PageHostMessage),
    dispose: () => { disposed = true; offering = false; generation++; pending.clear(); computing.clear(); connecting.clear(); calling.clear(); options.onClose?.(); },
  };
}
