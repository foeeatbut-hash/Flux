// Единая промежуточная модель импорта документов.
// Все извлекатели (Excel/Word/PDF/XML/буфер обмена) приводят документ к этим блокам,
// а распознавание (recognize.ts) работает только с ними и не знает исходный формат.

export type DocBlockKind = 'para' | 'table' | 'kv';

export interface DocParagraph {
  kind: 'para';
  text: string;
  page?: number;
}

export interface DocTable {
  kind: 'table';
  rows: string[][];
  page?: number;
}

// Готовая пара «ключ → значение» (например, из атрибутов XML)
export interface DocKeyValue {
  kind: 'kv';
  key: string;
  value: string;
  page?: number;
}

export type DocBlock = DocParagraph | DocTable | DocKeyValue;

export type DocSourceKind = 'xlsx' | 'docx' | 'pdf' | 'pdf-ocr' | 'xml' | 'clipboard';

export interface ExtractedDoc {
  blocks: DocBlock[];
  source: DocSourceKind;
  warnings: string[];
  /** Число страниц-сканов, которые прошли через OCR (для пометки уверенности) */
  ocrPages?: number;
}

// ── Результат распознавания (черновик для предпросмотра) ────────────────────

export type Confidence = 'high' | 'mid' | 'low';

export interface DraftField {
  /** id поля словаря; отсутствует, если подпись не сопоставлена (сырой параметр) */
  fieldId?: string;
  /** Подпись из документа (как её увидел пользователь) */
  label: string;
  value: string;
  unit?: string;
  /** Группа характеристик для дерева оборудования */
  group: string;
  confidence: Confidence;
  source: 'table' | 'prose' | 'kv' | 'ocr';
}

export interface DraftItem {
  id: string;
  /** Человеческое название позиции («Вентилятор осевой ОСА-ЭВО-5,6») */
  title: string;
  /** Код/тег позиции, если найден */
  name: string;
  brand?: string;
  system?: string;
  qty?: string;
  /** Тип оборудования: fan | valve | ahu | curtain | heater | filter | ... */
  equipType: string;
  /**
   * Технологические позиции (теги) этой единицы оборудования. В бланке их
   * бывает несколько: один лист на пять одинаковых вентиляторов, у каждого
   * свой тег. Дальше их разбирает план импорта — привязать или создать.
   */
  tags?: string[];
  /**
   * Номер раздела бланка: «1», «1.2», «3.1». В листе технических данных
   * установки нумерация — это её устройство: «1.» — моноблок, «1.2.» — блок
   * внутри него. По ней и строится дерево, а не по одному общему «M1».
   */
  section?: string;
  /** Позиция пришла строкой ведомости: своя личность, чужой маркой не дополняется */
  fromRow?: boolean;
  fields: DraftField[];
  /** Для матричных таблиц: варианты колонок-типоразмеров, если выбор не однозначен */
  matrixHeaders?: string[];
  /** Сырые строки матричной таблицы — чтобы при выборе колонки подставить её значения */
  matrixRaw?: string[][];
}

export type DocType =
  | 'card'          // карточка одного изделия
  | 'list'          // ведомость/спецификация: строки = позиции
  | 'questionnaire' // опросный лист
  | 'multi'         // многосекционный бланк (установка с секциями)
  | 'unknown';

// Наблюдение для авто-обучения: нормализованная подпись из документа → поле словаря.
// Распознаватель эмитит их сам; клиент молча отправляет в общий словарь на сервере.
export interface LearnObservation {
  label: string;   // уже нормализованная подпись (normalizeLabel)
  field: string;   // id поля словаря (FieldDef.id)
  unit?: string;
}

export interface DraftResult {
  docType: DocType;
  items: DraftItem[];
  warnings: string[];
  /** Сколько блоков документа было отнесено к данным / всего */
  stats: { dataBlocks: number; totalBlocks: number };
  /** Подписи, распознанные уверенно — для авто-пополнения словаря синонимов */
  observations?: LearnObservation[];
}

// ── Payload подтверждённого импорта (совпадает с серверной моделью) ─────────

export interface CommitSpecParam { key: string; value: string; unit: string; }
export interface CommitSpecGroup { title: string; params: CommitSpecParam[]; }
export interface CommitBlock { name: string; title: string; equipType: string; groups: CommitSpecGroup[]; tags?: string[]; }
export interface CommitMonoblock { name: string; title: string; blocks: CommitBlock[]; }
export interface CommitUnit { name: string; title: string; groups: CommitSpecGroup[]; monoblocks: CommitMonoblock[]; tags?: string[]; }
