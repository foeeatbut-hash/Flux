/**
 * Проверенный дельта-пакет каталогов ВЕЗА.
 *
 * Он не запускается как seed и сам не пишет в Каталог: редактор импортирует
 * набор в черновик, проверяет diff и явно публикует выбранные записи.
 * PDF хранятся как вложения редакции в БД; здесь только ссылки на физические
 * и печатные страницы исходных изданий.
 */
import { t2, type Catalog, type CatalogDocument, type CatalogTable, type EquipmentClass, type Family, type Manufacturer, type ParamDef, type Rule, type TagRule } from '../model';
import { seedCatalog } from '../seed';

const FAN_CLASS_ID = 'fan';
const VEZA_ID = 'mf-veza';
const OSA_FILE = 'ОСА 300/301, осевые вентиляторы.pdf';
const OSA_EDITION = 'июнь 2024';
const AIR_FILE = 'ВЕЗА_Воздушные клапаны_от 04.06.2026.pdf';
const AIR_EDITION = '04.06.2026';

export const veza2026Title = 'Каталоги ВЕЗА: ОСА 300/301 и разделы воздушных клапанов';
export const title = veza2026Title;

const osaRef = (physicalPage?: number, printedPage?: string, pages?: string) => ({
  file: OSA_FILE, edition: OSA_EDITION, ...(pages ? { pages } : {}),
  ...(physicalPage ? { physicalPage, printedPage } : {}),
});
const airRef = (pages: string) => ({ file: AIR_FILE, edition: AIR_EDITION, pages });

const osaDocuments = (family: '300' | '301'): CatalogDocument[] => [
  { id: `veza-osa-${family}-overview`, label: 'Описание, устройство и условия применения', kind: 'manual', ...osaRef(9, '8', '9') },
  { id: `veza-osa-${family}-marking`, label: 'Маркировка, исполнения и назначение сегментов', kind: 'manual', ...osaRef(10, '9', '10') },
  { id: `veza-osa-${family}-availability`, label: 'Матрица типоразмеров, полюсности, исполнений и климатов', kind: 'manual', ...osaRef(6, '5', '6') },
  { id: `veza-osa-${family}-installation`, label: 'Монтажные условия аэродинамических характеристик', kind: 'manual', ...osaRef(7, '6', '7–8') },
  { id: `veza-osa-${family}-performance`, label: 'Технические таблицы и графики по типоразмерам', kind: 'curve', ...osaRef(undefined, undefined, '13–34') },
];

const sizeCodes = ['040', '045', '050', '056', '063', '071', '080', '090', '100', '112', '125'];
const wheelMods = ['А', 'Б', 'Е', 'И', 'Л', 'М', 'П', 'Р', 'С', 'Т'];
const wheelIndexes = ['40', '45', '50', '52', '55', '57', '60', '65', '70'];
const poles = ['2', '4', '6'];
const climates300 = ['У1', 'У2', 'УХЛ1'];
const climates301 = ['У1', 'У2'];
const executions300 = ['Н', 'К', 'В', 'ВС', 'ВК', 'ВСК'];
const executions301 = ['Н', 'К'];
const bodies = ['01', '02'];

const choice = (key: string, ru: string, codes: string[], step: ParamDef['step'] = 'options', labels: Record<string, string> = {}): ParamDef => ({
  key, label: t2(ru), kind: 'choice', step,
  values: codes.map((code) => ({ code, label: t2(labels[code] || code) })),
});
const fixed = (code: string) => ({ key: 'series', label: t2('Модель'), formats: [code] });
const pos = (key: string, ru: string, format: string) => ({ key, label: t2(ru), formats: [format] });

