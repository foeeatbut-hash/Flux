/**
 * Окно Flux ↔ редактор Flux Office во фрейме: общие правила переписки.
 *
 * Вторая половина — tools/genoffice/flux-bridge.js внутри фрейма. Здесь то,
 * что должно совпадать у обеих сторон и что можно проверить без браузера
 * (scripts/test-office-bridge.ts).
 */

/** Сообщение редактора окну: запрос с номером или извещение без ответа */
export interface OfficeMsg {
  flux: 'office';
  id?: number;
  op: string;
  payload?: any;
}

export const isOfficeMsg = (m: unknown): m is OfficeMsg =>
  !!m && typeof m === 'object' && (m as any).flux === 'office' && typeof (m as any).op === 'string';

/**
 * Файл Flux, спрятанный в «путь» редактора.
 *
 * Редактор думает, что работает с диском, и помнит путь файла. Мы отдаём ему
 * `flux://file/<номер>` — после «Сохранить как» он пишет уже по новому пути, и
 * по нему окно понимает, какой файл сохранять.
 */
export const FILE_PREFIX = 'flux://file/';
export const pathOf = (fileId: string): string => FILE_PREFIX + fileId;
export function fileIdOf(path: unknown): string {
  const s = String(path || '');
  if (!s.startsWith(FILE_PREFIX)) return '';
  const id = s.slice(FILE_PREFIX.length);
  // Только номер: никаких «../» и адресов в запросе к серверу
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : '';
}

/**
 * Кому отправлять.
 *
 * С сервера — только своему адресу. Портативная сборка открывается с диска, у
 * такой страницы адреса нет (origin — 'null'), и тогда адресат задаётся самим
 * окном фрейма, а '*' — единственное, что браузер принимает.
 */
export const targetOrigin = (origin: string): string => (origin === 'null' || !origin ? '*' : origin);

/** Пришло ли сообщение от своего: то же окно и тот же адрес */
export function fromOwnFrame(source: unknown, frame: unknown, origin: string, own: string): boolean {
  if (!frame || source !== frame) return false;
  if (own === 'null' || !own) return origin === 'null' || origin === 'file://';
  return origin === own;
}

/** Хеш содержимого — тот же, что считает сервер (sha256, hex) */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Имя копии «рядом»: «Отчёт.docx» → «Отчёт (мои правки).docx» */
export const copyName = (name: string): string =>
  /\.[^.]+$/.test(name) ? name.replace(/(\.[^.]+)$/, ' (мои правки)$1') : `${name} (мои правки)`;
