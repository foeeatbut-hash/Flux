/**
 * Чем открывается файл — и что это вообще за файл.
 *
 * Раньше решение было записано дважды — на столе и в Проводнике, — и они
 * успели разойтись: чертёж, открытый из Проводника, попадал в редактор
 * пометок, а тот же чертёж со стола — в предпросмотр сбоку. Списков
 * расширений при этом жило СЕМЬ: здесь, в разборе офисных файлов, в меню
 * «Редактировать копию», на сервере, в значках Проводника, в предпросмотре и
 * в типе для базы. Они расходились молча: `.xls` принимал один список и
 * отвергал другой, и человек видел это как «не все файлы открываются».
 *
 * Поэтому таблица расширений здесь одна, и все семь мест спрашивают её.
 *
 * Здесь только счёт, без React и без DOM. Программу, которой у нас нет, в
 * список дописывать нельзя — «Открыть с помощью» должен открывать, а не
 * обещать.
 */

/** Что известно о файле тем, кто спрашивает: столу и Проводнику */
export interface FileLike {
  id: string;
  name?: string;
  /** Тип из базы: CONSTRUCTOR, PDF, XLSX, DOCX, TXT, IMAGE, FILE */
  type?: string | null;
  /** Документ Flux Office: ссылка на сам документ, а не на файл */
  refId?: string | null;
  /**
   * Адрес зеркала документа: `/sheet/<id>` или `/doc/<id>`.
   *
   * По нему видно, ЧЕМ открывать документ, — таблицей или текстом. Без него
   * пришлось бы спрашивать сервер только затем, чтобы выбрать значок окна.
   */
  filePath?: string | null;
  /** Папка Проводника, в которой файл лежит */
  folderId?: string | null;
}

/**
 * Чем файл является по существу. Не то же, что расширение: `.xlsx` и `.csv` —
 * разные форматы, но обе таблицы, и открываются одной программой.
 */
export type FileFace = 'sheet' | 'text' | 'plain' | 'pdf' | 'image' | 'binary';

interface ExtDef {
  face: FileFace;
  /** Как называется тип в свойствах и в предпросмотре */
  label: string;
  /** Тип для колонки в базе. Значения историчны — менять их нельзя */
  dbType: string;
  /**
   * Умеем ли мы разобрать содержимое. `false` — файл виден, но открыть его
   * нечем: тогда обязателен совет, что с ним делать
   */
  open: boolean;
  /** Что сказать человеку, если разобрать нечем */
  advice?: string;
}

/**
 * Расширение → всё, что о нём надо знать.
 *
 * Старые форматы Word и Excel различаются судьбой: `.xls` (BIFF) читает та же
 * библиотека, что и `.xlsx`, поэтому он открывается; `.doc` — двоичный формат
 * OLE2, и его не читает ничто из того, что у нас есть. Врать про это нельзя:
 * человек должен получить совет, а не пустой лист.
 */
