/**
 * Несохранённая правка, пережившая закрытие окна.
 *
 * Зачем. Запись документа может не дойти до сервера: сеть оборвалась, сервер
 * ответил 500, чужая версия оказалась новее. До этого модуля в таком случае
 * единственная копия работы человека жила только в памяти открытого окна —
 * закрыл окно или закрылась программа, и правка исчезла без следа.
 *
 * Теперь неудачная запись оставляет снимок здесь, и при следующем открытии
 * того же документа человеку предлагают его вернуть. Это именно страховка, а
 * не второе хранилище: черновик живёт у одного человека в одном браузере, и
 * успешная запись его убирает.
 *
 * Правила — размер, устаревание, «отличается ли от серверного» — чистые и
 * проверяются скриптом; хранилище отделено, потому что в приватном окне и при
 * запрете на сайт оно бросает, а терять из-за этого окно нельзя.
 */

const KEY = 'flux.docDraft.';

/** Отложенный снимок одного документа. */
export interface DocDraft {
  docId: string;
  snapshot: string;
  /** Когда отложили, мс */
  at: number;
  /** Почему не сохранилось — это же и покажем человеку */
  reason: string;
}

/**
 * Предел на черновик.
 *
 * localStorage у браузера порядка пяти мегабайт на весь сайт, и одна большая
 * книга способна занять его целиком — вместе с настройками, которые там уже
 * лежат. Лучше честно отказаться от страховки для гиганта, чем сломать
 * хранилище и потерять заодно чужие данные.
 */
export const DRAFT_LIMIT = 2 * 1024 * 1024;

export const tooBigForDraft = (snapshot: string): boolean => (snapshot || '').length > DRAFT_LIMIT;

/**
 * Через сколько черновик перестаёт предлагаться.
 *
 * Неделя: вернуться к работе после выходных — обычное дело, а предлагать
 * восстановить месячной давности правку поверх документа, который с тех пор
 * десять раз поменялся, — вредный совет.
 */
export const DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;

export const draftExpired = (d: DocDraft, now = Date.now()): boolean => now - d.at > DRAFT_TTL;

/**
 * Стоит ли вообще предлагать возврат.
 *
 * Не стоит, если черновик пуст, просрочен или совпадает с тем, что и так
 * пришло с сервера: предложение «вернуть» то же самое только пугает.
 */
export function worthRestoring(d: DocDraft | null, serverSnapshot: string, now = Date.now()): boolean {
  if (!d || !d.snapshot) return false;
  if (draftExpired(d, now)) return false;
  return d.snapshot !== (serverSnapshot || '');
}

/** Человеческое «когда»: черновик без времени выглядит подозрительно. */
export function draftAgeText(d: DocDraft, now = Date.now()): string {
  const min = Math.floor((now - d.at) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} дн назад`;
}

// ── Хранилище ────────────────────────────────────────────────────────────────

const quiet = <T,>(fn: () => T, fallback: T): T => {
  try { return fn(); } catch (_) { return fallback; }
};

/** Отложить снимок. Возвращает false, если не влез или хранилище недоступно. */
export function saveDraft(docId: string, snapshot: string, reason: string): boolean {
  if (!docId || !snapshot || tooBigForDraft(snapshot)) return false;
  const d: DocDraft = { docId, snapshot, at: Date.now(), reason };
  return quiet(() => { localStorage.setItem(KEY + docId, JSON.stringify(d)); return true; }, false);
}

export function readDraft(docId: string): DocDraft | null {
  if (!docId) return null;
  return quiet(() => {
    const raw = localStorage.getItem(KEY + docId);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && typeof d.snapshot === 'string' ? (d as DocDraft) : null;
  }, null);
}

export function clearDraft(docId: string): void {
  if (!docId) return;
  quiet(() => { localStorage.removeItem(KEY + docId); return true; }, false);
}
