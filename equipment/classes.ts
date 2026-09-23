/**
 * Типы оборудования: что это за изделие — и какого оно вида.
 *
 * Владелец просил дословно: «сделать сортировку по типам оборудования каждой
 * позиции… радиальный и канальный вентиляторы — это всё вентиляторы». Отсюда
 * два уровня, и оба нужны:
 *
 *   — **тип** (класс) отвечает «что это»: вентилятор, привод, фильтр. По нему
 *     группируется список позиций, настраивается вид карточки и режется
 *     выгрузка;
 *   — **вид** уточняет внутри типа: радиальный со свободным колесом или
 *     канальный, привод с возвратной пружиной или без, фильтр карманный G4.
 *
 * Роль (`equipment/roles.ts`) — это МЕСТО в составе, а тип — ЧТО стоит на этом
 * месте. У подпозиций они совпадают: у привода роль ПРИВОД, и тип тоже
 * «Привод». Расходятся они у блоков: роль у любого блока БЛОК, а тип — то, что
 * блок собой представляет. Блок «Вентилятор ВСК», внутри которого стоят два
 * тегированных вентилятора, — это секция, корпус; тип «Вентилятор» у него
 * задвоил бы вентиляторы в каждом списке.
 *
 * Правила угадывания проверены на настоящих выгрузках ВЕЗА: «ВОСК» — радиальный
 * со свободным колесом, «ВНВ» — жидкостный нагреватель, «ВОФ» — фреоновый
 * охладитель, SF… — привод с пружиной, SM… — без. Угадывание — подсказка, а не
 * приговор: человек поправляет тип и вид в карточке, и поправка сильнее правил.
 *
 * Модуль общий и чистый: его читают сервер (каталог Таблицы, отбор строк),
 * окно (дерево, список, вид категории, выгрузка) и проверки.
 */

export type ClassId =
  | 'УСТАНОВКА' | 'МОНОБЛОК' | 'СЕКЦИЯ'
  | 'ВЕНТИЛЯТОР' | 'ДВИГАТЕЛЬ' | 'КЛАПАН' | 'ПРИВОД' | 'КОРОБКА' | 'ФИЛЬТР'
  | 'НАГРЕВАТЕЛЬ' | 'ТЭН' | 'ОХЛАДИТЕЛЬ' | 'УВЛАЖНИТЕЛЬ' | 'РЕКУПЕРАТОР' | 'ШУМОГЛУШИТЕЛЬ'
  | 'ОБВЯЗКА' | 'НАСОС' | 'ДАТЧИК' | 'ЗАВЕСА' | 'ОСНАЩЕНИЕ' | 'ПРОЧЕЕ';

export interface ClassDef {
  id: ClassId;
  title: string;
  /** Во множественном числе — так подписана группа в списке */
  plural: string;
  /** Известные виды — подсказка при ручной поправке; свой вид вписать можно */
  kinds: string[];
}