const BY_EXT: Record<string, ExtDef> = {
  xlsx: { face: 'sheet', label: 'Книга Excel', dbType: 'XLSX', open: true },
  xlsm: { face: 'sheet', label: 'Книга Excel с макросами', dbType: 'XLSX', open: true },
  xls: { face: 'sheet', label: 'Книга Excel (старый формат)', dbType: 'XLSX', open: true },
  csv: { face: 'sheet', label: 'Таблица CSV', dbType: 'TXT', open: true },

  docx: { face: 'text', label: 'Документ Word', dbType: 'DOCX', open: true },
  doc: {
    face: 'text', label: 'Документ Word (старый формат)', dbType: 'DOCX', open: false,
    advice: 'Формат .doc — старый. Откройте файл в Word и пересохраните как .docx.',
  },
  rtf: {
    face: 'text', label: 'Текст RTF', dbType: 'DOCX', open: false,
    advice: 'Формат .rtf не открывается. Откройте файл в Word и пересохраните как .docx.',
  },
  odt: {
    face: 'text', label: 'Документ OpenDocument', dbType: 'DOCX', open: false,
    advice: 'Формат .odt не открывается. Пересохраните файл как .docx.',
  },

  txt: { face: 'plain', label: 'Текстовый файл', dbType: 'TXT', open: true },
  md: { face: 'plain', label: 'Разметка Markdown', dbType: 'TXT', open: true },
  log: { face: 'plain', label: 'Журнал', dbType: 'TXT', open: true },
  json: { face: 'plain', label: 'Данные JSON', dbType: 'TXT', open: true },
  xml: { face: 'plain', label: 'Данные XML', dbType: 'TXT', open: true },

  pdf: { face: 'pdf', label: 'Документ PDF', dbType: 'PDF', open: true },

  png: { face: 'image', label: 'Изображение PNG', dbType: 'IMAGE', open: true },
  jpg: { face: 'image', label: 'Изображение JPEG', dbType: 'IMAGE', open: true },
  jpeg: { face: 'image', label: 'Изображение JPEG', dbType: 'IMAGE', open: true },
  gif: { face: 'image', label: 'Изображение GIF', dbType: 'IMAGE', open: true },
  webp: { face: 'image', label: 'Изображение WebP', dbType: 'IMAGE', open: true },
  bmp: { face: 'image', label: 'Изображение BMP', dbType: 'IMAGE', open: true },
  svg: { face: 'image', label: 'Векторный рисунок SVG', dbType: 'IMAGE', open: true },
};

/** Расширение файла в нижнем регистре, без точки. Без расширения — пустая строка */
export function extOf(name: string | null | undefined): string {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  return dot > 0 ? s.slice(dot + 1).toLowerCase() : '';
}

const defOf = (f: FileLike | string): ExtDef | undefined =>
  BY_EXT[extOf(typeof f === 'string' ? f : f.name)];

/** Чем файл является. Неизвестное расширение — двоичное «просто файл» */
export function faceOf(f: FileLike | string): FileFace {
  return defOf(f)?.face || 'binary';
}

/** Название типа для свойств: «Книга Excel», а не «XLSX» */
export function typeLabel(f: FileLike | string): string {
  const d = defOf(f);
  if (d) return d.label;
  const ext = extOf(typeof f === 'string' ? f : f.name);
  return ext ? `Файл .${ext}` : 'Файл';
}

/** Тип файла для базы — по расширению, а не по тому, что сказал браузер */
export function dbTypeOf(name: string): string {
  const d = BY_EXT[extOf(name)];
  if (d) return d.dbType;
  const ext = extOf(name);
  return ext ? ext.toUpperCase() : 'FILE';
}

/**
 * Совет для формата, который открыть нечем. Пустая строка — совета нет,
 * потому что формат открывается.
 */
export function legacyAdvice(name: string): string {
  const d = BY_EXT[extOf(name)];
  return d && !d.open ? (d.advice || '') : '';
}

export interface FileApp {
  id: string;
  /** Как называется в меню: «Открыть в Просмотре» */
  name: string;
  /** Раздел-программа: по нему находится значок и заголовок окна */
  path: (f: FileLike) => string;
  /** Адрес, которым программа открывает именно этот файл */
  href: (f: FileLike) => string;
}

const q = (v: string) => encodeURIComponent(v);

/**
 * Программа семьи для вида документа: DOC и TEMPLATE — таблица, TEXT и NOTE —
 * текст, TITLE (шаблон титула) — тоже таблица, он рисуется на листе.
 */
export const officePathForKind = (kind: string | null | undefined): string =>
  (kind === 'TEXT' || kind === 'NOTE') ? '/doc' : '/sheet';

/** Обратное: какой вид документа заводит программа по этому адресу */
export const officeKindForPath = (path: string): 'DOC' | 'TEXT' =>
  String(path || '').startsWith('/doc') ? 'TEXT' : 'DOC';

/** Путь программы Flux Office для этого документа: таблица или текст */
export const officePathOf = (f: FileLike): string =>
  String(f.filePath || '').startsWith('/doc/') ? '/doc' : '/sheet';

/** Какой программой семьи открывать принесённый файл — по его лицу */
export const officePathForName = (name: string): string =>
  faceOf(name) === 'sheet' ? '/sheet' : '/doc';

