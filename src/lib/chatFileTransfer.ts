/**
 * Вложения чата на стороне окна: загрузка кусками и скачивание в «Загрузки».
 *
 * Загрузка. Файл до 500 МБ нельзя целиком читать в строку base64 (так делала
 * прежняя версия и упиралась в 25 МБ): окно читает срез за срезом и шлёт
 * куски того размера, который назвал сервер. Контрольная сумма куска — та же,
 * что у файлов Проводника (dropUpload.chunkSha256).
 *
 * Скачивание. В программе (Electron) файл сохраняет главный процесс прямо в
 * системную папку «Загрузки» под уникальным именем; окно получает путь и
 * показывает «Сохранено в Загрузки» с кнопкой «Показать в папке». В браузере
 * остаётся обычное скачивание.
 */
import { SERVER_BASE_URL } from '../config/env';
import { chunkSha256 } from './dropUpload';

export const CHAT_FILE_LIMIT_BYTES = 500 * 1024 * 1024;

export interface ChatUploaded { filePath: string; fileName: string; fileSize: number }

async function say(res: Response, fallback: string): Promise<string> {
  const d: any = await res.json().catch(() => ({}));
  return String(d?.error || d?.message || fallback);
}

/** Срез файла в base64: читаем кусок, а не файл целиком */
function sliceBase64(file: Blob, from: number, to: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.readAsDataURL(file.slice(from, to));
  });
}

/** Загрузить вложение кусками. `onProgress` получает долю 0..1 по байтам */
export async function uploadChatFile(file: File, onProgress?: (share: number) => void, signal?: AbortSignal): Promise<ChatUploaded> {
  if (!file.size) throw new Error('Файл пустой');
  if (file.size > CHAT_FILE_LIMIT_BYTES) throw new Error(`Файл больше ${CHAT_FILE_LIMIT_BYTES / 1048576} МБ: положите его в Проводник и отправьте ссылкой`);
  const start = await fetch('/api/chat/upload/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, size: file.size }),
  });
  if (!start.ok) throw new Error(await say(start, `Файл не принят сервером (${start.status})`));
  const { id, chunkBytes } = await start.json();
  try {
    const piece = Number(chunkBytes) || 512 * 1024;
    let idx = 0;
    for (let from = 0; from < file.size; from += piece) {
      if (signal?.aborted) throw new Error('Загрузка отменена');
      const to = Math.min(file.size, from + piece);
      const data = await sliceBase64(file, from, to);
      const sum = await chunkSha256(data);
      const res = await fetch(`/api/chat/upload/${encodeURIComponent(id)}/chunk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(sum ? { 'X-Chunk-SHA256': sum } : {}) },
        body: JSON.stringify({ idx, data }),
      });
      if (!res.ok) throw new Error(await say(res, `Файл не загружен (${res.status})`));
      idx++;
      onProgress?.(to / file.size);
    }
    const finish = () => fetch(`/api/chat/upload/${encodeURIComponent(id)}/done`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: idx }),
    });
    // Ответ мог потеряться: повтор безопасен — сервер на завершённый файл отвечает тем же успехом
    const done = await finish().catch(() => finish());
    if (!done.ok) throw new Error(await say(done, `Файл не загружен (${done.status})`));
    const d = await done.json();
    return { filePath: d.filePath, fileName: d.fileName, fileSize: d.fileSize };
  } catch (error) {
    // Брошенную загрузку стираем сразу: иначе до 500 МБ кусков висели бы до суточной уборки
    await fetch(`/api/chat/upload/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    throw error;
  }
}

export type DownloadResult =
  | { kind: 'saved'; path: string; name: string }
  | { kind: 'browser' }
  | { kind: 'error'; message: string };

/** Мост главного процесса; нет моста — окно в браузере */
function bridge(): { saveAttachment?: (url: string, name: string) => Promise<any>; reveal?: (path: string) => Promise<any> } | null {
  return (window as any).electron?.chat || null;
}

/** Скачать вложение: в программе — в «Загрузки», в браузере — обычным скачиванием */
export async function downloadChatFile(filePath: string, fileName: string): Promise<DownloadResult> {
  try {
    // Ссылку на несколько минут выдаёт сервер, и только участнику переписки
    const r = await fetch(`/api/chat/file-link?path=${encodeURIComponent(filePath)}`);
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok || !d.url) return { kind: 'error', message: d.error || 'Файл не найден.' };
    const url = `${SERVER_BASE_URL || window.location.origin}${d.url}`;
    const chat = bridge();
    if (chat?.saveAttachment) {
      const saved = await chat.saveAttachment(url, fileName);
      if (!saved?.ok) return { kind: 'error', message: saved?.error || 'Не удалось сохранить файл.' };
      return { kind: 'saved', path: String(saved.path), name: String(saved.name) };
    }
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.rel = 'noopener';
    document.body.appendChild(a); a.click();
    // Убираем не сразу: браузер читает атрибут download уже после клика
    setTimeout(() => a.remove(), 1000);
    return { kind: 'browser' };
  } catch (error: any) {
    return { kind: 'error', message: String(error?.message || 'Не удалось скачать файл.') };
  }
}

/** Показать сохранённый файл в папке; в браузере показывать нечего */
export async function revealDownload(path: string): Promise<string> {
  const result = await bridge()?.reveal?.(path);
  return result && result.ok === false ? String(result.error || 'Не удалось открыть папку.') : '';
}
