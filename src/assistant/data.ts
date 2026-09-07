/**
 * Данные, которыми пользуется помощник, и действия, которые он умеет делать.
 *
 * Отдельно от хранилища разговора: разговор — это очередь сообщений и
 * состояние диалога, а здесь чтение проекта и правка тега. Слипшись, они
 * однажды дали бы обновление списка сообщений на каждый запрос к серверу.
 *
 * Ответ проекта живём коротким кэшем: помощник спрашивает данные почти на
 * каждый вопрос, а меняются они куда реже. Кэш сбрасывается после любой своей
 * правки — иначе следующий же ответ был бы про то, чего уже нет.
 */
import { ENV_CONFIG } from '../config/env';

/** Что сервер отдаёт помощнику по проекту */
export interface AssistantData {
  projectId: string;
  projects: { id: string; name: string; status: string }[];
  tags: { id: string; identifier: string; brand?: string; department?: string; wbs?: string; fluid?: string; mainName?: string; actuality?: string; stageId?: string; stageLabel?: string; stageSince?: string | null; stageIsFinal?: boolean; supplier?: string; qty?: string }[];
  components: { id: string; name: string; itemCode: string; systemName: string; category: string; monoblockName: string; status: string; hasConflict: boolean; tags: string[]; specs?: { key: string; value: string; unit: string; group: string }[];
    /** Сколько характеристик у позиции всего: список приходит обрезанным */
    specsTotal?: number }[];
  stages: { id: string; label: string }[];
  duplicates: { code: string; count: number; ids: string[] }[];
  notes: { id: string; title: string; updatedAt: string }[];
  recentLogs: { description: string; userName: string; targetRoute: string; createdAt: string }[];
  counts: Record<string, number>;
}

/** Сколько ответ проекта считается свежим */
const FRESH_MS = 15000;

let dataCache: { data: AssistantData; ts: number } | null = null;

let getActiveProjectId: (() => string | null) | null = null;
export function setDataProjectGetter(fn: () => string | null) {
  getActiveProjectId = fn;
}

export async function fetchAssistantData(): Promise<AssistantData> {
  const now = Date.now();
  if (dataCache && now - dataCache.ts < FRESH_MS) return dataCache.data;
  const projectId = (getActiveProjectId && getActiveProjectId()) || '';
  const res = await fetch(`${ENV_CONFIG.apiUrl}/assistant/data?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error('Не удалось получить данные из базы');
  const data = await res.json();
  dataCache = { data, ts: now };
  return data;
}

export function invalidateDataCache() { dataCache = null; }

/**
 * Переименование тега — смена identifier.
 *
 * Связи хранятся по идентификатору тега в metadata, поэтому переименование их
 * не рвёт. Разделам, показывающим теги, сообщаем событием: у холста и дерева
 * свои копии списка, и без этого они остались бы со старым кодом.
 */
export async function renameTagApi(tagId: string, newCode: string): Promise<void> {
  const res = await fetch(`${ENV_CONFIG.apiUrl}/tags/${tagId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: newCode }),
  });
  if (!res.ok) {
    let m = 'Не удалось переименовать тег';
    try { const d = await res.json(); if (d?.error) m = d.error; } catch (_) {}
    throw new Error(m);
  }
  invalidateDataCache();
  try { window.dispatchEvent(new CustomEvent('flux:tags-changed')); } catch (_) {}
}

/** Проверка кода тега: непустой, разумной длины, без пробелов внутри */
export function validateTagCode(raw: string): { ok: boolean; code: string; error?: string } {
  const code = raw.trim();
  if (!code) return { ok: false, code, error: 'Код пустой' };
  if (code.length > 80) return { ok: false, code, error: 'Слишком длинный код (макс. 80 символов)' };
  if (/\s/.test(code)) return { ok: false, code, error: 'В коде тега не должно быть пробелов' };
  return { ok: true, code };
}