/** Порядок — по ходу работы с установкой: сначала целое, потом основное, потом мелочь */
export const CLASSES: ClassDef[] = [
  { id: 'УСТАНОВКА', title: 'Установка', plural: 'Установки', kinds: [] },
  { id: 'МОНОБЛОК', title: 'Моноблок', plural: 'Моноблоки', kinds: [] },
  { id: 'СЕКЦИЯ', title: 'Секция', plural: 'Секции', kinds: ['Воздухоприёмная', 'Камера', 'Вентиляторная'] },
  { id: 'ВЕНТИЛЯТОР', title: 'Вентилятор', plural: 'Вентиляторы',
    kinds: ['Радиальный, свободное колесо', 'Радиальный', 'Канальный', 'Осевой', 'Крышный'] },
  { id: 'ДВИГАТЕЛЬ', title: 'Двигатель', plural: 'Двигатели', kinds: ['Асинхронный', 'EC'] },
  { id: 'КЛАПАН', title: 'Клапан', plural: 'Клапаны', kinds: ['Воздушный', 'С подогревом', 'Обратный', 'Противопожарный'] },
  { id: 'ПРИВОД', title: 'Привод', plural: 'Приводы', kinds: ['С возвратной пружиной', 'Без пружины'] },
  { id: 'КОРОБКА', title: 'Клеммная коробка', plural: 'Клеммные коробки', kinds: [] },
  { id: 'ФИЛЬТР', title: 'Фильтр', plural: 'Фильтры', kinds: ['Карманный', 'Панельный', 'Компактный', 'HEPA'] },
  { id: 'НАГРЕВАТЕЛЬ', title: 'Нагреватель', plural: 'Нагреватели', kinds: ['Жидкостный', 'Электрический', 'Паровой'] },
  { id: 'ТЭН', title: 'ТЭН', plural: 'ТЭНы', kinds: [] },
  { id: 'ОХЛАДИТЕЛЬ', title: 'Охладитель', plural: 'Охладители', kinds: ['Фреоновый', 'Водяной'] },
  { id: 'УВЛАЖНИТЕЛЬ', title: 'Увлажнитель', plural: 'Увлажнители', kinds: ['Паровой', 'Сотовый', 'Форсуночный'] },
  { id: 'РЕКУПЕРАТОР', title: 'Рекуператор', plural: 'Рекуператоры',
    kinds: ['Роторный', 'Пластинчатый', 'С промежуточным теплоносителем'] },
  { id: 'ШУМОГЛУШИТЕЛЬ', title: 'Шумоглушитель', plural: 'Шумоглушители', kinds: ['Пластинчатый', 'Трубчатый'] },
  { id: 'ОБВЯЗКА', title: 'Узел обвязки', plural: 'Узлы обвязки', kinds: [] },
  { id: 'НАСОС', title: 'Насос', plural: 'Насосы', kinds: ['Циркуляционный'] },
  { id: 'ДАТЧИК', title: 'Датчик', plural: 'Датчики',
    kinds: ['Реле перепада давления', 'Термостат защиты от замораживания', 'ПТС', 'Температуры', 'Давления'] },
  { id: 'ЗАВЕСА', title: 'Воздушная завеса', plural: 'Воздушные завесы', kinds: ['С водяным нагревом', 'С электронагревом', 'Без нагрева'] },
  { id: 'ОСНАЩЕНИЕ', title: 'Оснащение', plural: 'Оснащение',
    kinds: ['Светильник с выключателем', 'Сервисный выключатель', 'Лючок замера'] },
  { id: 'ПРОЧЕЕ', title: 'Прочее', plural: 'Прочее', kinds: [] },
];

const BY_ID = new Map<string, ClassDef>(CLASSES.map((c) => [c.id, c]));
const LAST = CLASSES[CLASSES.length - 1];

export const classById = (id: string): ClassDef => BY_ID.get(String(id || '')) || LAST;
export const classTitle = (id: string): string => classById(id).title;
export const isClassId = (id: string): id is ClassId => BY_ID.has(String(id || ''));
/** Место типа в списке: по нему группы идут в одном порядке во всех окнах */
export const classOrder = (id: string): number => {
  const i = CLASSES.findIndex((c) => c.id === id);
  return i < 0 ? CLASSES.length : i;
};

/** Позиция так, как её знают и сервер, и окно */
export interface Classifiable {
  id?: string;
  itemCode?: string;
  name?: string;
  equipType?: string;
  role?: string;
  sourceKind?: string | null;
  specs?: unknown;
  tags?: { identifier: string }[];
  parentElementId?: string | null;
  /** Ручная поправка типа; пусто — угадывать */
  equipClass?: string | null;
  /** Ручная поправка вида; пусто — угадывать */
  equipKind?: string | null;
}

// Тип блока — по типу, угаданному из названия секции при разборе
const BLOCK_CLASS: Record<string, ClassId> = {
  ВЕНТИЛЯТОР: 'ВЕНТИЛЯТОР', КЛАПАН: 'КЛАПАН', ФИЛЬТР: 'ФИЛЬТР', НАГРЕВАТЕЛЬ: 'НАГРЕВАТЕЛЬ',
  ОХЛАДИТЕЛЬ: 'ОХЛАДИТЕЛЬ', УВЛАЖНИТЕЛЬ: 'УВЛАЖНИТЕЛЬ', РЕКУПЕРАТОР: 'РЕКУПЕРАТОР',
  ШУМОГЛУШИТЕЛЬ: 'ШУМОГЛУШИТЕЛЬ', ЗАВЕСА: 'ЗАВЕСА',
  ВОЗДУХОПРИЁМНЫЙ: 'СЕКЦИЯ', КАМЕРА: 'СЕКЦИЯ', СЕКЦИЯ: 'СЕКЦИЯ', МОНОБЛОК: 'МОНОБЛОК',
};

