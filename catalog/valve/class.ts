/**
 * Класс «Клапаны»: язык признаков, коды типа в тегах, приметы описаний.
 *
 * Приметы собраны по настоящим описаниям — MTO PDH2.12953-3700 (около 26
 * шаблонов строк на двух языках) и бланкам E06-2001…2003. Описание там
 * двуязычное: сначала английская часть, потом та же русская, поэтому каждая
 * примета записана на обоих языках.
 */
import { t2, type EquipmentClass, type TagRule } from '../model';
import type { Detector } from '../describe';

export const VALVE_CLASS_ID = 'cls-valve';

const yes = (s: string) => !/\b(no|нет|без|отсутств)/.test(s);

export const VALVE_CLASS: EquipmentClass = {
  id: VALVE_CLASS_ID,
  code: 'valve',
  title: t2('Клапаны', 'Dampers'),
  itemName: t2('клапан', 'damper'),
  icon: 'Wind',
  sort: 1,
  facts: [
    {
      key: 'kind', label: t2('Род', 'Kind'), type: 'choice', hard: true,
      values: [
        { code: 'fire', label: t2('противопожарный', 'fire') },
        { code: 'air', label: t2('воздушный', 'air') },
        { code: 'check', label: t2('обратный', 'check') },
        { code: 'overpressure', label: t2('избыточного давления', 'overpressure') },
        { code: 'balancing', label: t2('балансировочный', 'balancing') },
        { code: 'gas', label: t2('газоходный', 'flue gas') },
      ],
    },
    {
      key: 'function', label: t2('Назначение', 'Function'), type: 'choice', hard: true,
      values: [
        { code: 'NO', label: t2('нормально открытый', 'normally open') },
        { code: 'NC', label: t2('нормально закрытый', 'normally closed') },
        { code: 'DA', label: t2('двойного действия', 'double acting') },
        { code: 'SMOKE', label: t2('дымоудаления', 'smoke exhaust') },
        { code: 'CONTROL', label: t2('регулирующий', 'control') },
        { code: 'SHUTOFF', label: t2('отсечной', 'shut-off') },
      ],
    },
    { key: 'ei', label: t2('Огнестойкость EI', 'Fire resistance EI'), type: 'number', unit: 'мин', atLeast: true, hard: true, weight: 2 },
    { key: 'ex', label: t2('Взрывозащита', 'Explosion proof'), type: 'bool', hard: true, weight: 2 },
    { key: 'stainless', label: t2('Коррозионностойкое', 'Stainless'), type: 'bool', hard: true },
    { key: 'frost', label: t2('Морозостойкое', 'Frost-proof'), type: 'bool' },
    { key: 'heating', label: t2('С обогревом', 'Heated'), type: 'bool', hard: true, weight: 2 },
    { key: 'climate', label: t2('Климатическое исполнение', 'Climate'), type: 'text' },
    { key: 'voltage', label: t2('Напряжение', 'Voltage'), type: 'number', unit: 'В' },
    { key: 'current', label: t2('Род тока', 'Current'), type: 'choice', values: [{ code: 'AC', label: t2('переменный', 'AC') }, { code: 'DC', label: t2('постоянный', 'DC') }] },
    {
      key: 'actuator', label: t2('Привод', 'Actuator'), type: 'choice', weight: 1.5,
      values: [
        { code: 'spring', label: t2('с возвратной пружиной', 'spring return') },
        { code: 'reversible', label: t2('реверсивный', 'reversible') },
        { code: 'electromagnet', label: t2('электромагнитный', 'electromagnet') },
        { code: 'manual', label: t2('ручной', 'manual') },
        { code: 'none', label: t2('без привода', 'no actuator') },
        { code: 'mechanism', label: t2('электромеханизм МЭО', 'actuator МЭО') },
      ],
    },
    { key: 'thermal', label: t2('Терморазмыкающее устройство', 'Thermal release'), type: 'bool' },
    { key: 'modulating', label: t2('Плавное регулирование', 'Modulating'), type: 'bool' },
    { key: 'limitSwitches', label: t2('Концевые выключатели', 'Limit switches'), type: 'bool' },
    { key: 'junctionBox', label: t2('Клеммная коробка', 'Junction box'), type: 'bool' },
    {
      key: 'mount', label: t2('Тип установки', 'Mounting'), type: 'choice',
      values: [
        { code: 'wall', label: t2('стеновой', 'wall') },
        { code: 'duct', label: t2('канальный', 'duct') },
        { code: 'nipple', label: t2('ниппельный', 'nipple') },
      ],
    },
    {
      // Устройство заслонки — главное, чем обратные клапаны отличаются друг от
      // друга; совпадение по климату или давлению не должно его перевешивать
      key: 'blade', label: t2('Заслонка', 'Blade'), type: 'choice', hard: true, weight: 3,
      values: [
        { code: 'petal', label: t2('лепестковая', 'petal') },
        { code: 'counterweight', label: t2('с противовесом', 'counterweight') },
        { code: 'iris', label: t2('ирисовая', 'iris') },
      ],
    },
    { key: 'leakageClass', label: t2('Класс утечки', 'Leakage class'), type: 'number', atLeast: true },
    { key: 'pressure', label: t2('Рабочее давление', 'Operating pressure'), type: 'number', unit: 'Па', atLeast: true },
    {
      key: 'material', label: t2('Материал', 'Material'), type: 'choice',
      values: [
        { code: 'galv', label: t2('оцинкованная сталь', 'galvanized steel') },
        { code: 'stainless', label: t2('нержавеющая сталь', 'stainless steel') },
        { code: 'carbon', label: t2('углеродистая сталь', 'carbon steel') },
        { code: 'aluminium', label: t2('алюминий', 'aluminium') },
      ],
    },
    { key: 'brand', label: t2('Марка привода', 'Actuator brand'), type: 'text' },
  ],
};

