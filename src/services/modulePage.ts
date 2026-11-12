/**
 * Общее для окон программы-страницы (договор v2) на стороне Flux: состояние окна, обмен сообщениями между
 * окнами одной программы, открытие своих окон и «отдать файл пользователю».
 *
 * Всё привязано к идентификатору программы: окна другой программы и разделы Flux сюда не попадают.
 */
import { useWindowStore } from '../store/windowStore';
import { PAGE_LIMITS, WINDOW_LIMITS } from '../../modules/page/model';

export { pageState, pageStateKey } from '../lib/pageStateMemory';
/** Пороги «не отвечает»; поле, а не константа, чтобы проверка в настоящем Electron не ждала полминуты */
export const pageTimings: { hangMs: number } = { hangMs: PAGE_LIMITS.hangMs };

type Listener = (data: unknown) => void;
const buses = new Map<string, Set<{ deliver: Listener }>>();
/** Подключить окно к обмену своей программы; сообщение получают остальные окна, но не отправитель */
export function joinPageBus(moduleId: string, deliver: Listener) {
  const me = { deliver };
  const set = buses.get(moduleId) ?? new Set();
  set.add(me); buses.set(moduleId, set);
  return {
    send: (data: unknown) => { for (const other of [...(buses.get(moduleId) ?? [])]) if (other !== me) other.deliver(data); },
    leave: () => { set.delete(me); if (!set.size) buses.delete(moduleId); },
  };
}

export const moduleWindowHref = (moduleId: string, page: string, params: Record<string, unknown>) => {
  const query = new URLSearchParams();
  if (page !== 'index.html') query.set('page', page);
  if (Object.keys(params).length) query.set('params', JSON.stringify(params));
  const text = query.toString();
  return `/module/${moduleId}${text ? `?${text}` : ''}`;
};
/** Открыть ещё одно окно программы; false — предел числа окон */
export function openModuleWindow(moduleId: string, page: string, params: Record<string, unknown>): boolean {
  const store = useWindowStore.getState();
  const own = () => useWindowStore.getState().windows.filter(w => w.path === `/module/${moduleId}`).length;
  if (own() >= WINDOW_LIMITS.windows) return false;
  const before = own();
  store.openAnother(moduleWindowHref(moduleId, page, params));
  // Раздел мог быть скрыт правами: окно не открылось — честный отказ, а не «готово»
  return own() > before;
}

/**
 * Файл пользователя для программы (flux.openFile). В Flux диалог показывает главный процесс; в браузере, где
 * главного процесса нет, — обычное окно выбора файла браузера. Возвращается только имя и содержимое выбранного файла.
 */
export async function pickFileForProgram(program: string, accept: string[]): Promise<{ name: string; mime: string; bytes: Uint8Array } | 'cancelled' | 'limit'> {
  const ipc = (window as any).electron?.ipcRenderer as { invoke: (channel: string, ...args: unknown[]) => Promise<any> } | undefined;
  if (ipc) {
    const reply = await ipc.invoke('modules:pick-file', { program, accept });
    if (reply?.ok) return { name: String(reply.name), mime: '', bytes: new Uint8Array(reply.bytes) };
    if (reply?.code === 'CANCELLED') return 'cancelled';
    if (reply?.code === 'LIMIT') return 'limit';
    throw new Error(String(reply?.code || 'FAILED'));
  }
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept.length) input.accept = accept.join(',');
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) { resolve('cancelled'); return; }
      resolve(file.size > PAGE_LIMITS.openBytes ? 'limit' : { name: file.name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
    });
    input.addEventListener('cancel', () => resolve('cancelled'));
    input.click();
  });
}

/**
 * Файл пользователю: страница на диск не пишет. Flux спрашивает человека и отдаёт файл системному диалогу
 * сохранения (обычная загрузка в окне Flux).
 */
export async function offerFileToUser(program: string, file: { name: string; mime: string; bytes: Uint8Array }): Promise<'saved' | 'cancelled'> {
  if (file.bytes.length > PAGE_LIMITS.saveChars) return 'cancelled';
  const kb = Math.max(1, Math.round(file.bytes.length / 1024));
  if (!window.confirm(`Программа «${program}» предлагает сохранить файл «${file.name}» (${kb} КБ). Сохранить?`)) return 'cancelled';
  const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.mime }));
  const link = document.createElement('a');
  link.href = url; link.download = file.name; link.rel = 'noopener';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'saved';
}
