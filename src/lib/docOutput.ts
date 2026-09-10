/**
 * Документ Flux → файл, который открывают в Windows.
 *
 * Сборка вынесена из экрана редактора: экран решает, ЧТО выгружать и куда, а
 * как именно текст превращается в `.docx` — знание отдельное, и его проверяют
 * отдельно (scripts/test-docx.ts). Раньше это лежало в самом редакторе, и
 * дефекты вроде «в файл уехала таблица стилей» находились у получателя.
 *
 * Здесь нет ни React, ни хранилищ: только разметка, байты и один запрос к
 * серверу (см. flux-architecture).
 */
import { buildDocx, partsFromHtml } from './docxWrite';
import { pageOf, ptToMm } from './docExport';

/**
 * Плоский текст документа из снимка — для выгрузки TXT и для поиска.
 *
 * `\r` — конец абзаца, `\n` — конец секции; служебные маркеры объектов
 * отсекаем, иначе в текстовом файле оказываются управляющие знаки.
 */
export function snapshotToPlainText(snap: any): string {
  const ds: string = snap?.body?.dataStream || '';
  return ds.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/\r/g, '\n').replace(/\n+$/, '');
}

/**
 * Отдать файл человеку.
 *
 * Ссылку обязательно кладём в страницу: у ссылки вне документа браузер
 * игнорирует атрибут download и сохраняет файл как «download» — без имени и без
 * расширения, Ворд такой файл не открывает.
 */
export function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}

/** Текст документа файлом на диск. */
export function saveText(text: string, fileName: string): void {
  download(new Blob([text], { type: 'text/plain;charset=utf-8' }), fileName);
}

/** Текст документа в общий Проводник — чтобы отдать коллеге, не пересылая почтой. */
export async function textToExplorer(text: string, fileName: string, userId: string | null): Promise<void> {
  const b64 = btoa(unescape(encodeURIComponent(text)));
  const res = await fetch('/api/files', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: fileName, filePath: `/shared/${fileName}`, type: 'TXT',
      size: text.length, content: b64, createdById: userId,
    }),
  });
  if (!res.ok) throw new Error('files failed');
}

/**
 * Готовый `.docx` из разметки документа.
 *
 * Лист берётся из самого документа: альбомный лист и поля по ГОСТ, которые
 * человек выставил в «Параметрах листа», до этого до файла не доезжали —
 * выгрузка всегда отдавала A4 книжной с полями по 2 см.
 */
export async function wordBytes(html: string, snapshot: any): Promise<Uint8Array> {
  const { htmlToBlocks } = await import('../import/extractors');
  const parts = partsFromHtml(html, (fragment) => {
    const found = htmlToBlocks(fragment).find((b: any) => b.kind === 'table') as any;
    return found?.rows || [];
  });
  const g = pageOf(snapshot);
  return buildDocx(parts, {
    widthMm: ptToMm(g.widthPt), heightMm: ptToMm(g.heightPt),
    topMm: ptToMm(g.top), rightMm: ptToMm(g.right),
    bottomMm: ptToMm(g.bottom), leftMm: ptToMm(g.left),
  });
}

/** Байты в base64 кусками: строка целиком на большом документе рвёт стек */
function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * Тот же файл, но в общий Проводник — отдать коллеге, не пересылая почтой.
 *
 * Кладётся именно `.docx`, а не страница с расширением `.doc`: коллега берёт
 * из Проводника ровно то же, что получатель получил бы почтой. Пока здесь
 * лежал HTML, два пути выгрузки давали два разных файла с одним именем.
 */
export async function wordToExplorer(bytes: Uint8Array, fileName: string, userId: string | null): Promise<void> {
  const res = await fetch('/api/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Тип как у загруженных вордовских файлов Проводника — один значок
      name: fileName, filePath: `/shared/${fileName}`, type: 'DOCX',
      size: bytes.length, content: toBase64(bytes), createdById: userId,
    }),
  });
  if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
}
