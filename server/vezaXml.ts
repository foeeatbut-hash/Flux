import { XMLParser } from 'fast-xml-parser';
import { canonicalUnit } from './normalize.js';
import { vezaGroup, vezaGroupRoles, vezaKindSense, vezaLevel, vezaProp, vezaRole, vezaUnit, VEZA_SAME_ROLE } from './vezaDict.js';
import { distribute, type TagSlot } from '../equipment/notes.js';
import { PERMISSIVE_TAG_POLICY } from '../equipment/tagPolicy.js';
import { roleById, type RoleId } from '../equipment/roles.js';
import type { EquipParseResult, ParsedBlock, ParsedMonoblock, ParsedUnit, SpecGroup, SpecParam, TagEvidence } from './equipmentParser.js';

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
 * им нельзя будет пользоваться.
 *
 * Третье, добавленное позже: между блоком и крепежом лежит слой оборудования,
 * и именно его тегируют. Вентилятор в блоке, его двигатель, клапан и два
 * привода клапана — это отдельные позиции с отдельными тегами, а не строки
 * карточки блока. Поэтому внутрь блока разбор всё-таки спускается — но только
 * по закрытому списку видов (`VEZA_ROLES`), и всё, чего в списке нет, остаётся
 * в исходном файле. Параметры подпозиции берутся из разделов коллекции блока
 * (`ptgMOTOR` — двигателя, `ptgVARCONN` — клапана): своих коллекций у
 * подпозиций в выгрузке не бывает.
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

    /**
     * Повтор параметра в разделе встречается редко, но встречается.
     *
     * Совпадением считается совпадение значения ВМЕСТЕ С ЕДИНИЦЕЙ. Раньше
     * сравнивалось одно значение, и «1 м» рядом с «1 мм» схлопывалось в одну
     * строку: терялся не повтор, а другое измерение. Разные значения остаются
     * оба, под разными ключами — выбирать за инженера тут нечего.
     */
    const sameKey = params.filter(p => p.key === key || p.key.startsWith(`${key} (`));
    if (sameKey.some(p => p.value === value && p.unit === unit)) continue;
    params.push({
      key: sameKey.length ? `${key} (${sameKey.length + 1})` : key,
      value, unit, sourceGroup: groupCode, sourceKey: typeCode,
    });
  }

  return order.map(title => ({ title, params: byGroup.get(title) || [] })).filter(g => g.params.length > 0);
}

/**
 * Инженерные примечания узла — только его собственные.
 *
 * В выгрузке они лежат в коллекции отчёта как параметр `ptgMEMOES.ptMemoItems`.
 * Примечание принадлежит своему уровню: заметка моноблока — про моноблок, и
 * раздавать её всем блокам внутри нельзя. Тег из чужого примечания повесил бы
 * оборудование не на тот адрес, а разбираться с этим пришлось бы на объекте.
 */
