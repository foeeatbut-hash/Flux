import { XMLParser } from 'fast-xml-parser';
import { canonicalUnit } from './normalize.js';
import { vezaGroup, vezaLevel, vezaProp, vezaUnit } from './vezaDict.js';
import type { EquipParseResult, ParsedBlock, ParsedMonoblock, ParsedUnit, SpecGroup, SpecParam } from './equipmentParser.js';

/**
 * Разбор выгрузки САПР вентиляционного оборудования.
 *
 * Такой файл устроен не как обычный XML: в нём нет вложенных «установка →
 * блок → параметр». Есть плоский словарь `<Elements>`, где каждый узел —
 * тег с выдуманным именем `N<число>`, и отдельное дерево `<Structure>`, где
 * те же имена расставлены по местам, а самих данных нет. Что за узел —
 * написано в его атрибуте `cfnElement`: `cadUnitFolder`, `cadBlockFolder`,
 * `cadReportCollectionItem` и ещё семь десятков видов.
 *
 * Отсюда два решения, на которых держится весь модуль.
 *
 * Первое: читать дерево, а словарь держать справочником. Иначе порядок и
 * принадлежность теряются — в словаре блоки всех установок лежат вперемешку.
 *
 * Второе, главное: НЕ спускаться ниже блока. Ниже начинается производство —
 * двадцать восемь тысяч круглых отверстий с координатами, двенадцать тысяч
 * шестигранных, панели, профили, краска, заклёпки. Это правда про то, как
 * изделие сделано, но не про то, какое оборудование стоит в системе. Реестр
 * оборудования, куда идёт импорт, — про позиции, и если ссыпать туда крепёж,
 * им нельзя будет пользоваться. Всё, что инженеру нужно про блок, выгрузка и
 * так складывает в его коллекцию отчёта: и модель клапана, и привод, и масса.
 */

/** Узел словаря: только атрибуты, детей у него нет. */
type El = Record<string, string>;

const attr = (el: El | undefined, name: string): string =>
  String(el?.[`@_${name}`] ?? '').trim();

const kindOf = (el: El | undefined): string => attr(el, 'cfnElement');

/**
 * Похоже ли на выгрузку САПР.
 *
 * Проверяется по существу, а не по имени файла: `cfnElement` с приставкой
 * `cad` не встречается больше нигде, а `<Root><Elements>` без него бывает у
 * кого угодно.
 */
export function looksLikeVezaXml(text: string): boolean {
  const head = String(text || '').slice(0, 60000);
  return /<Elements\b/.test(head) && /cfnElement\s*=\s*"cad/.test(head);
}

/** Дети узла дерева, вместе с их видом; порядок сохраняется. */
function childrenOf(node: any, dict: Record<string, El>): { id: string; kind: string; el: El; node: any }[] {
  const out: { id: string; kind: string; el: El; node: any }[] = [];
  if (!node || typeof node !== 'object') return out;
  for (const key of Object.keys(node)) {
    if (key.startsWith('@_') || key === '#text') continue;
    const value = (node as any)[key];
    const items = Array.isArray(value) ? value : [value];
    const el = dict[key] || {};
    for (const item of items) out.push({ id: key, kind: kindOf(el), el, node: item });
  }
  return out;
}

const childrenByKind = (node: any, dict: Record<string, El>, kind: string) =>
  childrenOf(node, dict).filter(c => c.kind === kind);

/**
 * Параметры из коллекций отчёта данного узла.
 *
 * Коллекций у узла может быть несколько (у заказа — своя, у установки — своя),
 * поэтому уровень берётся из самой коллекции, а не из того, где её нашли.
 */
function collectionsOf(node: any, dict: Record<string, El>): { level: string; groups: SpecGroup[] }[] {
  return childrenByKind(node, dict, 'cadReportCollection').map(c => ({
    level: vezaLevel(attr(c.el, 'proReportLevel')),
    groups: groupsOfCollection(c.node, dict),
  }));
}

/**
 * Разбор одной коллекции в разделы.
 *
 * Разделы идут в том порядке, в каком встретились: выгрузка кладёт их так, как
 * они стоят в отчёте САПР, и инженер привык видеть их именно в этом порядке.
 */
function groupsOfCollection(node: any, dict: Record<string, El>): SpecGroup[] {
  const order: string[] = [];
  const byGroup = new Map<string, SpecParam[]>();

  for (const item of childrenByKind(node, dict, 'cadReportCollectionItem')) {
    const groupCode = attr(item.el, 'proReportPropGroup');
    const typeCode = attr(item.el, 'proReportPropType');
    const value = attr(item.el, 'proReportPropValue');
    if (!typeCode) continue;

    const title = vezaGroup(groupCode);
    const { title: key } = vezaProp(groupCode, typeCode);
    const unit = canonicalUnit(vezaUnit(attr(item.el, 'proMeasureUnit')));

    if (!byGroup.has(title)) { byGroup.set(title, []); order.push(title); }
    const params = byGroup.get(title)!;

    // Один и тот же параметр в разделе дважды встречается редко, но встречается.
    // Повтор с тем же значением молча пропускаем; с другим — сохраняем оба под
    // разными ключами: потерять одно из двух расчётных значений хуже, чем
    // показать оба и дать инженеру решить.
    const sameKey = params.filter(p => p.key === key || p.key.startsWith(`${key} (`));
    if (sameKey.some(p => p.value === value)) continue;
    params.push({ key: sameKey.length ? `${key} (${sameKey.length + 1})` : key, value, unit });
  }

  return order.map(title => ({ title, params: byGroup.get(title) || [] })).filter(g => g.params.length > 0);
}