/**
 * Коды типа в тегах проекта PDH2 (`3700-B01-DF-001`). Это практика проекта, а
 * не закон природы, поэтому правила редактируются в Каталоге: у следующего
 * заказчика коды могут быть другими.
 */
export const VALVE_TAG_RULES: TagRule[] = [
  { id: 'tr-df', classId: VALVE_CLASS_ID, code: 'DF', label: t2('Клапан противопожарный НО', 'Fire damper NO'), facts: { kind: 'fire', function: 'NO' }, actuatorCode: 'DFD' },
  { id: 'tr-ds', classId: VALVE_CLASS_ID, code: 'DS', label: t2('Клапан противопожарный НЗ / двойного действия', 'Fire damper NC / double acting'), facts: { kind: 'fire' }, actuatorCode: 'DSD' },
  { id: 'tr-dv', classId: VALVE_CLASS_ID, code: 'DV', label: t2('Заслонка регулирующая', 'Control damper'), facts: { kind: 'air' }, actuatorCode: 'DVD' },
  { id: 'tr-dn', classId: VALVE_CLASS_ID, code: 'DN', label: t2('Клапан обратный', 'Check valve'), facts: { kind: 'check' } },
  { id: 'tr-dp', classId: VALVE_CLASS_ID, code: 'DP', label: t2('Клапан избыточного давления', 'Overpressure valve'), facts: { kind: 'overpressure' } },
  { id: 'tr-dw', classId: VALVE_CLASS_ID, code: 'DW', label: t2('Клапан утеплённый / отсечной', 'Shut-off / heated damper'), facts: { kind: 'air' }, actuatorCode: 'DWD' },
  { id: 'tr-da', classId: VALVE_CLASS_ID, code: 'DA', label: t2('Решётки и диффузоры — не клапаны', 'Grilles and diffusers'), facts: {}, skip: true },
];

/**
 * Приметы описаний.
 *
 * Приоритет решает спор за кусок текста: отрицательная форма («without spring
 * return», «без привода») стоит выше утвердительной, иначе прочитается
 * наоборот. Проверяется в scripts/test-catalog-match.ts на строках MTO.
 */