/** Разобранные характеристики: из строки базы или уже объектом */
function groupsOf(specs: unknown): { title: string; params: { key: string; value: string }[] }[] {
  let s: any = specs;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch (_) { return []; } }
  const groups = Array.isArray(s?.groups) ? s.groups : [];
  return groups.map((g: any) => ({
    title: String(g?.title || ''),
    params: (Array.isArray(g?.params) ? g.params : []).map((p: any) => ({ key: String(p?.key || ''), value: String(p?.value ?? '') })),
  }));
}

/** Значение параметра по ключу — в любом разделе карточки */
function paramOf(p: Classifiable, key: RegExp): string {
  for (const g of groupsOf(p.specs)) for (const x of g.params) if (key.test(x.key) && x.value.trim()) return x.value.trim();
  return '';
}

/**
 * Текст, по которому угадывается вид: название, вид узла выгрузки и значения
 * характеристик. Ключи не берутся: «Электропривод» стоит ключом и у клапана с
 * подогревом, и у жидкостного нагревателя с обвязкой.
 */
function haystack(p: Classifiable): string {
  const parts = [p.name || '', p.sourceKind || ''];
  for (const g of groupsOf(p.specs)) for (const x of g.params) parts.push(x.value);
  return parts.join(' ').slice(0, 4000);
}

/**
 * Тип позиции.
 *
 * `shell` — у блока нет своего тега, а внутри стоит позиция того же типа: это
 * корпус, секция. Считает его вызывающий (`classifyAll`), потому что для этого
 * нужны соседи, а не одна позиция.
 */
export function classOf(p: Classifiable, opts: { shell?: boolean } = {}): ClassId {
  const manual = String(p.equipClass || '').trim();
  if (manual && isClassId(manual)) return manual;
  const code = String(p.itemCode || '');
  if (code === '__unit__') return 'УСТАНОВКА';
  if (code.endsWith('_общие')) return 'МОНОБЛОК';
  const role = String(p.role || 'БЛОК');
  if (role !== 'БЛОК') return isClassId(role) ? role : 'ПРОЧЕЕ';
  if (opts.shell) return 'СЕКЦИЯ';
  return BLOCK_CLASS[String(p.equipType || '').toUpperCase()] || 'ПРОЧЕЕ';
}

type Rule = [RegExp, string];