/** Значение параметра по разделу и ключу — чтобы достать обозначение и позицию. */
function paramValue(groups: SpecGroup[], groupTitle: string, key: string): string {
  const g = groups.find(x => x.title === groupTitle);
  return g?.params.find(p => p.key === key)?.value || '';
}

/** «Блок 1.1 Передняя панель c клапаном» → «Передняя панель c клапаном». */
function stripBlockPrefix(name: string): string {
  return String(name || '').replace(/^Блок\s+[\d.]+\s*/i, '').trim();
}

function parseBlock(entry: { el: El; node: any }, dict: Record<string, El>, index: number, detectType: (s: string) => string): ParsedBlock {
  const groups = collectionsOf(entry.node, dict).flatMap(c => c.groups);
  const cfnName = attr(entry.el, 'cfnName');
  const title = paramValue(groups, 'Блок', 'Наименование') || stripBlockPrefix(cfnName) || cfnName || `бл${index + 1}`;
  // Код позиции («1.1») — адрес блока внутри установки: по нему повторный
  // импорт находит тот же блок, а инженер — ту же строку в спецификации
  const code = attr(entry.el, 'cfnNote') || paramValue(groups, 'Блок', 'Позиция') || `бл${index + 1}`;
  return { name: code, title, equipType: detectType(title), groups };
}

function parseMonoblock(entry: { el: El; node: any }, dict: Record<string, El>, index: number, detectType: (s: string) => string): ParsedMonoblock {
  const name = attr(entry.el, 'cfnName') || `мн${index + 1}`;
  const groups = collectionsOf(entry.node, dict).flatMap(c => c.groups);
  const blocks: ParsedBlock[] = [];

  // Собственные параметры моноблока (масса, габариты, сопротивление) — служебной
  // строкой «_общие», как их кладёт разбор Excel. Своё место для них завести
  // было бы честнее, но тогда две ветки импорта хранили бы одно и то же
  // по-разному, и выгрузка в Excel разъехалась бы с бланком.
  if (groups.length) {
    blocks.push({ name: `${name}_общие`, title: 'Общие параметры моноблока', equipType: 'МОНОБЛОК', groups });
  }

  for (const folder of childrenByKind(entry.node, dict, 'cadBlocksFolder')) {
    const items = childrenByKind(folder.node, dict, 'cadBlockFolder');
    items.forEach((b, i) => blocks.push(parseBlock(b, dict, i, detectType)));
  }

  return { name, title: name, blocks };
}

/**
 * Разобрать выгрузку.
 *
 * `detectType` передаётся снаружи, а не берётся из `equipmentParser`: иначе
 * два модуля ссылались бы друг на друга по кругу, и сборка это бы не простила.
 */
export function parseVezaXml(xmlText: string, detectType: (s: string) => string): EquipParseResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
  });
  const doc = parser.parse(xmlText);
  const root = doc?.Root || doc?.root;
  if (!root) return { units: [] };

  // Словарь: имя тега → его атрибуты. Повтор имени в словаре — ошибка выгрузки;
  // берём первый, чтобы не уронить весь файл из-за одной строки
  const dict: Record<string, El> = {};
  for (const [key, value] of Object.entries(root.Elements || {})) {
    if (key.startsWith('@_') || key === '#text') continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (first && typeof first === 'object') dict[key] = first as El;
  }

  const result: EquipParseResult = { units: [] };
  const structure = root.Structure;
  if (!structure) return result;

  for (const ordersFolder of childrenByKind(structure, dict, 'cadOrdersFolder')) {
    for (const order of childrenByKind(ordersFolder.node, dict, 'cadOrderFolder')) {
      // Параметры заказа (номер, объект, заказчик, примечания) относятся ко
      // всем установкам файла. Повторить их в каждой — не дублирование ради
      // дублирования: установка уезжает в реестр отдельной строкой, и без
      // номера заказа её потом не с чем связать
      const orderGroups = collectionsOf(order.node, dict).flatMap(c => c.groups);

      for (const unitsFolder of childrenByKind(order.node, dict, 'cadUnitsFolder')) {
        const units = childrenByKind(unitsFolder.node, dict, 'cadUnitFolder');
        units.forEach((u, i) => result.units.push(parseUnit(u, dict, i, orderGroups, detectType)));
      }
    }
  }

  return result;
}

function parseUnit(
  entry: { el: El; node: any },
  dict: Record<string, El>,
  index: number,
  orderGroups: SpecGroup[],
  detectType: (s: string) => string,
): ParsedUnit {
  const ownGroups = collectionsOf(entry.node, dict).flatMap(c => c.groups);
  const groups = [...orderGroups, ...ownGroups];

  // Обозначение установки по проекту («3700-A01-HU-001В») — это тег, адрес
  // установки в документации. Он и становится именем: по нему установку ищут,
  // и по нему импорт привязывает её к уже заведённому в проекте тегу
  const designation = attr(entry.el, 'proUnitName') || paramValue(ownGroups, 'Параметры установки', 'Обозначение установки');
  const cfnName = attr(entry.el, 'cfnName');
  const name = designation || cfnName || `у${index + 1}`;
  const title = attr(entry.el, 'proFrontName') || cfnName || name;

  const monoblocks: ParsedMonoblock[] = [];
  for (const folder of childrenByKind(entry.node, dict, 'cadMonoblocksFolder')) {
    for (const m of childrenByKind(folder.node, dict, 'cadMonoblockFolder')) {
      monoblocks.push(parseMonoblock(m, dict, monoblocks.length, detectType));
    }
  }

  return { name, title, groups, monoblocks, tags: designation ? [designation] : [] };
}