export const FILE_APPS: Record<string, FileApp> = {
  // Ключ не «constructor»: у любого объекта в JavaScript уже есть поле с таким
  // именем, и обращение к нему возвращает не программу, а функцию-конструктор
  docs: {
    id: 'docs', name: 'Flux Office',
    path: officePathOf,
    href: (f) => `${officePathOf(f)}?doc=${q(f.refId || f.id)}`,
  },
  pdf: {
    id: 'pdf', name: 'Просмотр',
    path: () => '/pdf',
    href: (f) => `/pdf?file=${q(f.id)}`,
  },
  // Офисный файл, ещё не ставший документом: Flux Office разберёт его при
  // открытии и запомнит связь, чтобы второе открытие вело в тот же документ,
  // а не в новую копию
  office: {
    id: 'office', name: 'Flux Office',
    path: (f) => officePathForName(f.name || ''),
    href: (f) => `${officePathForName(f.name || '')}?fromFile=${q(f.id)}`,
  },
  // Предпросмотр Проводника — тоже способ открыть: для картинки, бланка и
  // всего, для чего своего редактора нет, он и есть единственный
  explorer: {
    id: 'explorer', name: 'Проводник',
    path: () => '/explorer',
    href: (f) => (f.folderId
      ? `/explorer?file=${q(f.id)}&folder=${q(f.folderId)}`
      : `/explorer?file=${q(f.id)}`),
  },
  // Открыть тем, чем открывает Windows: для чертежей САПР, архивов и всего
  // прочего, чему у нас программы нет и не будет. Раньше такой файл упирался
  // в значок с подписью «Файл» — то есть в тупик
  windows: {
    id: 'windows', name: 'Программа Windows',
    path: () => '/explorer',
    href: (f) => `/explorer?open=${q(f.id)}`,
  },
};

/** ПДФ узнаём и по типу из базы, и по имени: старые записи типа не имеют */
export const isPdf = (f: FileLike): boolean =>
  f.type === 'PDF' || faceOf(f) === 'pdf';

/**
 * Книга Excel и документ Word открываются в Flux Office.
 *
 * Формат определяется по имени: тип в базе у файлов, загруженных прежними
 * версиями, бывает каким угодно. Старый `.doc` сюда не попадает — его нечем
 * разобрать, и вместо редактора человек получает совет.
 */
export const isOffice = (f: FileLike): boolean => {
  const d = defOf(f);
  return !!d && d.open && (d.face === 'sheet' || d.face === 'text');
};

/** Документ Flux Office — это ссылка на документ, а не файл на диске */
export const isConstructorDoc = (f: FileLike): boolean =>
  !!f.refId || f.type === 'CONSTRUCTOR';

/**
 * Чем можно открыть этот файл. Первая программа — по двойному нажатию,
 * остальные предлагаются в «Открыть с помощью».
 */
export function appsFor(f: FileLike): FileApp[] {
  if (isConstructorDoc(f)) return [FILE_APPS.docs];
  if (isPdf(f)) return [FILE_APPS.pdf, FILE_APPS.explorer];
  // Офисный файл открывается редактором, а не предпросмотром. Предпросмотр
  // остаётся вторым пунктом: иногда человеку нужно просто посмотреть
  if (isOffice(f)) return [FILE_APPS.office, FILE_APPS.explorer];
  // Картинку и текст показывает предпросмотр, и этого достаточно. Всё
  // остальное — чертёж САПР, архив, модель — отдаём Windows: у неё для этого
  // программа есть, а у нас нет
  const face = faceOf(f);
  if (face === 'image' || face === 'plain') return [FILE_APPS.explorer, FILE_APPS.windows];
  return [FILE_APPS.explorer, FILE_APPS.windows];
}

/** Адрес, по которому файл открывается сам собой — двойным нажатием */
export function openHref(f: FileLike): string {
  return appsFor(f)[0].href(f);
}

/** Есть ли из чего выбирать: без выбора пункт «Открыть с помощью» не нужен */
export const hasChoice = (f: FileLike): boolean => appsFor(f).length > 1;
