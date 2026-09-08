/**
 * Открытие файлов Word и Excel внутри программы.
 *
 * Разбор делается ЗДЕСЬ, в окне, а не на сервере, и это не вкусовщина.
 * Серверная ветка «открыть docx» звала библиотеку разбора, записанную в
 * зависимости для разработки. Сервер собирается так, что берёт библиотеки из
 * папки зависимостей во время работы, а в собранную программу кладутся только
 * рабочие зависимости — библиотек для разработки там нет. Значит, у сотрудника
 * эта ветка отвечала «разбор недоступен в этой сборке» ВСЕГДА, а у
 * разработчика работала: поломка не показывалась тому, кто её сделал.
 *
 * В окне такого расхождения быть не может: сборщик окна вкладывает библиотеки
 * прямо в файл сборки. Поэтому сервер в открытии больше не участвует — он
 * отдаёт байты, остальное делает окно.
 *
 * Что получается на выходе: книга Excel → таблица Конструктора, документ Word →
 * текстовый документ. Сложное оформление Word при этом не сохраняется — об этом
 * человеку говорится прямо, один раз, в момент открытия.
 */
import * as XLSX from 'xlsx';
import { fileBytes } from './fileBytes';

export type OfficeKind = 'sheet' | 'text';

/** Чем открывается офисный файл — и открывается ли вообще */
export function officeKind(name: string): OfficeKind | null {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  if (['xlsx', 'xlsm', 'csv'].includes(ext)) return 'sheet';
  if (ext === 'docx') return 'text';
  return null;
}

/**
 * Старые форматы Word и Excel. Их разбор требует чужой библиотеки, а
 * встречаются они всё реже — поэтому вместо молчания человек получает совет.
 */
export function oldFormatAdvice(name: string): string {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  if (ext === 'doc') return 'Формат .doc — старый. Откройте файл в Word и пересохраните как .docx.';
  if (ext === 'xls') return 'Формат .xls — старый. Откройте файл в Excel и пересохраните как .xlsx.';
  return '';
}

/** Что человеку стоит знать про открытый документ Word — сказать один раз */
export const WORD_NOTE = 'Документ Word открыт текстом: заголовки, списки и таблицы на месте, '
  + 'сложное оформление (колонки, врезки, поля) не переносится.';

/** Байты файла из Проводника — общим путём (src/lib/fileBytes.ts) */
async function bytesOf(fileId: string): Promise<ArrayBuffer> {
  const data = await fileBytes(fileId);
  if (!data.byteLength) {
    throw new Error('У файла нет содержимого. Скорее всего, он был загружен старой версией программы — перенесите его заново.');
  }
  return data;
}

/** Книга Excel → снимок книги Конструктора (значения ячеек) */
export function sheetSnapshot(data: ArrayBuffer, name: string): string {
  const wb = XLSX.read(data, { type: 'array' });
  const sheets: any = {};
  const order: string[] = [];
  wb.SheetNames.forEach((sn, i) => {
    const aoa = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sn], { header: 1, blankrows: true, defval: '' }) as any[][];
    const id = `s${i + 1}`;
    const cellData: any = {};
    let maxC = 0;
    aoa.forEach((row, r) => (row || []).forEach((v, c) => {
      if (v !== undefined && v !== null && v !== '') {
        (cellData[r] ||= {})[c] = { v };
        if (c > maxC) maxC = c;
      }
    }));
    sheets[id] = {
      id, name: sn || `Лист${i + 1}`, cellData,
      rowCount: Math.max(100, aoa.length + 30),
      columnCount: Math.max(26, maxC + 10),
    };
    order.push(id);
  });
  // Пустая книга — тоже книга: лист должен быть, иначе человек увидит пустоту
  // и не поймёт, ждать ему или нажимать
  if (!order.length) {
    sheets.s1 = { id: 's1', name: 'Лист1', cellData: {}, rowCount: 100, columnCount: 26 };
    order.push('s1');
  }
  return JSON.stringify({ name, sheetOrder: order, sheets });
}

/** Документ Word → текст с сохранением абзацев, заголовков и таблиц */
export async function wordText(data: ArrayBuffer): Promise<string> {
  const mammoth: any = await import('mammoth/mammoth.browser');
  const r = await mammoth.convertToHtml({ arrayBuffer: data });
  const { htmlToBlocks } = await import('../import/extractors');
  const blocks = htmlToBlocks(String(r?.value || ''));
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'table') {
      // Таблица без своего движка — строками через табуляцию: так её и видно,
      // и можно перенести в таблицу целиком
      for (const row of (b as any).rows || []) lines.push(row.join('\t'));
      lines.push('');
    } else if ((b as any).text) {
      lines.push(String((b as any).text));
    }
  }
  return lines.join('\n').trim();
}

export interface OpenedOffice {
  docId: string;
  kind: OfficeKind;
  /** Что сказать человеку сразу после открытия; пустая строка — ничего */
  note: string;
}

/**
 * Открыть офисный файл: разобрать в окне и завести документ Конструктора,
 * навсегда связанный с этим файлом.
 *
 * Связь важнее, чем кажется. Без неё каждое открытие заводило бы новую копию, и
 * правки, сделанные вчера, человек бы не нашёл: он открыл бы «тот же файл» и
 * увидел исходник.
 */
export async function openOfficeFile(fileId: string, fileName: string, projectId: string): Promise<OpenedOffice> {
  const kind = officeKind(fileName);
  if (!kind) {
    const advice = oldFormatAdvice(fileName);
    throw new Error(advice || `Формат этого файла в Flux Office не открывается`);
  }
  const data = await bytesOf(fileId);
  const baseName = fileName.replace(/\.[^.]+$/, '');

  const body: any = { fileId, projectId, name: baseName };
  if (kind === 'sheet') {
    body.kind = 'DOC';
    body.workbook = sheetSnapshot(data, baseName);
  } else {
    body.kind = 'TEXT';
    body.importText = await wordText(data);
  }

  const res = await fetch('/api/constructor/docs/import-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d?.error || `Сервер ответил ${res.status}`);
  return { docId: String(d?.doc?.id || ''), kind, note: kind === 'text' ? WORD_NOTE : '' };
}
