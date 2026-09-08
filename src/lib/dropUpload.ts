/**
 * Отправка принесённых файлов на сервер — одна на стол и на Проводник.
 *
 * Правила приёма (что берём, под каким именем, что говорим) живут отдельно, в
 * dropFiles.ts: у них есть правильный ответ, и его проверяет скрипт. Здесь —
 * сама отправка, которой нужен браузер, поэтому её проверяют живой пробой.
 *
 * Один путь на два приёмника не ради экономии строк: пока стол и Проводник
 * принимали файлы по-своему, одно и то же движение мышью давало разный
 * результат — и разошлись они настолько, что стол не принимал файлы вовсе.
 */
import { planDrop, typeOf, dropResult } from './dropFiles';

export interface UploadTarget {
  /** Папка Проводника; null — корень раздела */
  folderId: string | null;
  scope?: 'SHARED' | 'PERSONAL';
  ownerId?: string | null;
  /** Кто принёс — для полей «создал» и «изменил» */
  userId?: string | null;
}

export interface UploadOutcome {
  ok: number;
  /** Что отклонили правилами и почему */
  refused: { name: string; why: string }[];
  /** Что не дошло до сервера */
  failed: string[];
  /** Строка для человека */
  said: string;
}

/**
 * Каким куском слать содержимое — спрашивается у сервера: он знает предел
 * пакета своей базы. Если спросить не удалось, берём осторожный кусок: лучше
 * больше запросов, чем оборванное соединение без объяснения.
 */
const SAFE_CHUNK = 512 * 1024;
let chunkCache = 0;
export async function chunkBytes(): Promise<number> {
  if (chunkCache) return chunkCache;
  try {
    const res = await fetch('/api/limits');
    const d = await res.json();
    chunkCache = Number(d?.chunkBytes) || SAFE_CHUNK;
  } catch (_) {
    chunkCache = SAFE_CHUNK;
  }
  return chunkCache;
}

/**
 * Откуда файл принесли. В программе путь спрашивается у оболочки, в браузере
 * его не знает никто — и это нормально: выгрузка тогда просто не подставит
 * папку, а спросит.
 */
export function originOf(file: File): string {
  try {
    const e = (window as any).electron;
    return e?.pathOfFile ? String(e.pathOfFile(file) || '') : '';
  } catch (_) {
    return '';
  }
}

/** Кусок файла в base64. Читаем срез, а не файл целиком: он может не влезть */
const sliceBase64 = (file: File, from: number, to: number): Promise<string | null> =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const raw = String(e.target?.result || '');
      resolve(raw ? raw.slice(raw.indexOf(',') + 1) : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file.slice(from, to));
  });

/**
 * Отправить содержимое кусками. Возвращает пустую строку, если всё дошло, или
 * причину — её человек и увидит.
 *
 * Ход считается по БАЙТАМ, а не по файлам: перенос книги на четыреста
 * мегабайт — это минуты, и полоса, которая дёргается раз на файл, о них не
 * говорит ничего.
 */
async function sendContent(
  fileId: string,
  file: File,
  piece: number,
  onBytes?: (done: number) => void,
): Promise<string> {
  let idx = 0;
  for (let from = 0; from < file.size; from += piece) {
    const to = Math.min(file.size, from + piece);
    const data = await sliceBase64(file, from, to);
    if (data === null) return 'не удалось прочитать файл';
    const res = await fetch(`/api/files/${encodeURIComponent(fileId)}/chunk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idx, data }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return String(d?.error || `сервер ответил ${res.status}`);
    }
    idx++;
    onBytes?.(to);
  }
  const done = await fetch(`/api/files/${encodeURIComponent(fileId)}/done`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!done.ok) {
    const d = await done.json().catch(() => ({}));
    return String(d?.error || `сервер ответил ${done.status}`);
  }
  return '';
}

/**
 * Отправить принесённые файлы. `taken` — имена, уже занятые в папке.
 *
 * Сначала заводится ЗАПИСЬ файла — пустая, — и только потом в неё едет
 * содержимое кусками. Порядок именно такой: куску нужен адрес, куда лечь, а
 * записи с содержимым внутри больше не бывает.
 *
 * `onProgress` зовётся по ходу, а не после каждого файла: доля считается по
 * байтам всего переноса. Полоса, которая дёргается раз на файл, о переносе
 * книги на четыреста мегабайт не говорит ничего.
 */
export async function uploadDropped(
  files: File[],
  target: UploadTarget,
  taken: Iterable<string> = [],
  onProgress?: (done: number, total: number) => void,
): Promise<UploadOutcome> {
  const plan = planDrop(files, taken);
  const piece = await chunkBytes();
  const failed: string[] = [];
  let ok = 0;

  const totalBytes = plan.accepted.reduce((n, a) => n + (a.file.size || 0), 0) || 1;
  let sentBytes = 0;
  const tell = () => onProgress?.(Math.min(totalBytes, sentBytes), totalBytes);

  for (const { file, name } of plan.accepted) {
    const before = sentBytes;
    try {
      const scopeLabel = target.scope === 'PERSONAL' ? 'personal' : 'shared';
      const res = await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          folderId: target.folderId,
          ...(target.scope ? { scope: target.scope, ownerId: target.ownerId } : {}),
          filePath: `/${scopeLabel}/${name}`,
          size: file.size,
          type: typeOf(name),
          department: 'Unassigned',
          origin: originOf(file),
          createdById: target.userId,
          updatedById: target.userId,
        }),
      });
      const made = await res.json().catch(() => ({}));
      if (!res.ok || !made?.file?.id) { failed.push(name); sentBytes = before + (file.size || 0); tell(); continue; }

      const why = await sendContent(made.file.id, file, piece, (doneOfFile) => {
        sentBytes = before + doneOfFile;
        tell();
      });
      if (why) {
        // Запись без содержимого — файл, который «загрузился», но не
        // открывается. Убираем её сразу: пустой значок хуже честного отказа
        await fetch(`/api/files/${encodeURIComponent(made.file.id)}`, { method: 'DELETE' }).catch(() => {});
        failed.push(name);
      } else ok++;
    } catch (_) {
      failed.push(name);
    }
    sentBytes = before + (file.size || 0);
    tell();
  }

  return { ok, refused: plan.refused, failed, said: dropResult(ok, plan.refused, failed) };
}

/**
 * Файлы из переноса. Отдельной функцией, потому что у переноса из Windows и
 * переноса своих значков одно и то же событие: если не отделить одно от
 * другого, стол либо не примет файл, либо «примет» собственный значок.
 */
export function filesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  try {
    return Array.from(dt.files || []);
  } catch (_) {
    return [];
  }
}

/** Несут ли файлы Windows — это видно ещё до того, как отпустили кнопку */
export function carriesFiles(dt: DataTransfer | null): boolean {
  try {
    return !!dt && Array.from(dt.types || []).includes('Files');
  } catch (_) {
    return false;
  }
}
