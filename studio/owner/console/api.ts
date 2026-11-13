/** Мост к главному процессу: ошибка действия становится исключением с понятным текстом */
declare global {
  interface Window {
    ownerConsole: {
      call: (action: string, args?: object) => Promise<{ ok: boolean; value?: any; error?: string; canceled?: boolean }>;
      onLocked: (fn: () => void) => () => void;
      onDisconnected: (fn: () => void) => () => void;
      onTab: (fn: (tab: string) => void) => () => void;
      onProgress: (fn: (progress: { phase: string; current: number; total: number }) => void) => () => void;
    };
  }
}
/** Владелец сам отказался в диалоге подтверждения: это не ошибка */
export class Canceled extends Error {}
export async function call<T = any>(action: string, args: object = {}): Promise<T> {
  const reply = await window.ownerConsole.call(action, args);
  if (!reply.ok) throw reply.canceled ? new Canceled(reply.error || 'Отменено') : new Error(reply.error || 'Операция не выполнена.');
  return reply.value as T;
}
