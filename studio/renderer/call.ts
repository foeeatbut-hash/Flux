/**
 * Мост окна с главным процессом и общие типы ответов. Мост window.studio отдаёт предзагрузка (studio/shell/preload.ts);
 * окно ничего не решает про права и ключи: оно вызывает перечисленные действия и показывает ответ.
 */
export interface Snapshot {
  version: string; build: string; name: string; connected: boolean; display: string; warning: string; remembered: string;
  user: { id: string; name: string } | null; sections: { id: string; title: string }[];
}
export type Reply<T> = { ok: boolean; value: T; error: string };
declare global {
  interface Window {
    __bootSplashDone?: (instant: boolean) => void;
    studio: {
      call: <T = unknown>(action: string, args?: object) => Promise<Reply<T>>;
      onState: (fn: (state: Snapshot) => void) => () => void;
      onProgress: (fn: (data: { phase: string }) => void) => () => void;
    };
  }
}

/** Вызов с исключением: раздел ловит его в одном месте и показывает текст ошибки на экране */
export async function call<T = unknown>(action: string, args: object = {}): Promise<T> {
  const reply = await window.studio.call<T>(action, args);
  if (!reply.ok) throw new Error(reply.error || 'Операция не выполнена.');
  return reply.value;
}

export interface KeyInfo { available: boolean; exists: boolean; publicKey: string; createdAt: number; damaged: boolean }
export interface DraftSummary { id: string; name: string; version: string; language: string; updatedAt: number; parentRequest: string | null }
export interface DraftState { parentRequest: string | null; baseRelease: string | null; changelog: string; comment: string; channel: 'test' | 'production' }
export interface CheckItem { id: string; title: string; status: 'ok' | 'fail' | 'manual'; detail: string }
export interface CheckReport { v: 1; ok: boolean; at: number; studio: string; items: CheckItem[] }
export interface RequestRow {
  id: string; moduleId: string; version: string; state: string; parentId: string | null; changelog: string; channel: string;
  createdAt: string; decidedAt: string | null; review: { note: string; comments: Array<{ path: string; line: number | null; text: string }> } | null;
}

export const REQUEST_STATES: Record<string, string> = {
  pending: 'На проверке у владельца', returned: 'Возвращена на доработку', rejected: 'Отклонена', edited: 'Владелец внёс правки',
  superseded: 'Заменена новой отправкой', released: 'Выпущена', writing: 'Загружается',
};
/** Цвет точки статуса: слово всегда рядом (методология: статус — точка и слово) */
export const STATE_TONE: Record<string, string> = { pending: 'warn', returned: 'warn', rejected: 'bad', edited: 'warn', superseded: 'muted', released: 'ok', writing: 'muted' };