const availabilityTable = (family: '300' | '301'): CatalogTable => ({
  id: `veza-osa-${family}-availability`, title: `Допустимые типоразмеры и полюсность ОСА ${family}`,
  columns: [
    { key: 'fanSize', label: 'Типоразмер', role: 'input' },
    { key: 'poles', label: 'Число полюсов', role: 'output' },
  ],
  rows: sizeCodes.map((fanSize) => ({
    id: `${fanSize}`,
    values: { fanSize, poles: fanSize <= '063' ? '2, 4' : fanSize >= '071' ? '4, 6' : '4' },
    verified: true, source: osaRef(6, '5'),
  })),
  source: osaRef(6, '5'),
});

const verifiedExampleTable: CatalogTable = {
  id: 'veza-osa-300-040-2-example',
  title: 'Проверенная строка таблицы выбора ОСА 300/301-040, 2 полюса',
  columns: [
    { key: 'fanSize', label: 'Типоразмер', role: 'input' },
    { key: 'poles', label: 'Число полюсов', role: 'input' },
    { key: 'curve', label: 'Номер кривой', role: 'input' },
    { key: 'wheelMod', label: 'Модификация колеса', role: 'input' },
    { key: 'wheelIndex', label: 'Индекс колеса', role: 'input' },
    { key: 'nominalPower', label: 'Nном', unit: 'кВт', role: 'output' },
    { key: 'motorIndex', label: 'Индекс мощности двигателя', role: 'output' },
    { key: 'motorFrame', label: 'Габарит ЭД', role: 'output' },
    { key: 'current380', label: 'Ток при 380 В', unit: 'А', role: 'output' },
    { key: 'massBody01', label: 'Масса, корпус 01', unit: 'кг', role: 'output' },
    { key: 'massBody02', label: 'Масса, корпус 02', unit: 'кг', role: 'output' },
  ],
  rows: [{
    id: 'curve-1',
    values: { fanSize: '040', poles: '2', curve: '1', wheelMod: 'А', wheelIndex: '40', nominalPower: '0.55', motorIndex: '00055', motorFrame: '63В2', current380: '1.43', massBody01: '28', massBody02: '25' },
    verified: true, source: osaRef(13, '12'),
  }],
  source: osaRef(undefined, undefined, '13–34'),
};

const allowedRule = (family: '300' | '301'): Rule[] => {
  const size2 = sizeCodes.slice(0, 5);
  const size6 = sizeCodes.slice(5);
  return [
    { id: `osa-${family}-poles-2`, when: { param: 'poles', in: ['2'] }, then: { allow: { param: 'fanSize', values: size2 } }, message: '2 полюса допустимы только для типоразмеров 040–063', source: 'PDF 6 / печ. стр. 5' },
    { id: `osa-${family}-poles-6`, when: { param: 'poles', in: ['6'] }, then: { allow: { param: 'fanSize', values: size6 } }, message: '6 полюсов допустимы только для типоразмеров 071–125', source: 'PDF 6 / печ. стр. 5' },
    ...(family === '301' ? [
      { id: 'osa-301-no-ex', when: { param: 'execution', in: ['В', 'ВС', 'ВК', 'ВСК'] }, then: { forbid: { param: 'execution', values: ['В', 'ВС', 'ВК', 'ВСК'] } }, message: 'Взрывозащищённые исполнения приведены только для ОСА 300', source: 'PDF 6, 10 / печ. стр. 5, 9' },
      { id: 'osa-301-no-uhl1', when: { param: 'climate', in: ['УХЛ1'] }, then: { forbid: { param: 'climate', values: ['УХЛ1'] } }, message: 'Климат УХЛ1 приведён только для ОСА 300', source: 'PDF 6, 10 / печ. стр. 5, 9' },
    ] : []),
  ];
};

