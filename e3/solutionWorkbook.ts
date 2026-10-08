/**
 * Выгрузка каталога типовых решений в Excel — того же вида, что файл владельца
 * («Классификатор типовых решений», «Обозначения» и «Таблица IO»), плюс по столбцу на каждый
 * признак и столбец «Признаки подтверждены». Таблицу можно отдать ВЕЗА или
 * открыть без Flux; загруженная обратно, она не нуждается в разборе названий:
 * заголовок признака кончается его id в квадратных скобках.
 *
 * Модуль чистый: строки считаются отдельно от записи книги, чтобы проверять их
 * без файла.
 */
import * as XLSX from 'xlsx';
import { IO_SHEET, ioSheetRows } from './ioTable';
import type { E3Feature, E3SolutionBook } from './solutionTypes';

export const CLASSIFIER_SHEET = 'Классификатор типовых решений';
export const DICTIONARY_SHEET = 'Обозначения';

/** Заголовки в том виде, как они стоят в файле владельца */
export const CLASSIFIER_HEADERS = [
  'Уникальный ID типового решения', 'Основной класс', 'Класс', 'Краткое обозначение', 'Название схемы', 'Описание схемы',
  'Ссылка на описание схемы (PDF) //другой лист', 'Ссылка на оригинал (.e3p)', 'Двухуровневая схема', 'Есть в САПР',
  'Список изделий\n(пока без ЧП, кабелей, коробок и клемм)', 'Список символов в Блоке', 'Пояснение',
];

export const featureHeader = (f: E3Feature): string => `${f.title} (${f.mainClass}) [${f.id}]`;

/** Столбцы признаков идут в порядке книги; в строке решения заполнены только признаки его класса */
export function solutionRows(book: Pick<E3SolutionBook, 'solutions' | 'features'>): string[][] {
  const feats = book.features || [];
  const rows: string[][] = [[...CLASSIFIER_HEADERS, ...feats.map(featureHeader), 'Признаки подтверждены']];
  for (const s of book.solutions || []) {
    if (s.removed) continue;
    rows.push([
      s.id, s.mainClass, s.subclass, s.short, s.name, s.description, s.pdf, s.e3p, s.twoLevel ? 'Да' : 'Нет', s.inCad ? 'Да' : '',
      s.items, s.symbols, s.note,
      ...feats.map((f) => (f.mainClass === s.mainClass ? s.features?.[f.id] ?? '' : '')),
      s.featuresConfirmed ? 'Да' : '',
    ]);
  }
  return rows;
}

export const dictionaryRows = (dictionary: Record<string, string>): string[][] => [
  ['Обозначение в классификаторе', 'Краткое описание'], ...Object.entries(dictionary || {}).map(([code, d]) => [code, d]),
];

export function solutionWorkbook(book: E3SolutionBook): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const main = XLSX.utils.aoa_to_sheet(solutionRows(book));
  main['!cols'] = [{ wch: 12 }, { wch: 18 }, { wch: 36 }, { wch: 14 }, { wch: 34 }, { wch: 48 }];
  XLSX.utils.book_append_sheet(wb, main, CLASSIFIER_SHEET);
  const dict = XLSX.utils.aoa_to_sheet(dictionaryRows(book.dictionary));
  dict['!cols'] = [{ wch: 16 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, dict, DICTIONARY_SHEET);
  // Таблица IO — того же вида, что у владельца; имя изделия E3 в файл не идёт: его ведёт только каталог
  if ((book.ioTable || []).length) {
    const io = XLSX.utils.aoa_to_sheet(ioSheetRows(book.ioTable));
    io['!cols'] = [{ wch: 2 }, { wch: 22 }, { wch: 52 }, { wch: 14 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 2 }, { wch: 28 }, { wch: 28 }, { wch: 28 }, { wch: 28 }];
    XLSX.utils.book_append_sheet(wb, io, IO_SHEET);
  }
  return wb;
}

export const solutionWorkbookBytes = (book: E3SolutionBook): ArrayBuffer => XLSX.write(solutionWorkbook(book), { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