// Правила — по порядку, первое совпадение и есть вид. Порядок значим: у
// жидкостного нагревателя с обвязкой где-нибудь в значениях встречается
// «электро…», и проверка на электрический раньше жидкостного дала бы враньё
const KIND_RULES: Partial<Record<ClassId, Rule[]>> = {
  ВЕНТИЛЯТОР: [
    [/ВОСК|ВСК|свободн\S*\s+колес|FanFree|plug/iu, 'Радиальный, свободное колесо'],
    [/канальн|ВКК|КВАРК|duct/iu, 'Канальный'],
    [/крышн|ВКР|roof/iu, 'Крышный'],
    [/осев|(?<!\p{L})ВО-\d|axial/iu, 'Осевой'],
    [/радиальн|(?<!\p{L})ВР-|(?<!\p{L})ВЦ|улитк|центробеж/iu, 'Радиальный'],
  ],
  ДВИГАТЕЛЬ: [
    [/\bEC\b|ЕС-двиг|электронно-коммут/iu, 'EC'],
    [/(?<!\p{L})А?ИР\d|(?<!\p{L})АИР|(?<!\p{L})АДМ|асинхр/iu, 'Асинхронный'],
  ],
  КЛАПАН: [
    [/огнезадерж|противопожар|(?<!\p{L})КЛОП|(?<!\p{L})КПУ/iu, 'Противопожарный'],
    [/обратн/iu, 'Обратный'],
  ],
  НАГРЕВАТЕЛЬ: [
    [/жидкост|водян|(?<!\p{L})ВНВ|гликол/iu, 'Жидкостный'],
    [/электр|ElHeat|(?<!\p{L})ВНЭ|(?<!\p{L})ЭКО/iu, 'Электрический'],
    [/паров|(?<!\p{L})пар(?!\p{L})/iu, 'Паровой'],
  ],
  ОХЛАДИТЕЛЬ: [
    [/фреон|непосредствен|(?<!\p{L})ВОФ|FrCooler|\bDX\b|\bR4\d\d/iu, 'Фреоновый'],
    [/водян|жидкост|(?<!\p{L})ВОВ|гликол|WCooler/iu, 'Водяной'],
  ],
  РЕКУПЕРАТОР: [
    [/ротор/iu, 'Роторный'],
    [/пластин/iu, 'Пластинчатый'],
    [/гликол|промежуточн/iu, 'С промежуточным теплоносителем'],
  ],
  УВЛАЖНИТЕЛЬ: [[/паров|(?<!\p{L})пар(?!\p{L})/iu, 'Паровой'], [/сотов/iu, 'Сотовый'], [/форсун|распыл/iu, 'Форсуночный']],
  ШУМОГЛУШИТЕЛЬ: [[/пластин/iu, 'Пластинчатый'], [/трубчат|круглый/iu, 'Трубчатый']],
  ДАТЧИК: [
    [/птс|позистор|термистор|\bPTC\b/iu, 'ПТС'],
    [/перепад|\bDPS|реле\s+давлен/iu, 'Реле перепада давления'],
    [/термостат|заморож|заморажив/iu, 'Термостат защиты от замораживания'],
    [/температур/iu, 'Температуры'],
    [/давлен/iu, 'Давления'],
  ],
  НАСОС: [[/циркул/iu, 'Циркуляционный']],
  ЗАВЕСА: [[/электр/iu, 'С электронагревом'], [/водян|жидкост/iu, 'С водяным нагревом'], [/без\s+нагрев/iu, 'Без нагрева']],
};

// Оснащение узнаётся по виду узла выгрузки, а не по словам: названий у него нет
const OUTFIT_KINDS: Record<string, string> = {
  cadLightSwitchKit: 'Светильник с выключателем',
  cadServiceSwitchKit: 'Сервисный выключатель',
  cadAirMeasuringHatchKit: 'Лючок замера',
};

/**
 * Вид позиции. Пусто — вид не угадан, и это честнее, чем «прочий».
 */
export function kindOf(p: Classifiable, cls: ClassId = classOf(p)): string {
  const manual = String(p.equipKind || '').trim();
  if (manual) return manual;
  const text = haystack(p);

  if (cls === 'ПРИВОД') {
    // У приводов Belimo серия называет пружину: SF, NF, LF, TF, AF, EF — с
    // возвратной пружиной, SM, LM, NM, GM, AM, CM — без неё
    const model = paramOf(p, /модель|привод/i) || text;
    if (/\b(SF|NF|LF|TF|AF|EF|BF)\d/i.test(model) || /пружин/i.test(model)) return 'С возвратной пружиной';
    if (/\b(SM|LM|NM|GM|AM|CM)\d/i.test(model)) return 'Без пружины';
    return '';
  }
  if (cls === 'ФИЛЬТР') {
    const base = /карман|(?<!\p{L})ФВК|\bbag/iu.test(text) ? 'Карманный'
      : /компакт/i.test(text) ? 'Компактный'
        : /hepa|\bH1[0-4]\b/i.test(text) ? 'HEPA'
          : /панел|(?<!\p{L})ФВП|кассетн/iu.test(text) ? 'Панельный' : '';
    // Класс очистки — часть вида: карманный G4 и карманный F7 — разные изделия
    // для закупки, и в одной строке выгрузки им не место
    const grade = (paramOf(p, /класс\s+(фильтр|очистк)/i) || (text.match(/\b([GFMEH]\d{1,2})\b/) || [])[1] || '').toUpperCase();
    return [base, grade].filter(Boolean).join(' ');
  }
  if (cls === 'КЛАПАН') {
    for (const [re, kind] of KIND_RULES.КЛАПАН || []) if (re.test(text)) return kind;
    const heat = parseFloat(paramOf(p, /мощность\s+подогрева$/i).replace(',', '.'));
    return heat > 0 ? 'С подогревом' : 'Воздушный';
  }
  if (cls === 'ОСНАЩЕНИЕ') return OUTFIT_KINDS[String(p.sourceKind || '')] || '';
  if (cls === 'СЕКЦИЯ') {
    const t = String(p.equipType || '').toUpperCase();
    if (t === 'ВОЗДУХОПРИЁМНЫЙ' || /воздухоприем|воздухоприём/i.test(text)) return 'Воздухоприёмная';
    if (t === 'КАМЕРА' || /камер/i.test(p.name || '')) return 'Камера';
    if (t === 'ВЕНТИЛЯТОР') return 'Вентиляторная';
    return '';
  }
  for (const [re, kind] of KIND_RULES[cls] || []) if (re.test(text)) return kind;
  return '';
}