function osaFamily(family: '300' | '301'): Family {
  const is300 = family === '300';
  const code = `ОСА${family}`;
  const familyId = `veza-osa-${family}`;
  const execution = is300 ? executions300 : executions301;
  const climate = is300 ? climates300 : climates301;
  return {
    id: familyId, classId: FAN_CLASS_ID, manufacturerId: VEZA_ID, code,
    aliases: [`ОСА ${family}`],
    title: t2(`Осевой вентилятор ОСА ${family}`),
    description: t2(`Осевой вентилятор низкого/среднего давления; ${is300 ? 'алюминиевые' : 'пластиковые'} лопатки рабочего колеса.`),
    kind: 'axial', typeLabel: t2('Осевой вентилятор'), shapes: [],
    designationMode: 'structured', designationSeparator: '-', sizeSep: '/',
    params: [
      choice('fanSize', 'Типоразмер', sizeCodes, 'size'),
      choice('wheelMod', 'Модификация колеса', wheelMods),
      choice('wheelIndex', 'Индекс колеса', wheelIndexes),
      choice('execution', 'Исполнение', execution, 'execution', {
        Н: 'Н — общепромышленное', К: 'К — коррозионностойкое', В: 'В — взрывозащищённое',
        ВС: 'ВС — взрывозащищённое для группы газов IIC', ВК: 'ВК — взрывозащищённое коррозионностойкое',
        ВСК: 'ВСК — взрывозащищённое коррозионностойкое, группа газов IIC',
      }),
      choice('motorIndex', 'Индекс мощности двигателя', ['00400', '00055'], 'drive', { '00400': '00400 — в примере соответствует 4 кВт', '00055': '00055 — подтверждён в таблице выбора, 0,55 кВт' }),
      choice('poles', 'Число полюсов', poles, 'drive'),
      choice('climate', 'Климатическое исполнение и категория размещения', climate, 'options', { У1: 'У1 — умеренный климат, категория 1', У2: 'У2 — умеренный климат, категория 2', УХЛ1: 'УХЛ1 — умеренный и холодный климат, категория 1' }),
      choice('body', 'Тип корпуса', bodies, 'options', { '01': '01 — двигатель полностью закрыт', '02': '02 — минимальная длина корпуса, двигатель закрыт не полностью' }),
    ],
    positions: [
      fixed(code),
      pos('fanSize', 'Типоразмер колеса', '{fanSize}/{wheelMod}'),
      pos('wheelIndex', 'Индекс колеса', '{wheelIndex}'),
      pos('execution', 'Исполнение', '{execution}'),
      pos('motorIndex', 'Индекс мощности двигателя', '{motorIndex}/{poles}'),
      pos('climate', 'Климатическое исполнение', '{climate}'),
      pos('body', 'Тип корпуса', '{body}'),
    ],
    rules: allowedRule(family),
    match: { kinds: ['axial'], shapes: [], keywords: ['оса', 'осевой вентилятор'] },
    facts: { kind: 'axial', bladeMaterial: is300 ? 'aluminium' : 'plastic' },
    specs: [
      { key: 'blade-material', label: t2('Материал лопаток'), value: t2(is300 ? 'Алюминий' : 'Пластик') },
      { key: 'temperature', label: t2('Температура эксплуатации по климатическому исполнению'), value: t2('не задано'), unit: '°C', cases: [
        { when: { param: 'climate', in: ['У1', 'У2'] }, value: t2('−45…+40') },
        ...(is300 ? [{ when: { param: 'climate', in: ['УХЛ1'] }, value: t2('−60…+40') }] : []),
      ] },
    ],
    catalog: osaRef(undefined, undefined, '6–10, 13–34'),
    documents: osaDocuments(family),
    tables: [availabilityTable(family), ...(is300 ? [verifiedExampleTable] : [])],
    status: 'partial',
    todo: [
      'Оцифровать и визуально сверить все строки таблиц выбора pp. 13–34; сейчас включена только подтверждённая строка примера ОСА-040/2, кривая 1.',
      'Сверить точное соответствие колонок L, L1 max и Ex отдельно на каждом листе; размеры и массу остальных исполнений не переносить из OCR.',
      'Не извлекать численные точки с графиков pp. 11–34 без калиброванной оцифровки и условий испытаний.',
      'Проверить сочетания размера, модификации колеса, индекса колеса, исполнения и двигателя по таблицам производителя; приведённые списки кодов не задают все допустимые комбинации.',
    ],
    examples: is300 ? ['ОСА300-050/Б-50-Н-00400/2-У1-02'] : [],
    sort: is300 ? 10 : 11,
  };
}

