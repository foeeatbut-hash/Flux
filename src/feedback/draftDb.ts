/**
 * Черновики обращений: IndexedDB, а не localStorage.
 *
 * Причина одна и решающая: к обращению прикладывают снимки. Картинка в
 * localStorage — это строка base64, которая раздувает её на треть и упирается в
 * общий предел в несколько мегабайт на весь домен; один снимок экрана съедает
 * его целиком, и вместе с ним пропадают настройки окон и панели задач.
 * IndexedDB хранит Blob как есть.
 *
 * Первое использование IndexedDB в программе, поэтому оборонительность здесь
 * та же, что у всего остального хранилища браузера: любой вызов может отказать
 * (приватный режим, кончилось место, политика запрета), и отказ не должен ни
 * ронять окно, ни выглядеть как потеря текста.
 *
 * Ключ черновика включает контур и человека. Смена сервера или вход другим
 * сотрудником не должны показывать чужие черновики и — тем более — не должны
 * отправлять начатое в одном контуре в другой.
 */

export interface DraftAttachment {
  id: string;
  name: string;
  kind: 'IMAGE' | 'FILE' | 'DIAGNOSTICS';
  /** Готовые к отправке байты: уже плоские, уже без исходника под маской. */
  blob: Blob;
  width?: number;
  height?: number;
}

export interface Draft {
  /** Ключ: контур + человек + черновик. */
  id: string;
  deploymentId: string;
  userId: string;
  draftId: string;
  updatedAt: number;
  /**
   * Состояние отправки. Локальное — серверных статусов здесь нет.
   *
   * Три последних — не оттенки неудачи, а разные разговоры: «попробуем сами»,
   * «войдите заново», «нужно что-то поправить». Сложить их в одно `FAILED`
   * значит показать человеку одну и ту же бесполезную надпись во всех трёх
   * случаях.
   */
  state: 'EDITING' | 'PREPARING' | 'READY' | 'QUEUED' | 'UPLOADING' | 'COMMITTING' | 'SENT'
    | 'FAILED_RETRYABLE' | 'NEEDS_SIGN_IN' | 'NEEDS_REVIEW' | 'CANCELLED';
  /** Ключ подтверждённой отправки: повтор после обрыва вернёт ту же карточку. */
  clientRequestId?: string;
  fields: Record<string, unknown>;
  attachments: DraftAttachment[];
  /** Что пошло не так в последней попытке — человеку, а не в консоль. */
  note?: string;
}

const DB_NAME = 'flux-feedback';
const DB_VERSION = 1;
const STORE = 'drafts';

/** Черновиков на человека и сколько всего места им отведено. */
export const DRAFT_LIMIT = 20;
export const DRAFT_BYTES = 100 * 1024 * 1024;

export const draftKey = (deploymentId: string, userId: string, draftId: string): string =>
  `${deploymentId}|${userId}|${draftId}`;

let opening: Promise<IDBDatabase | null> | null = null;

/** Открыть базу. `null` означает «хранилища нет» — это рабочее состояние. */
export function openDraftDb(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          // По этим двум ищут «мои черновики в этом контуре»
          store.createIndex('owner', ['deploymentId', 'userId'], { unique: false });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch (_) { resolve(null); }
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDraftDb().then((db) => {
    if (!db) return null;
    return new Promise<T | null>((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  });
}

/** Сколько места занимают вложения черновика. */
export const draftBytes = (draft: Draft): number =>
  (draft.attachments || []).reduce((sum, a) => sum + (a.blob?.size || 0), 0);

export type SaveResult =
  | { ok: true }
  /** Места нет. Текст не потерян — его надо предложить выгрузить файлом. */
  | { ok: false; reason: 'quota' | 'unavailable' | 'tooMany' };

/**
 * Записать черновик.
 *
 * «Сохранено на этом устройстве» показывается ТОЛЬКО после успешной записи.
 * Зелёная галочка при отказе — худшее, что здесь можно сделать: человек уйдёт,
 * а текста не будет.
 */
export async function saveDraft(draft: Draft): Promise<SaveResult> {
  const db = await openDraftDb();
  if (!db) return { ok: false, reason: 'unavailable' };

  const mine = await listDrafts(draft.deploymentId, draft.userId);
  const others = mine.filter((d) => d.id !== draft.id);
  // Несданные черновики сами не удаляются: человек их писал. Вместо этого
  // говорим, что места нет, и предлагаем разобрать
  if (others.length >= DRAFT_LIMIT) return { ok: false, reason: 'tooMany' };
  const used = others.reduce((sum, d) => sum + draftBytes(d), 0);
  if (used + draftBytes(draft) > DRAFT_BYTES) return { ok: false, reason: 'quota' };

  const written = await new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ ...draft, updatedAt: Date.now() });
      tx.oncomplete = () => resolve(true);
      // QuotaExceededError приходит именно сюда, а не в вызов put
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch (_) { resolve(false); }
  });
  return written ? { ok: true } : { ok: false, reason: 'quota' };
}

export async function readDraft(id: string): Promise<Draft | null> {
  const found = await run<Draft>('readonly', (store) => store.get(id) as IDBRequest<Draft>);
  return found || null;
}

export async function listDrafts(deploymentId: string, userId: string): Promise<Draft[]> {
  const all = await run<Draft[]>('readonly', (store) => store.getAll() as IDBRequest<Draft[]>);
  if (!all) return [];
  // Чужие черновики не показываем никому: ни другому человеку за этим
  // компьютером, ни себе же после переключения на другую базу
  return all
    .filter((d) => d && d.deploymentId === deploymentId && d.userId === userId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function dropDraft(id: string): Promise<void> {
  await run('readwrite', (store) => store.delete(id) as unknown as IDBRequest<undefined>);
}

/**
 * Забыть всё, что принадлежит этому человеку в этом контуре.
 *
 * Зовётся при выходе: черновики предыдущего сотрудника не должны попасть на
 * глаза следующему за тем же компьютером.
 */
export async function forgetDrafts(deploymentId: string, userId: string): Promise<void> {
  const mine = await listDrafts(deploymentId, userId);
  for (const draft of mine) await dropDraft(draft.id);
}

/** Черновик файлом — когда места в браузере не осталось, а текст терять нельзя. */
export function draftToFile(draft: Draft): Blob {
  const plain = {
    сохранено: new Date(draft.updatedAt || Date.now()).toISOString(),
    поля: draft.fields,
    вложения: (draft.attachments || []).map((a) => ({ имя: a.name, вид: a.kind, байт: a.blob?.size || 0 })),
  };
  return new Blob([JSON.stringify(plain, null, 2)], { type: 'application/json' });
}
