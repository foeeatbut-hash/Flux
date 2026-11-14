/**
 * Общее для запуска программы в Studio: что вернул запуск, строки журнала, обмен между окнами одной программы,
 * вопрос о закрытии и порог «не отвечает». Чистые куски без React: их же берёт набор интерфейса.
 */
import type { LaunchContext, ModuleManifest } from '../../../../modules/contract';
import type { PageDialog } from '../../../../modules/page/model';
import { PAGE_LIMITS, WINDOW_LIMITS } from '../../../../modules/page/model';
import { initialRect } from '../../../../src/lib/windows';

export interface Started {
  session: string; url: string; language: string;
  manifest: Pick<ModuleManifest, 'id' | 'name' | 'version' | 'reads' | 'entries' | 'ui' | 'pages' | 'permissions'> & { connections: unknown[] };
  context: LaunchContext;
}
export interface LogRow { at: string; kind: string; text: string; level: 'info' | 'warn' | 'error' }
export type Log = (kind: string, text: string, level?: LogRow['level']) => void;

/** Окно программы кроме главного: страница из ui/, параметры, заголовок и размер из flux.windows.open */
export interface WindowSpec { key: string; page: string; params: Record<string, unknown>; title: string; width?: number; height?: number }
/** Размер окна без указания: как у окна Flux по умолчанию */
export const DEFAULT_WINDOW = { width: 640, height: 420 } as const;
/**
 * Главное окно программы: размер первого окна Flux на столе 1280 × 720 (initialRect: 72 % × 78 %). Во Flux окно подгоняется под
 * стол человека, у Studio стола нет, поэтому берётся размер самого обычного стола.
 */
const FLUX_FIRST_WINDOW = initialRect({ w: 1280, h: 720 }, 0);
export const DEFAULT_MAIN = { width: FLUX_FIRST_WINDOW.w, height: FLUX_FIRST_WINDOW.h } as const;

/** Те же слова, что у окна Flux при закрытии окна с несохранённым (src/components/modules/useProgramWindow.tsx) */
export const CLOSE_TITLE = 'Закрыть без сохранения?';
export const CLOSE_DEFAULT_TEXT = 'В окне есть несохранённые изменения.';
export const closeRequest = (text: string): PageDialog => ({ kind: 'confirm', title: CLOSE_TITLE, text: text || CLOSE_DEFAULT_TEXT, ok: 'Закрыть', cancel: 'Отмена', danger: true });

/** «Программа — заголовок»; без заголовка просто название программы */
export const windowTitle = (program: string, custom: string) => (custom ? `${program} — ${custom}` : program);

/**
 * Порог «не отвечает». В окне запуска его можно сократить адресом `?hang=<мс>` (не меньше 1000): проверка в браузере
 * не ждёт полминуты. Программе это ничего не открывает — только раньше показывает плашку.
 */
export function hangLimit(search: string = typeof location === 'undefined' ? '' : location.search): number {
  const wanted = Number(new URLSearchParams(search).get('hang'));
  return Number.isFinite(wanted) && wanted >= 1000 ? wanted : PAGE_LIMITS.hangMs;
}

/** Окно можно открыть, пока всего окон программы (вместе с главным) меньше предела; как у openModuleWindow во Flux */
export const canOpenWindow = (open: number) => open < WINDOW_LIMITS.windows;

/** Обмен между окнами одной программы: сообщение получают остальные окна, но не отправитель (как joinPageBus во Flux) */
export function createPageBus() {
  const members = new Set<{ deliver: (data: unknown) => void }>();
  return {
    join(deliver: (data: unknown) => void) {
      const me = { deliver };
      members.add(me);
      return { send: (data: unknown) => { for (const other of [...members]) if (other !== me) other.deliver(data); }, leave: () => { members.delete(me); } };
    },
    size: () => members.size,
  };
}
export type PageBus = ReturnType<typeof createPageBus>;
