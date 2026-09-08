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
import { faceOf, isOffice, legacyAdvice } from './fileTypes';

export type OfficeKind = 'sheet' | 'text';

/**
 * Чем открывается офисный файл — и открывается ли вообще.
 *
 * Спрашивает общую таблицу расширений, а не держит свой список. Свой был, и он
 * разошёлся с остальными шестью: `.xls` принимало меню «Редактировать копию»,
 * а разбор при открытии отвергал — со стороны человека это выглядит как «файл
 * просто не открывается».
 */
export function officeKind(name: string): OfficeKind | null {
  if (!isOffice({ id: '', name })) return null;
  return faceOf(name) === 'sheet' ? 'sheet' : 'text';
}

/**
 * Формат, который разобрать нечем: `.doc`, `.rtf`, `.odt`. Вместо молчания
 * человек получает совет — текст берётся из той же таблицы расширений.
 */
export function oldFormatAdvice(name: string): string {
  return legacyAdvice(name);
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

/**
 * Книга Excel → снимок книги Flux Office.
 *
 * Переносятся значения, ФОРМУЛЫ и объединения ячеек. Формулы раньше терялись
 * молча: книга выглядела целой, но переставала считаться, и человек находил
 * это, когда правил исходные числа, а итог не менялся. Что не переносится —
 * оформление, ширины и картинки — сказано человеку строкой один раз.
 *
 * Возвращает и причину пустоты: пустой лист без объяснения выглядит как
 * поломка программы, а чаще значит «в книге нет данных» или «всё лежит
 * картинкой».
 */
export function sheetSnapshot(data: ArrayBuffer, name: string): { workbook: string; why: string } {
  const wb = XLSX.read(data, { type: 'array' });
  const sheets: any = {};
  const order: string[] = [];
  let filled = 0;
  wb.SheetNames.forEach((sn, i) => {
    const sheet = wb.Sheets[sn];
    const aoa = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, blankrows: true, defval: '' }) as any[][];
    const id = `s${i + 1}`;
    const cellData: any = {};
    let maxC = 0;
    aoa.forEach((row, r) => (row || []).forEach((v, c) => {
      if (v !== undefined && v !== null && v !== '') {
        const raw = sheet[XLSX.utils.encode_cell({ r, c })];
        // `f` — формула ячейки. Без неё книга приезжает посчитанной один раз и
        // навсегда: правишь исходные числа, а итог стоит на месте
        (cellData[r] ||= {})[c] = raw?.f ? { v, f: `=${raw.f}` } : { v };
        if (c > maxC) maxC = c;
        filled++;
      }
    }));
    sheets[id] = {
      id, name: sn || `Лист${i + 1}`, cellData,
      rowCount: Math.max(100, aoa.length + 30),
      columnCount: Math.max(26, maxC + 10),
      // Объединения держат шапку бланка: без них двухэтажный заголовок
      // рассыпается на отдельные ячейки, и таблицу не узнать
      ...(Array.isArray(sheet['!merges']) && sheet['!merges'].length
        ? { mergeData: sheet['!merges'].map((m: any) => ({
          startRow: m.s.r, endRow: m.e.r, startColumn: m.s.c, endColumn: m.e.c,
        })) }
        : {}),
    };
    order.push(id);
  });
  // Пустая книга — тоже книга: лист должен быть, иначе человек увидит пустоту
  // и не поймёт, ждать ему или нажимать
  if (!order.length) {
    sheets.s1 = { id: 's1', name: 'Лист1', cellData: {}, rowCount: 100, columnCount: 26 };
    order.push('s1');
  }
  return {
    workbook: JSON.stringify({ name, sheetOrder: order, sheets }),
    why: filled ? '' : 'В книге не нашлось заполненных ячеек. Так бывает, когда лист — это вставленная '
      + 'картинка: её содержимое Excel не хранит числами, и перенести его нечем.',
  };
}

/**
 * Документ Word → текст с абзацами, заголовками, таблицами и колонтитулами.
 *
 * Библиотека разбора отдаёт только основной поток документа. В бланках по
 * ГОСТ, в опросных листах и в заданиях половина содержимого лежит НЕ там: в
 * колонтитуле (штамп, шифр, лист), в надписи поверх страницы и в сносках.
 * Поэтому недостающее читается отдельно (src/import/docxParts.ts) и
 * дописывается в конец — вклинивать штамп в середину записки нельзя.
 *
 * Возвращает и причину пустоты: пустой ответ без объяснения человек читает как
 * «программа не умеет Word», а он чаще всего значит «в документе одни
 * картинки» или «текст в колонтитуле».
 */
export async function wordText(data: ArrayBuffer): Promise<{ text: string; why: string }> {
  const mammoth: any = await import('mammoth/mammoth.browser');
  const r = await mammoth.convertToHtml({ arrayBuffer: data });
  const { htmlToBlocks } = await import('../import/extractors');
  // Правило «повтор предыдущей ячейки — это перевод, а не данные» придумано
  // для двуязычных бланков оборудования. На обычной таблице с повторами оно
  // стирает содержимое, поэтому здесь выключено
  const blocks = htmlToBlocks(String(r?.value || ''), { dropRepeats: false });
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
  const body = lines.join('\n').trim();

  const { docxOuterText } = await import('../import/docxParts');
  const outer = await docxOuterText(data);
  const text = [body, outer.join('\n').trim()].filter(Boolean).join('\n\n');

  if (text) return { text, why: '' };
  return {
    text: '',
    why: 'В документе не нашлось текста. Так бывает, когда страницы — это отсканированные '
      + 'картинки: тогда откройте «Оборудование» → «Импорт из документов», там есть распознавание.',
  };
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
  let empty = '';
  if (kind === 'sheet') {
    const out = sheetSnapshot(data, baseName);
    body.kind = 'DOC';
    body.workbook = out.workbook;
    empty = out.why;
  } else {
    const out = await wordText(data);
    body.kind = 'TEXT';
    body.importText = out.text;
    empty = out.why;
  }
  // Пустой разбор больше не проваливается в серверную ветку, где отвечал
  // «разбор недоступен в этой сборке». Человек читает НАСТОЯЩУЮ причину
  if (empty) throw new Error(empty);

  const res = await fetch('/api/constructor/docs/import-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d?.error || `Сервер ответил ${res.status}`);
  return { docId: String(d?.doc?.id || ''), kind, note: kind === 'text' ? WORD_NOTE : '' };
}