export const VALVE_DETECTORS: Detector[] = [
  // Род
  { key: 'kind', re: /fire\s*(?:fighting\s*)?damper|клапан\w*\s+противопожарн\w*|противопожарн\w+\s+клапан|огнезадерживающ\w*/, value: 'fire' },
  { key: 'kind', re: /check\s*(?:channel\s*)?valve|duct\s*check|non[-\s]?return|обратн\w+\s+клапан|клапан\w*\s+обратн\w*/, value: 'check', priority: 2 },
  { key: 'kind', re: /over\s*pressure\s*valve|relief\s*valve|избыточного\s+давления/, value: 'overpressure', priority: 2 },
  { key: 'kind', re: /balanc\w*\s*(?:damper|valve)|балансировочн\w*/, value: 'balancing', priority: 2 },
  // Одиночное «damper» ловим только в начале описания («Damper, rectangular
  // section…»): внутри противопожарного описания стоит «Damper type - duct
  // damper», и оно дало бы ложный конфликт «противопожарный или воздушный»
  { key: 'kind', re: /heat[-\s]?insulated\s*damper|air\s*vent\s*valve|air\s*damper|утепл\w*\s+клапан|клапан\w*\s+воздушн\w*|воздушн\w*\s+клапан|^\s*заслонк\w*|^\s*damper\b/, value: 'air' },
  { key: 'kind', re: /газоход|flue\s*gas/, value: 'gas', priority: 2 },

  // Назначение
  // «НО» без точек не ловим: в русском тексте это ещё и союз «но»
  // «НО» без точек — только когда за ним сразу знак препинания («НО,», «(НО)»):
  // иначе это союз «но», а он в описаниях встречается чаще аббревиатуры
  { key: 'function', re: /normally\s*open|нормально[-\s]*открыт\w*|\bн\.\s?о\.|\bно(?=\s*[,;/)]|\s*$)/, value: 'NO' },
  { key: 'function', re: /normally\s*closed|нормально[-\s]*закрыт\w*|\bн\.?\s?з\.?\b/, value: 'NC' },
  { key: 'function', re: /double[-\s]*acting|двойного\s+действия/, value: 'DA', priority: 3 },
  { key: 'function', re: /smoke\s*(?:exhaust|damper|extraction)|дымоудален\w*|дымов\w+\s+клапан/, value: 'SMOKE' },

  // Огнестойкость: «EI 60», «EI60», «ЕI 90» (первая буква кириллическая), «E 120»
  { key: 'ei', re: /(?:\b|[^a-zа-я])[eе][iі1l]?\s?-?\s?(\d{2,3})\b/, value: (m) => +m[1] },

  // Исполнение
  { key: 'ex', re: /non[-\s]?explosion|general[-\s]*industrial|общепромышленн\w*|общепром\b/, value: false, priority: 3 },
  { key: 'ex', re: /explosion[-\s]*proof|взрывозащищ\w*|взрывобезопасн\w*|\bex\b|\batex\b/, value: true },
  { key: 'stainless', re: /stainless|нержаве\w*|коррозионностойк\w*/, value: true },
  { key: 'frost', re: /frost[-\s]*resist\w*|морозостойк\w*/, value: true },
  { key: 'heating', re: /(?:with\s+)?perimeter\s+heating|heated|heating\s+cable|с\s+обогрев\w*|обогрев\w*\s+по\s+периметру|электрообогрев\w*|подогрев\w*/, value: true },
  { key: 'climate', re: /\b(ухл\s?[1-5](?:\.1)?|у\s?[1-5]|ukhl\s?[1-5]|uhl\s?[1-5]|u\s?[1-5]|т\s?[1-5]|ом\s?[1-5])\b/, value: (m) => climateRu(m[1]) },

  // Привод
  { key: 'actuator', re: /without\s+spring\s+return|без\s+возвратн\w*\s+пружин\w*|reversing|reversible|реверсивн\w*/, value: 'reversible', priority: 5 },
  { key: 'actuator', re: /spring\s*return|возвратн\w*\s+пружин\w*|пружинн\w*\s+возврат\w*|с\s+пружин\w*/, value: 'spring', priority: 4 },
  { key: 'actuator', re: /electro\s*magnet\w*|электромагнит\w*/, value: 'electromagnet', priority: 4 },
  { key: 'actuator', re: /no\s+drive|without\s+(?:a\s+)?drive|без\s+привод\w*|control\s*-\s*no\b/, value: 'none', priority: 6 },
  { key: 'actuator', re: /manual\s*control|manual|handle|ручн\w+(?:\s+управлени\w*)?|рукоятк\w*|ручк\w*/, value: 'manual', priority: 3 },
  { key: 'actuator', re: /мэо\b|electric\s+mechanism/, value: 'mechanism', priority: 3 },
  { key: 'thermal', re: /thermal\s*(?:release|element|fuse)|fusible\s*link|терморазмыка\w*|термоэлемент\w*|\bтру\b/, value: true },
  { key: 'modulating', re: /modulat\w*|0\s*\(?2\)?\s*-\s*10\s*v|плавн\w+\s+регулир\w*/, value: true },
  { key: 'limitSwitches', re: /limit\s*switch\w*[^.;]*?-\s*(yes|no)|концев\w*\s+выключател\w*[^.;]*?-\s*(есть|да|нет)/, value: (m) => yes(m[1] || m[2] || '') },
  { key: 'junctionBox', re: /junction\s*box[^.;]*?-\s*(yes|no)|коробк\w*[^.;]*?клемм\w*[^.;]*?-\s*(есть|да|нет)|клеммн\w*\s+коробк\w*[^.;]*?-\s*(есть|да|нет)/, value: (m) => yes(m[1] || m[2] || m[3] || '') },

  // Напряжение: «24 V (DC)», «230 V (AC)», «~220 В», «=24В». 230 и 220 — одно
  // и то же напряжение сети: каталоги пишут 220, западные описания — 230
  {
    key: 'voltage', re: /(?<!\d)(24|220|230|380|400)\s*(?:v|в)\b/,
    value: (m) => (+m[1] === 230 ? 220 : +m[1] === 400 ? 380 : +m[1]),
  },
  { key: 'current', re: /\(\s*dc\s*\)|\bdc\b|постоянн\w+\s+ток\w*|=\s?24\s?(?:v|в)/, value: 'DC' },
  { key: 'current', re: /\(\s*ac\s*\)|\bac\b|переменн\w+\s+ток\w*|~\s?(?:220|230|24)\s?(?:v|в)/, value: 'AC' },

  // Установка и устройство
  { key: 'mount', re: /duct\s*damper|channel|канальн\w*/, value: 'duct' },
  { key: 'mount', re: /wall\s*(?:damper|mount\w*)|стенов\w*|настенн\w*/, value: 'wall' },
  { key: 'mount', re: /nipple|ниппельн\w*/, value: 'nipple' },
  { key: 'blade', re: /petal|лепестков\w*/, value: 'petal' },
  { key: 'blade', re: /counter\s*weight|противовес\w*/, value: 'counterweight' },
  { key: 'blade', re: /\biris\b|ирисов\w*/, value: 'iris' },
  { key: 'leakageClass', re: /leakage[^.;]*?class\s*-?\s*([0-4])\b|класс\w*\s+(?:утечки|герметичности|плотности)[^.;]*?([0-4])\b/, value: (m) => +(m[1] || m[2]) },
  { key: 'pressure', re: /(?:operating|working)\s+pressure[^0-9]{0,30}(\d{3,5})|рабоч\w+\s+давлени\w*[^0-9]{0,30}(\d{3,5})/, value: (m) => +(m[1] || m[2]) },

  // Материал
  { key: 'material', re: /galvani[sz]ed|оцинкован\w*/, value: 'galv' },
  { key: 'material', re: /carbon\s*steel|углеродист\w*/, value: 'carbon' },
  { key: 'material', re: /alumin\w*|алюмини\w*/, value: 'aluminium' },

  // Марки приводов
  { key: 'brand', re: /belimo|белимо/, value: 'BELIMO' },
  { key: 'brand', re: /\bneman\b|неман/, value: 'НЕМАН' },
];

function climateRu(raw: string): string {
  const s = raw.replace(/\s+/g, '').toLowerCase();
  const map: Array<[RegExp, string]> = [[/^(ukhl|uhl)/, 'УХЛ'], [/^u/, 'У'], [/^ухл/, 'УХЛ'], [/^у/, 'У'], [/^т/, 'Т'], [/^ом/, 'ОМ']];
  for (const [re, ru] of map) if (re.test(s)) return ru + s.replace(/^[a-zа-я]+/, '');
  return raw.toUpperCase();
}
