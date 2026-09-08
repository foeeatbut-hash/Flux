/**
 * «Выгрузить в Windows»: файл или документ ложится на диск человека.
 *
 * Одно место на всю программу, а не кнопка в каждом разделе. Выгрузка книги,
 * документа Word и обычного файла — одно и то же действие с точки зрения
 * человека, и вести себя оно обязано одинаково: спросить папку, положить файл,
 * сказать, куда положил.
 *
 * В программе открывается обычное окно сохранения Windows и, если известно,
 * откуда файл когда-то принесли, предлагается та же папка. В браузере окна
 * сохранения нет — там это обычное скачивание.
 */
import { buildDocx, partsFromText } from './docxWrite';
import { fileBytes } from './fileBytes';

export interface SaveResult {
  ok: boolean;
  /** Куда легло — это и говорится человеку */
  path: string;
  /** Человек передумал: это не ошибка и ругаться не надо */
  canceled: boolean;
  error: string;
}

const elec = (): any => (typeof window !== 'undefined' ? (window as any).electron : undefined);

/** base64 из байтов — без промежуточной строки на десятки мегабайт */
export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return btoa(bin);
}

/** Скачивание браузером — запасной путь там, где нет окна сохранения */
function downloadInBrowser(name: string, bytes: Uint8Array): SaveResult {
  try {
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    return { ok: true, path: name, canceled: false, error: '' };
  } catch (err: any) {
    return { ok: false, path: '', canceled: false, error: String(err?.message || err) };
  }
}

/** Положить байты на диск Windows */
export async function saveBytes(name: string, bytes: Uint8Array, dir = ''): Promise<SaveResult> {
  const e = elec();
  if (!e?.saveFileAs) return downloadInBrowser(name, bytes);
  const r = await e.saveFileAs({ name, base64: toBase64(bytes), dir });
  return {
    ok: !!r?.success,
    path: String(r?.filePath || ''),
    canceled: !!r?.canceled,
    error: String(r?.error || ''),
  };
}

/** Папка из полного пути файла: «C:\Users\И\Смета.xlsx» → «C:\Users\И» */
export function folderOf(fullPath: string): string {
  const p = String(fullPath || '');
  const at = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return at > 0 ? p.slice(0, at) : '';
}

/**
 * Файл Проводника как есть.
 *
 * Байты берутся общим путём (src/lib/fileBytes.ts): у файла, положенного
 * новой версией, содержимое лежит кусками, у старого — строкой, и знать об
 * этом различии должно одно место, а не каждый читатель. Запись файла нужна
 * отдельно — ради имени и того, откуда файл когда-то принесли.
 */
export async function saveFileNode(fileId: string): Promise<SaveResult> {
  const res = await fetch(`/api/files/${encodeURIComponent(fileId)}?meta=1`);
  if (!res.ok) return { ok: false, path: '', canceled: false, error: `Сервер ответил ${res.status}` };
  const d = await res.json();
  const file = d?.file;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fileBytes(fileId));
  } catch (e: any) {
    return { ok: false, path: '', canceled: false, error: String(e?.message || e) };
  }
  if (!bytes.length) {
    return {
      ok: false, path: '', canceled: false,
      error: 'У файла нет содержимого — выгружать нечего. Скорее всего, он был загружен старой версией программы.',
    };
  }
  return saveBytes(String(file?.name || 'Файл'), bytes, folderOf(String(file?.origin || '')));
}

/** Текстовый документ Flux → настоящий .docx на диске */
export async function saveTextDocAsWord(name: string, text: string, dir = ''): Promise<SaveResult> {
  const clean = name.replace(/\.[^.]+$/, '');
  return saveBytes(`${clean}.docx`, buildDocx(partsFromText(text)), dir);
}

/**
 * Открыть файл тем, чем его открывает Windows.
 *
 * Для чертежей САПР, архивов и моделей — всего, для чего своей программы у нас
 * нет. Раньше такой файл упирался в значок с подписью «Файл»: человек видел
 * его и не мог сделать ничего.
 *
 * Файл при этом остаётся в Flux, а Windows открывает его КОПИЮ во временной
 * папке: править её бессмысленно, и человеку об этом говорится сразу. Обещать
 * обратную запись мы не можем — Windows не сообщает, когда программа закрылась
 * и что она записала.
 */
export async function openInWindows(fileId: string, name: string): Promise<SaveResult> {
  const e = (window as any).electron;
  if (!e?.openFileExternally) {
    return { ok: false, path: '', canceled: false, error: 'Открыть программой Windows можно только в самой программе, а не в браузере' };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fileBytes(fileId));
  } catch (err: any) {
    return { ok: false, path: '', canceled: false, error: String(err?.message || err) };
  }
  if (!bytes.length) {
    return { ok: false, path: '', canceled: false, error: 'У файла нет содержимого — открывать нечего' };
  }
  const out = await e.openFileExternally({ name, base64: toBase64(bytes) });
  return out?.success
    ? { ok: true, path: String(out.filePath || ''), canceled: false, error: '' }
    : { ok: false, path: '', canceled: false, error: String(out?.error || 'Windows не смогла открыть этот файл') };
}

/**
 * То же, но сразу словами для человека: что сказать до и что после.
 *
 * Отдельно, потому что зовут это двое — стол и Проводник, — и говорить они
 * обязаны одинаково. Разные слова об одном и том же действии человек читает
 * как разные действия.
 */
export async function openInWindowsSaid(
  fileId: string,
  name: string,
  say: (text: string, kind: 'info' | 'error') => void,
): Promise<void> {
  say(`Открываю «${name}» программой Windows…`, 'info');
  const out = await openInWindows(fileId, name);
  say(
    out.ok ? 'Открыта копия во временной папке — правки в ней в Flux не вернутся' : (out.error || 'Не удалось открыть'),
    out.ok ? 'info' : 'error',
  );
}