const fanClass: EquipmentClass = {
  id: FAN_CLASS_ID, code: 'fan', title: t2('Вентиляторы'), itemName: t2('вентилятор'), icon: 'fan', sort: 20,
  facts: [
    { key: 'kind', label: t2('Тип вентилятора'), type: 'choice', values: [{ code: 'axial', label: t2('осевой') }] },
    { key: 'bladeMaterial', label: t2('Материал лопаток'), type: 'choice', values: [{ code: 'aluminium', label: t2('алюминий') }, { code: 'plastic', label: t2('пластик') }] },
    { key: 'motorPower', label: t2('Номинальная мощность двигателя'), type: 'number', unit: 'кВт' },
    { key: 'poles', label: t2('Число полюсов'), type: 'choice', values: poles.map((code) => ({ code, label: t2(code) })) },
  ],
};

const baseline = seedCatalog();
const existingManufacturer = baseline.manufacturers.find((item) => item.id === VEZA_ID)!;
const manufacturer: Manufacturer = {
  ...existingManufacturer,
  notes: `${existingManufacturer.notes || ''}; ОСА 300/301 (июнь 2024); воздушные клапаны (04.06.2026)`,
};

// Расширяем существующие записи их собственными разделами источника. Семейства
// сохраняют индивидуальные positions/rules; никакая грамматика ОСА на клапаны
// не переносится. Catalog family IDs остаются неизменными.
const verifiedAirSections: Record<string, string> = {
  РЕГУЛЯР: '8–18', 'РЕГУЛЯР-Л': '13–18', РЕГЛАН: '19–21', КЕДР: '22–29', 'КЕДР-С': '22–29',
  'ГЕРМИК-П': '30–39', 'ГЕРМИК-Р': '30–39', 'ГЕРМИК-С': '30–39',
  'ГЕРМИКх2П': '40–46', 'ГЕРМИКх2С': '40–46', НЕРПА: '47–53', КЛАБ: '54–56', ГЕК: '57–61', ГАЗОХОД: '62–67',
  КЛАРА: '68–74', 'КЛАРА-КРОС': '68–74', 'ТЮЛЬПАН-1': '75–84', 'ТЮЛЬПАН-2': '75–84', 'ТЮЛЬПАН-3': '75–84',
  КОЛ: '85–90', УКОЛ: '87–96', 'НЕРПА-КО': '97–102', КИД: '103–109',
};
const valveFamilies = baseline.families
  .filter((family) => family.manufacturerId === VEZA_ID && family.code in verifiedAirSections)
  .map((family) => {
    const pages = verifiedAirSections[family.code];
    const refs = pages.split(/[–-]/).map((part) => Number(part.trim())).filter(Number.isFinite);
    const first = refs[0] || 1;
    const last = refs.length > 1 ? refs[refs.length - 1] : first;
    const ids = last > first ? Array.from({ length: last - first + 1 }, (_, index) => first + index) : [first];
    return {
      ...family,
      catalog: { ...airRef(pages), pages },
      documents: ids.map((printed) => ({
        id: `${family.id}-source-p${printed}`,
        label: `Раздел ${family.code}: PDF стр. ${printed} / печ. стр. ${printed - 2}`,
        kind: 'manual' as const,
        ...airRef(String(printed)), physicalPage: printed, printedPage: String(printed - 2),
      })),
    };
  });

const noNewComponents: Catalog['components'] = [];
const noTagRules: TagRule[] = [];

/** Дельта импорта. Пустые components/tagRules означают отсутствие данных этого типа в пакете. */
export const veza2026Pack = {
  format: 'flux-catalog' as const,
  version: 1 as const,
  classes: [fanClass],
  manufacturers: [manufacturer],
  families: [...valveFamilies, osaFamily('300'), osaFamily('301')],
  components: noNewComponents,
  tagRules: noTagRules,
};