function notesOf(node: any, dict: Record<string, El>): string {
  const out: string[] = [];
  for (const c of childrenByKind(node, dict, 'cadReportCollection')) {
    for (const item of childrenByKind(c.node, dict, 'cadReportCollectionItem')) {
      if (attr(item.el, 'proReportPropGroup') !== 'ptgMEMOES') continue;
      if (attr(item.el, 'proReportPropType') !== 'ptMemoItems') continue;
      const value = attr(item.el, 'proReportPropValue');
      if (value) out.push(value);
    }
  }
  return out.join('\n');
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

/** Позиция ли это: «1.1», «2», «3.4.1» — и ничего кроме */
const isPosition = (s: string) => /^\d+(\.\d+)*$/.test(String(s || '').trim());

// ── Подпозиции блока ────────────────────────────────────────────────────────

/** Узел-кандидат в позиции: что за оборудование и сколько его. */
interface RawPos {
  kind: string;
  role: RoleId;
  title: string;
  /** Сколько штук приходится на ОДИН экземпляр владельца */
  qty: number;
  children: RawPos[];
}

/**
 * Количество из выгрузки, приведённое к одному экземпляру владельца.
 *
 * В файле `cfnAmount` — это ИТОГ по всему блоку, а не «столько на штуку».
 * Сборка вентилятора стоит в количестве 2, и двигатель внутри неё тоже помечен
 * двойкой: двигателей два на два вентилятора, по одному на каждый. Если взять
 * двойку как есть, у каждого вентилятора окажется по два двигателя, и в реестр
 * уедут четыре мотора вместо двух.
 *
 * Делится только нацело: 2 на 2 — это один, а 3 на 2 — это расхождение
 * выгрузки, и выдумывать полтора привода программа не станет. Дробное
 * количество (382.956 м уплотнителя) — признак материала, а не штук.
 */
function perInstance(amount: string, parentQty: number): number {
  const n = Number(String(amount || '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return 1;
  if (!Number.isInteger(n)) return 0;
  if (parentQty > 1 && n % parentQty === 0) return n / parentQty;
  return n;
}

/**
 * Значимое оборудование внутри узла — по закрытому списку видов.
 *
 * В производство (материалы, крепёж, ламели, кассеты фильтра) обход не
 * спускается: `vezaKindSense` отвечает «skip», и ветка целиком остаётся в
 * файле. Незнакомый вид не молчит — он возвращается отдельным списком, чтобы
 * предпросмотр спросил человека, а не решил за него.
 */
function positionsIn(
  node: any,
  dict: Record<string, El>,
  parentQty: number,
  parentRole: RoleId | '',
  unknown: Set<string>,
): RawPos[] {
  const out: RawPos[] = [];
  for (const c of childrenOf(node, dict)) {
    if (c.kind === 'cadReportCollection') continue;
    const sense = vezaKindSense(c.kind);
    if (sense === 'skip') continue;
    if (sense === 'unknown') { if (c.kind) unknown.add(c.kind); continue; }

    const role = vezaRole(c.kind) as RoleId;
    const qty = perInstance(attr(c.el, 'cfnAmount'), parentQty);
    if (qty <= 0) continue; // дробное количество — материал, а не позиция

    /**
     * «Вентилятор ВОСК62-100-01500-06-1-Г-УХЛ2» и «Вентилятор ВОСК62-100»
     * внутри него — один и тот же вентилятор, записанный полным обозначением
     * и типоразмером. Вторая позиция тут означала бы вдвое больше вентиляторов
     * в реестре и вдвое больше требуемых тегов.
     */
    if (VEZA_SAME_ROLE.has(c.kind) && role === parentRole) {
      out.push(...positionsIn(c.node, dict, parentQty, parentRole, unknown));
      continue;
    }

    out.push({
      kind: c.kind,
      role,
      title: attr(c.el, 'cfnName') || roleById(role).title,
      qty,
      children: positionsIn(c.node, dict, qty, role, unknown),
    });
  }
  return out;
}

/**
 * Разделы параметров, принадлежащие роли.
 *
 * Собственных коллекций отчёта у подпозиций в выгрузке нет: всё лежит
 * разделами в коллекции блока. `ptgMOTOR` — данные двигателя, `ptgVARCONN` —
 * клапана. Разделы при этом **остаются и у блока**: карточка блока выглядит
 * как раньше, а подпозиция получает свою копию. Переносить значило бы
 * обеднить привычный вид ради нового.
 */
function groupsForRole(groups: SpecGroup[], role: RoleId): SpecGroup[] {
  const out: SpecGroup[] = [];
  for (const g of groups) {
    const params = (g.params || []).filter(p => vezaGroupRoles(p.sourceGroup || '').includes(role));
    if (params.length) out.push({ title: g.title, params });
  }
  return out;
}

/**
 * Развернуть дерево кандидатов в позиции реестра.
 *
 * Здесь количество превращается в отдельные строки: `cfnAmount=2` у
 * вентилятора — это два вентилятора, у каждого свой тег, свой двигатель и своя
 * судьба в проекте, а не «одна позиция с числом 2». Так просил владелец, и так
 * устроена документация: тег вешают на изделие, а не на строку спецификации.
 *
 * Номер экземпляра считается по роли внутри владельца, а не по узлу: бак и
 * соединитель оба «обвязка», и без общего счётчика их имена совпали бы.
 */
function expand(
  raw: RawPos[],
  parentName: string,
  blockGroups: SpecGroup[],
  detectType: (s: string) => string,
  counter: { at: number },
  out: ParsedBlock[],
): void {
  const total = new Map<RoleId, number>();
  for (const r of raw) total.set(r.role, (total.get(r.role) || 0) + r.qty);
  const seen = new Map<RoleId, number>();

  for (const r of raw) {
    const count = total.get(r.role) || r.qty;
    for (let i = 0; i < r.qty; i++) {
      const no = (seen.get(r.role) || 0) + 1;
      seen.set(r.role, no);
      const name = `${parentName}/${r.role.toLowerCase()}${no}`;
      /**
       * «№2» дописывается только к настоящим одинаковым экземплярам.
       *
       * Номер в имени позиции (`обвязка2`) считается по роли, чтобы имена не
       * столкнулись, а номер в названии — по самому узлу. Бак и соединитель
       * оба «обвязка», но «Соединитель №2» при одном соединителе — враньё:
       * инженер пойдёт искать первый.
       */
      const title = r.qty > 1 ? `${r.title} №${i + 1}` : r.title;
      const groups = groupsForRole(blockGroups, r.role);

      out.push({
        name,
        title,
        equipType: detectType(title) === 'ПРОЧЕЕ' ? r.role : detectType(title),
        groups,
        position: name,
        role: r.role,
        parentName,
        sourceKind: r.kind,
        instanceNo: no,
        instanceCount: count,
        sourceOrder: counter.at++,
      });

      expand(r.children, name, blockGroups, detectType, counter, out);
    }
  }
}

// ── Блок ────────────────────────────────────────────────────────────────────

/**
 * Блок и его подпозиции одним списком.
 *
 * Первым идёт сам блок, дальше — оборудование внутри него в порядке файла.
 * Плоский список, а не дерево: родство держится полем `parentName`, и весь
 * дальнейший путь (план импорта, запись, выгрузка) остаётся тем же, каким был
 * для блоков, — новых веток в нём не заводится.
 */
function parseBlock(
  entry: { el: El; node: any },
  dict: Record<string, El>,
  index: number,
  detectType: (s: string) => string,
  unknown: Set<string>,
): ParsedBlock[] {
  const groups = collectionsOf(entry.node, dict).flatMap(c => c.groups);
  const cfnName = attr(entry.el, 'cfnName');
  const title = paramValue(groups, 'Блок', 'Наименование') || stripBlockPrefix(cfnName) || cfnName || `бл${index + 1}`;

  /**
   * Позиция и заметка — разные вещи, хотя лежат в одном атрибуте.
   *
   * В `cfnNote` чаще всего стоит позиция («1.1»), но иногда туда дописывают
   * текст. Раньше весь `cfnNote` становился ИМЕНЕМ блока: стоило инженеру
   * добавить пояснение, и повторный импорт видел новый блок вместо прежнего —
   * со всей потерянной историей и отвязанными тегами.
   */
  const raw = attr(entry.el, 'cfnNote');
  const fromParams = paramValue(groups, 'Блок', 'Позиция');
  const position = (isPosition(raw) ? raw : '') || fromParams || `бл${index + 1}`;
  const noteParts = [isPosition(raw) ? '' : raw, notesOf(entry.node, dict)].filter(Boolean);
  const note = noteParts.join('\n');

  const block: ParsedBlock = {
    name: position,
    title,
    equipType: detectType(title),
    groups,
    position,
    role: 'БЛОК',
    sourceKind: kindOf(entry.el),
    sourceOrder: 0,
    ...(note ? { note } : {}),
  };

  const counter = { at: 1 };
  const subs: ParsedBlock[] = [];
  expand(positionsIn(entry.node, dict, 1, 'БЛОК', unknown), position, groups, detectType, counter, subs);

  return assignTagsFromNote([block, ...subs], note);
}

/**
 * Раздать теги примечания блоку и его подпозициям.
 *
 * Правило раздачи одно — порядок: первый тег роли достаётся первой позиции
 * этой роли, второй — второй. Подгонки по названию модели нет и не будет:
 * выдумав соответствие один раз, программа ошибалась бы в нём молча и всегда.
 *
 * Расхождения не выравниваются. Три тега привода при двух приводах остаются
 * тремя строками: две привязки и одно «позиции для тега нет» с выбором для
 * человека. Это данные заказчика, а не ошибка разбора.
 */
function assignTagsFromNote(positions: ParsedBlock[], note: string): ParsedBlock[] {
  if (!note.trim()) return positions;

  const slots: TagSlot[] = positions.map(p => ({
    key: p.name,
    role: (p.role || 'ПРОЧЕЕ') as RoleId,
    order: p.sourceOrder || 0,
    ...(p.instanceNo ? { instanceNo: p.instanceNo } : {}),
    title: p.title,
  }));

  // Разбор раздаёт теги, но не судит написание: правила проекта тут ещё
  // неизвестны, а отброшенный тег — это молча потерянная связь. Кириллическую
  // «С» вместо латинской «C» поймает план импорта, когда проект уже выбран
  const { assignments } = distribute(note, slots, PERMISSIVE_TAG_POLICY);
  const byKey = new Map<string, ParsedBlock>(positions.map(p => [p.name, p]));
  const loose: TagEvidence[] = [];

  for (const a of assignments) {
    const evidence: TagEvidence = {
      identifier: a.identifier,
      verdict: a.verdict,
      why: a.why,
      ...(a.fix ? { fix: a.fix } : {}),
      ...(a.role ? { role: a.role } : {}),
      phrase: a.evidence.text,
    };
    const target = a.slotKey ? byKey.get(a.slotKey) : undefined;
    if (!target) { loose.push(evidence); continue; }
    target.tags = [...(target.tags || []), a.identifier];
    target.tagNotes = [...(target.tagNotes || []), evidence];
  }

  // Теги без позиции показываются на блоке: там же лежит примечание, из
  // которого они взяты, и оттуда человеку и решать, куда их деть
  if (loose.length) positions[0].tagNotes = [...(positions[0].tagNotes || []), ...loose];
  return positions;
}

function parseMonoblock(entry: { el: El; node: any }, dict: Record<string, El>, index: number, detectType: (s: string) => string, unknown: Set<string>): ParsedMonoblock {
  const name = attr(entry.el, 'cfnName') || `мн${index + 1}`;
  const groups = collectionsOf(entry.node, dict).flatMap(c => c.groups);
  const note = notesOf(entry.node, dict);
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
    items.forEach((b, i) => blocks.push(...parseBlock(b, dict, i, detectType, unknown)));
  }

  return { name, title: name, blocks, ...(note ? { note } : {}) };
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

  // Виды узлов, которых нет ни в списке оборудования, ни в списке «не позиция».
  // Молчать о них нельзя: завтра САПР назовёт новый аппарат новым словом, и
  // тихо пропавшая позиция обнаружится на объекте, а не в предпросмотре
  const unknown = new Set<string>();

  for (const ordersFolder of childrenByKind(structure, dict, 'cadOrdersFolder')) {
    for (const order of childrenByKind(ordersFolder.node, dict, 'cadOrderFolder')) {
      // Параметры заказа (номер, объект, заказчик, примечания) относятся ко
      // всем установкам файла. Повторить их в каждой — не дублирование ради
      // дублирования: установка уезжает в реестр отдельной строкой, и без
      // номера заказа её потом не с чем связать
      const orderGroups = collectionsOf(order.node, dict).flatMap(c => c.groups);

      for (const unitsFolder of childrenByKind(order.node, dict, 'cadUnitsFolder')) {
        const units = childrenByKind(unitsFolder.node, dict, 'cadUnitFolder');
        units.forEach((u, i) => result.units.push(parseUnit(u, dict, i, orderGroups, detectType, unknown)));
      }
    }
  }

  if (unknown.size) result.unknownKinds = [...unknown].sort();
  return result;
}

function parseUnit(
  entry: { el: El; node: any },
  dict: Record<string, El>,
  index: number,
  orderGroups: SpecGroup[],
  detectType: (s: string) => string,
  unknown: Set<string>,
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
      monoblocks.push(parseMonoblock(m, dict, monoblocks.length, detectType, unknown));
    }
  }

  const note = notesOf(entry.node, dict);
  return {
    name, title, groups, monoblocks,
    tags: designation ? [designation] : [],
    ...(note ? { note } : {}),
  };
}