export interface Classified {
  cls: ClassId;
  kind: string;
  /** Что угадали бы правила — чтобы карточка показала «авто: …» рядом с поправкой */
  auto: { cls: ClassId; kind: string };
}

/**
 * Типы всех позиций одной установки.
 *
 * Здесь, а не в `classOf`, решается, что блок — корпус: для этого нужно знать,
 * что стоит внутри него. Корпусом считается блок без своего тега, внутри
 * которого стоит позиция того же типа. Блок нагревателя, на котором висит тег
 * EB-001A, корпусом не становится, даже если внутри есть безтеговый
 * теплообменник: тег — это и есть ответ проектировщика, где стоит нагреватель.
 */
export function classifyAll(list: Classifiable[]): Map<string, Classified> {
  const out = new Map<string, Classified>();
  const children = new Map<string, Classifiable[]>();
  for (const p of list || []) {
    if (!p.parentElementId) continue;
    if (!children.has(p.parentElementId)) children.set(p.parentElementId, []);
    children.get(p.parentElementId)!.push(p);
  }
  for (const p of list || []) {
    if (!p.id) continue;
    const role = String(p.role || 'БЛОК');
    let shell = false;
    if (role === 'БЛОК' && !(p.tags || []).length) {
      const own = classOf({ ...p, equipClass: '' });
      shell = (children.get(p.id) || []).some((c) => classOf({ ...c, equipClass: '' }) === own);
    }
    const autoCls = classOf({ ...p, equipClass: '' }, { shell });
    const autoKind = kindOf({ ...p, equipKind: '' }, autoCls);
    const cls = classOf(p, { shell });
    const kind = String(p.equipKind || '').trim() || (cls === autoCls ? autoKind : kindOf({ ...p, equipKind: '' }, cls));
    out.set(p.id, { cls, kind, auto: { cls: autoCls, kind: autoKind } });
  }
  return out;
}

/** «Вентилятор · Радиальный, свободное колесо» — подпись в карточке и в списке */
export const classLabel = (c: { cls: string; kind: string }): string =>
  [classTitle(c.cls), c.kind].filter(Boolean).join(' · ');

// Где у позиции записана марка: у привода — «Модель», у вентилятора — сам
// «Вентилятор», у двигателя — «Электродвигатель» и так далее. Порядок значим:
// «Модель» есть не у всех, а там, где есть, она и есть ответ
const MODEL_KEYS = ['Модель', 'Вентилятор', 'Электродвигатель', 'Клапан', 'Теплообменник', 'Узел обвязки', 'Кассета 1', 'Шумоглушитель', 'Увлажнитель'];

/** Марка позиции — для столбца «Модель» выгрузки и Таблицы. Пусто — не нашлась */
export function modelOf(specs: unknown): string {
  const all = groupsOf(specs).flatMap((g) => g.params);
  for (const key of MODEL_KEYS) {
    const hit = all.find((x) => x.key === key && x.value.trim());
    if (hit) return hit.value.trim();
  }
  return '';
}
