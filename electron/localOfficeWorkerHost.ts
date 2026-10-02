import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalOfficeApp, LocalOfficeHost } from './localOfficeSessions';
import { WindowsFilesError } from './filesystem/paths';

/**
 * PDF/XLSX используют синхронные парсеры и WASM. Они должны блокировать свой
 * поток, а не главное окно, IPC и загрузку уведомлений всей программы.
 * Код потока фиксирован; пути передаются данными, а не вставляются в JavaScript.
 */
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
let host;
let nextCommit = 0;
const commits = new Map();
const errorData = error => ({ message: String(error?.message || 'Сбой редактора'),
  code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'EDITOR_ERROR' });
function commit(parentId) {
  const commitId = ++nextCommit;
  return new Promise((resolve, reject) => {
    commits.set(commitId, { resolve, reject });
    parentPort.postMessage({ type: 'commit', parentId, commitId });
  });
}
parentPort.on('message', async message => {
  if (message?.type === 'commit-result') {
    const pending = commits.get(message.commitId);
    if (!pending) return;
    commits.delete(message.commitId);
    if (message.ok) pending.resolve();
    else pending.reject(Object.assign(new Error(message.error?.message || 'Сохранение не удалось'), { code: message.error?.code }));
    return;
  }
  if (message?.type !== 'call' || !Number.isSafeInteger(message.id)) return;
  try {
    if (!host) throw new Error('Редактор ещё не готов');
    const args = message.args || [];
    let value;
    switch (message.method) {
      case 'open': value = await host.open(...args); break;
      case 'setDataDir': value = await host.setDataDir(...args); break;
      case 'invoke': value = await host.invoke(...args, message.commit ? () => commit(message.id) : undefined); break;
      case 'send': value = await host.send(...args); break;
      case 'close': value = await host.close(...args); break;
      case 'requestCopy':
        if (!host.requestCopy) throw new Error('Сохранение копии недоступно');
        value = await host.requestCopy(...args); break;
      default: throw new Error('Команда редактора недоступна');
    }
    parentPort.postMessage({ type: 'result', id: message.id, ok: true, value });
  } catch (error) {
    parentPort.postMessage({ type: 'result', id: message.id, ok: false, error: errorData(error) });
  }
});
try {
  host = require(path.join(workerData.resources, workerData.app + '.cjs'));
  if (typeof host.setDataDir !== 'function') throw Object.assign(new Error('Обновите локальный редактор'), { code: 'EDITOR_UPDATE_REQUIRED' });
  host.start(workerData.resources);
  host.onSend((id, channel, args) => parentPort.postMessage({ type: 'event', id, channel, args }));
  parentPort.postMessage({ type: 'ready' });
} catch (error) {
  parentPort.postMessage({ type: 'failed', error: errorData(error) });
}
`;

interface Waiting {
  resolve(value: any): void; reject(error: unknown): void;
  commit?: () => Promise<void>;
}
export function createLocalOfficeWorkerHost(app: LocalOfficeApp, resourcesDir?: string): LocalOfficeHost {
  const candidates = [resourcesDir, process.env.FLUX_GENOFFICE_SERVER,
    (process as any).resourcesPath && join((process as any).resourcesPath, 'genoffice-server'),
    join(process.cwd(), 'genoffice-server')].filter(Boolean) as string[];
  const resources = candidates.find(dir => existsSync(join(dir, `${app}.cjs`)));
  if (!resources) throw new WindowsFilesError('EDITOR_UNAVAILABLE', 'Локальный редактор отсутствует в этой сборке Flux.');
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { resources, app }, execArgv: [] });
  const pending = new Map<number, Waiting>();
  const listeners = new Set<(id: number, channel: string, args: unknown[]) => void>();
  let next = 0; let stopped = false; let fatal: unknown;
  let readyResolve!: () => void; let readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Ошибка старта может случиться до первого open; она всё равно ждёт его,
  // а не превращается в необработанный rejection основного процесса.
  void ready.catch(() => {});
  const asError = (data: any) => new WindowsFilesError(data?.code || 'EDITOR_ERROR', data?.message || 'Локальный редактор недоступен.');
  const fail = (error: unknown) => {
    fatal = error; readyReject(error);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', code => {
    if (!stopped) fail(new WindowsFilesError('EDITOR_STOPPED', `Локальный редактор завершил работу (${code}). Исходный файл сохранён.`));
  });
  worker.on('message', (message: any) => {
    if (message?.type === 'ready') { readyResolve(); return; }
    if (message?.type === 'failed') { fail(asError(message.error)); void worker.terminate(); return; }
    if (message?.type === 'event') {
      for (const fn of listeners) fn(message.id, message.channel, message.args);
      return;
    }
    if (message?.type === 'commit') {
      const entry = pending.get(message.parentId);
      const operation = entry?.commit;
      // Запись исходного Windows-файла остаётся в основном процессе: только
      // он владеет capability, проверкой лицензии и исходного хеша.
      void Promise.resolve().then(() => {
        if (!operation) throw new WindowsFilesError('COMMIT_NOT_GRANTED', 'Запись файла не разрешена.');
        return operation();
      }).then(() => worker.postMessage({ type: 'commit-result', commitId: message.commitId, ok: true }),
        (error: any) => worker.postMessage({ type: 'commit-result', commitId: message.commitId, ok: false,
          error: { code: error?.code || 'EDITOR_ERROR', message: error?.message || 'Сохранение не удалось.' } })).catch(() => {});
      return;
    }
    if (message?.type !== 'result') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.value); else entry.reject(asError(message.error));
  });
  const call = async (method: string, args: unknown[], commit?: () => Promise<void>): Promise<any> => {
    await ready;
    if (stopped || fatal) throw fatal || new WindowsFilesError('EDITOR_STOPPED', 'Редактор закрыт.');
    const id = ++next;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, commit });
      try { worker.postMessage({ type: 'call', id, method, args, commit: !!commit }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  };
  return {
    start: () => {},
    open: (path, dataDir) => call('open', [path, dataDir]),
    setDataDir: (id, path) => call('setDataDir', [id, path]),
    invoke: (id, channel, args, saveTarget, commit) => call('invoke', [id, channel, args, saveTarget], commit),
    send: (id, channel, args) => call('send', [id, channel, args]),
    onSend: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    close: id => call('close', [id]),
    requestCopy: (id, path) => call('requestCopy', [id, path]),
    dispose: async () => {
      stopped = true; listeners.clear(); fail(new WindowsFilesError('EDITOR_STOPPED', 'Редактор закрыт.'));
      await worker.terminate();
    },
  };
}
