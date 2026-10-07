/**
 * Проверка проекта и лист изменений.
 *
 * Правила намеренно живут отдельно от запросов к базе и работают над готовым
 * срезом (`ProjectSnapshot`): так каждое из них — обычная функция, которую
 * можно проверить скриптом, а не «посмотреть глазами в интерфейсе».
 *
 * Главный принцип отбора правил: замечание должно быть таким, что инженер
 * скажет «да, это надо поправить». Правило, которое срабатывает часто и без
 * дела, обесценивает весь список — его перестают открывать, и тогда пропадают и
 * настоящие находки. Поэтому шумные проверки либо не включены, либо стоят в
 * последней степени важности.
 */
import type { ProjectSnapshot, ElementLite, TagLite } from './insight';

export type Severity = 'critical' | 'warning' | 'info';

export interface Finding {
  id: string;
  title: string;
  subtitle: string;
  route: string;
}

export interface CheckGroup {
  id: string;
  title: string;
  /** Почему это важно — одна фраза человеческим языком */
  why: string;
  severity: Severity;
  count: number;
  findings: Finding[];
}

export interface CheckResult {
  projectId: string;
  projectName: string;
  at: string;
  total: number;
  critical: number;
  warning: number;
  info: number;
  groups: CheckGroup[];
  /** Скрытые правила со счётчиком — чтобы их можно было вернуть там же, где прятали */
  hidden: { id: string; title: string; count: number }[];
}

/**
 * Ключевые характеристики по типу оборудования.
 *
 * Список нарочно короткий: только то, без чего позицию нельзя ни заказать, ни
 * посчитать. Сравнение — по вхождению слова, а не по точному совпадению:
 * подписи из разных бланков пишут по-разному («Расход воздуха», «Расход, м3/ч»).
 */
export const KEY_PARAMS: Record<string, string[]> = {
  'ВЕНТИЛЯТОР': ['расход', 'давлен'],
  'НАГРЕВАТЕЛЬ': ['мощност'],
  'ОХЛАДИТЕЛЬ': ['мощност'],
  'ФИЛЬТР': ['класс'],
  'КЛАПАН': ['размер'],
  'ШУМОГЛУШИТЕЛЬ': ['размер'],
};

const norm = (s: string) => String(s || '').toLowerCase().replace(/ё/g, 'е');

/** Заполнен ли у элемента параметр, в названии которого есть это слово */
export function hasParam(el: ElementLite, needle: string): boolean {
  const n = norm(needle);
  return el.params.some(p => norm(p.key).includes(n) && String(p.value || '').trim() !== '');
}

/** Каких ключевых характеристик не хватает элементу */
export function missingKeyParams(el: ElementLite): string[] {
  const need = KEY_PARAMS[el.equipType] || [];
  return need.filter(n => !hasParam(el, n));
}

const dayMs = 24 * 60 * 60 * 1000;

/** Сколько дней прошло; null — даты нет */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return null;
  return Math.floor((Date.now() - t) / dayMs);
}

const RU_CONFLICT: Record<string, string> = {
  ORPHANED_TAG: 'тег остался без своего элемента',
  TYPE_MISMATCH: 'тип оборудования не совпал с прежним',
};

export interface CheckOptions {
  /** Сколько дней на этапе закупки считать «зависло» */
  stuckDays?: number;
  /** Идентификаторы правил, отключённых человеком */
  muted?: string[];
}

/**
 * Все замечания по проекту, сгруппированные по правилам.
 *
 * Пустые группы не возвращаются: список должен состоять только из того, что
 * действительно требует внимания, иначе на нём не задерживается взгляд.
 */
export function projectCheck(snap: ProjectSnapshot, opts: CheckOptions = {}): CheckResult {
  const stuckDays = opts.stuckDays ?? 21;
  const muted = new Set(opts.muted || []);
  const groups: CheckGroup[] = [];
  const hidden: { id: string; title: string; count: number }[] = [];

  // Скрытое правило всё равно считается: иначе человек не узнает, что именно
  // он перестал видеть, и «вернуть» превратится в лотерею
  const add = (g: Omit<CheckGroup, 'count'>) => {
    if (g.findings.length === 0) return;
    if (muted.has(g.id)) { hidden.push({ id: g.id, title: g.title, count: g.findings.length }); return; }
    groups.push({ ...g, count: g.findings.length });
  };

  const elRoute = (e: ElementLite) => `/equipment?element=${encodeURIComponent(e.id)}`;
  const tagRoute = (t: TagLite) => `/registry?focus=${encodeURIComponent(t.id)}`;
  const elWhere = (e: ElementLite) => `${e.systemName} · ${e.monoblockName}`;

  // 1. Конфликты после импорта расчёта — это уже посчитано программой при
  // импорте, но видно только внутри карточки, и такие элементы месяцами
  // остаются незамеченными
  add({
    id: 'element-conflict',
    title: 'Элементы с конфликтом после импорта',
    why: 'Программа при импорте расчёта не смогла сопоставить данные сама — пока конфликт не разрешён, характеристики элемента ненадёжны.',
    severity: 'critical',
    findings: snap.elements.filter(e => e.hasConflict).map(e => ({
      id: e.id, title: e.itemCode,
      subtitle: `${elWhere(e)} · ${RU_CONFLICT[e.conflictType] || 'конфликт данных'}`,
      route: elRoute(e),
    })),
  });

  // 2. Расхождения значений после ревизии: старое и новое лежат рядом и ждут
  // человека, а расчёт тем временем идёт по старому
  add({
    id: 'param-conflict',
    title: 'Характеристики ждут решения',
    why: 'После новой ревизии расчёта значения разошлись. Пока не выбрано, какое верно, спецификация считается по старому.',
    severity: 'critical',
    findings: snap.elements.filter(e => e.paramConflicts.length > 0).map(e => ({
      id: e.id, title: e.itemCode,
      subtitle: `${elWhere(e)} · ${e.paramConflicts.length} ${plural(e.paramConflicts.length, 'значение', 'значения', 'значений')}: ` +
        e.paramConflicts.slice(0, 3).map(c => c.key).join(', '),
      route: elRoute(e),
    })),
  });

  // 3. Дубли обозначений — два тега с одним кодом расходятся в данных, и какой
  // из них попал в документ, узнать потом невозможно
  const byCode = new Map<string, TagLite[]>();
  for (const t of snap.tags) {
    const code = t.identifier.trim();
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code)!.push(t);
  }
  add({
    id: 'duplicate-tag',
    title: 'Одинаковые обозначения тегов',
    why: 'Два тега с одним кодом расходятся в данных, и по документу уже не понять, какой из них имелся в виду.',
    severity: 'critical',
    findings: [...byCode.entries()].filter(([, list]) => list.length > 1).map(([code, list]) => ({
      id: code, title: code,
      subtitle: `${list.length} карточки с этим кодом`,
      route: `/registry?dup=${encodeURIComponent(code)}`,
    })),
  });

  // 4. Тег есть, оборудования под ним нет — обычно недоделанный импорт или
  // опечатка в коде
  const taggedIds = new Set<string>();
  const taggedCodes = new Set<string>();
  for (const e of snap.elements) {
    for (const id of e.tagIds) taggedIds.add(id);
    for (const c of e.tagCodes) taggedCodes.add(c.trim());
  }
  add({
    id: 'tag-without-equipment',
    title: 'Теги без оборудования',
    why: 'Обозначение заведено, но ни один элемент на него не ссылается: чаще всего это опечатка в коде или незаконченный импорт.',
    severity: 'warning',
    findings: snap.tags
      .filter(t => t.identifier.trim() && !taggedIds.has(t.id) && !taggedCodes.has(t.identifier.trim()))
      .map(t => ({
        id: t.id, title: t.identifier,
        subtitle: [t.mainName, t.department].filter(Boolean).join(' · ') || 'нет привязанных элементов',
        route: tagRoute(t),
      })),
  });

  // 5. Обратная сторона: элемент есть, обозначения нет — такой в спецификацию
  // не попадёт
  add({
    id: 'element-without-tag',
    title: 'Оборудование без тега',
    why: 'Элемент не попадёт ни в спецификацию, ни в закупку: там всё считается по обозначениям.',
    severity: 'warning',
    findings: snap.elements.filter(e => e.tagIds.length === 0 && e.tagCodes.length === 0).map(e => ({
      id: e.id, title: e.itemCode, subtitle: `${elWhere(e)} · ${e.equipType.toLowerCase()}`,
      route: elRoute(e),
    })),
  });

  // 6. Ключевые характеристики пустые — заказать позицию нельзя
  add({
    id: 'missing-key-params',
    title: 'Не заполнены ключевые характеристики',
    why: 'По такой позиции нельзя ни выпустить опросный лист, ни сравнить предложения поставщиков.',
    severity: 'warning',
    findings: snap.elements
      .map(e => ({ e, miss: missingKeyParams(e) }))
      .filter(x => x.miss.length > 0)
      .map(({ e, miss }) => ({
        id: e.id, title: e.itemCode,
        subtitle: `${elWhere(e)} · нет: ${miss.join(', ')}`,
        route: elRoute(e),
      })),
  });

  // 7. Позиции, не сдвинувшиеся с первого этапа
  add({
    id: 'not-ordered',
    title: 'Позиции не заказаны',
    why: 'Позиция стоит на первом этапе закупки — по срокам поставки это обычно самое узкое место проекта.',
    severity: 'warning',
    findings: snap.tags.filter(t => t.stageIsFirst && t.identifier.trim()).map(t => ({
      id: t.id, title: t.identifier,
      subtitle: [t.mainName, t.brand].filter(Boolean).join(' · ') || `этап «${t.stageLabel}»`,
      route: tagRoute(t),
    })),
  });

  // 8. Зависшие на промежуточном этапе — про них обычно и забывают
  add({
    id: 'stuck-stage',
    title: `Закупка стоит дольше ${stuckDays} дней`,
    why: 'Позиция давно не двигалась по этапам. Обычно это значит, что ответа от поставщика так и не дождались.',
    severity: 'info',
    findings: snap.tags
      .filter(t => !t.stageIsFirst && !t.stageIsFinal)
      .map(t => ({ t, d: daysSince(t.stageSince) }))
      .filter(x => x.d !== null && x.d >= stuckDays)
      .map(({ t, d }) => ({
        id: t.id, title: t.identifier,
        subtitle: `этап «${t.stageLabel}» — ${d} ${plural(d as number, 'день', 'дня', 'дней')}${t.supplier ? ' · ' + t.supplier : ''}`,
        route: tagRoute(t),
      })),
  });

  // 9. Тег с критическим описанием — человек сам пометил, что здесь беда
  add({
    id: 'tag-critical',
    title: 'Теги с критическим примечанием',
    why: 'Кто-то из инженеров отметил проблему прямо в карточке. Такие пометки теряются в реестре из сотен позиций.',
    severity: 'critical',
    findings: snap.tags.filter(t => t.actuality === 'critical').map(t => ({
      id: t.id, title: t.identifier,
      subtitle: t.mainName || 'критическое примечание в карточке',
      route: tagRoute(t),
    })),
  });

  // 10. ВДР: замечания заказчика
  add({
    id: 'vdr-remarks',
    title: 'Документы с замечаниями заказчика',
    why: 'По строке пришли замечания — до их снятия документ не считается выпущенным.',
    severity: 'critical',
    findings: snap.vdr.filter(v => v.status === 'REMARKS').map(v => ({
      id: v.id, title: `${v.contractorNo || v.vdrCode || '—'} · ${v.titleRu}`,
      subtitle: `${v.registerName} · рев. ${v.revision}`,
      route: `/management?vdr=${encodeURIComponent(v.registerId)}&item=${encodeURIComponent(v.id)}`,
    })),
  });

  // 11. ВДР: просроченный срок следующей ревизии
  add({
    id: 'vdr-overdue',
    title: 'Просроченные сроки по ВДР',
    why: 'Срок следующей ревизии прошёл. Это первое, что заказчик увидит в отчёте по документообороту.',
    severity: 'warning',
    findings: snap.vdr
      .map(v => ({ v, d: daysSince(v.dueDate) }))
      .filter(x => x.d !== null && (x.d as number) > 0 && x.v.status !== 'ACCEPTED')
      .map(({ v, d }) => ({
        id: v.id, title: `${v.contractorNo || v.vdrCode || '—'} · ${v.titleRu}`,
        subtitle: `просрочен на ${d} ${plural(d as number, 'день', 'дня', 'дней')} · ${v.registerName}`,
        route: `/management?vdr=${encodeURIComponent(v.registerId)}&item=${encodeURIComponent(v.id)}`,
      })),
  });

  // 12. Строка реестра готова, а документа за ней нет
  add({
    id: 'vdr-without-doc',
    title: 'Строки ВДР без документа',
    why: 'Строка помечена готовой, но документ к ней не привязан — выпускать нечего.',
    severity: 'warning',
    findings: snap.vdr.filter(v => (v.status === 'READY' || v.status === 'ACCEPTED') && !v.docId).map(v => ({
      id: v.id, title: `${v.contractorNo || v.vdrCode || '—'} · ${v.titleRu}`,
      subtitle: `${v.registerName} · статус ${v.status === 'READY' ? 'готов' : 'принят'}`,
      route: `/management?vdr=${encodeURIComponent(v.registerId)}&item=${encodeURIComponent(v.id)}`,
    })),
  });

  // 13. Тег без марки — мелочь, но именно её не хватает в спецификации
  add({
    id: 'tag-without-brand',
    title: 'Теги без марки',
    why: 'В спецификацию такая позиция уйдёт без марки оборудования — заказчик вернёт.',
    severity: 'info',
    findings: snap.tags.filter(t => t.identifier.trim() && !t.brand.trim()).map(t => ({
      id: t.id, title: t.identifier, subtitle: t.mainName || 'марка не заполнена',
      route: tagRoute(t),
    })),
  });

  const order: Severity[] = ['critical', 'warning', 'info'];
  groups.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || b.count - a.count);

  const sum = (s: Severity) => groups.filter(g => g.severity === s).reduce((n, g) => n + g.count, 0);
  return {
    projectId: snap.projectId,
    projectName: snap.projectName,
    at: new Date().toISOString(),
    total: groups.reduce((n, g) => n + g.count, 0),
    critical: sum('critical'), warning: sum('warning'), info: sum('info'),
    groups,
    hidden,
  };
}

/** Русское склонение числительных — без него подписи выглядят машинными */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  if (a >= 11 && a <= 14) return many;
  const b = a % 10;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

// ── Лист изменений ──────────────────────────────────────────────────────────

export interface ParamChange {
  group: string;
  key: string;
  was: string;
  now: string;
  kind: 'added' | 'removed' | 'changed';
}

export interface ChangeEntry {
  id: string;
  at: string;
  /** Элемент, к которому относится запись — по нему открываются его связи */
  elementId: string;
  itemCode: string;
  where: string;
  version: number;
  changeType: string;
  changes: ParamChange[];
  route: string;
}

export interface ChangeList {
  since: string | null;
  until: string;
  total: number;
  entries: ChangeEntry[];
}

interface FlatSpecs { [path: string]: { group: string; key: string; value: string } }

/** Характеристики в плоский вид «группа|ключ» — так их можно сравнивать */
export function flatten(specsJson: any): FlatSpecs {
  const out: FlatSpecs = {};
  let parsed: any = null;
  try { parsed = typeof specsJson === 'string' ? JSON.parse(specsJson) : specsJson; } catch (_) { return out; }
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
  for (const g of groups) {
    const group = String(g?.title || '');
    for (const p of (g?.params || [])) {
      if (!p?.key) continue;
      out[`${group}|${p.key}`] = { group, key: String(p.key), value: String(p.value ?? '') };
    }
  }
  return out;
}

/**
 * Что изменилось между двумя снимками характеристик.
 *
 * Сравниваем по паре «группа + название», а не по порядку: при импорте порядок
 * параметров меняется, и сравнение по позиции показывало бы изменённым весь
 * список целиком.
 */
export function diffSpecs(oldJson: any, newJson: any): ParamChange[] {
  const a = flatten(oldJson);
  const b = flatten(newJson);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: ParamChange[] = [];
  for (const k of keys) {
    const was = a[k]?.value ?? '';
    const now = b[k]?.value ?? '';
    if (was === now) continue;
    const meta = b[k] || a[k];
    out.push({
      group: meta.group, key: meta.key, was, now,
      kind: !(k in a) ? 'added' : !(k in b) ? 'removed' : 'changed',
    });
  }
  return out.sort((x, y) => x.group.localeCompare(y.group, 'ru') || x.key.localeCompare(y.key, 'ru'));
}

const RU_CHANGE: Record<string, string> = { CREATE: 'заведён', UPDATE: 'изменён', DELETE: 'удалён', REMOVE: 'снят' };

/**
 * Лист изменений по истории оборудования.
 *
 * Записи без единого изменённого значения выбрасываются: в истории остаются
 * сохранения, где поменялось что-то служебное, и в листе они выглядели бы
 * пустыми строками.
 */
export function changeList(rows: any[], since: string | null, elementsById: Map<string, ElementLite>): ChangeList {
  const entries: ChangeEntry[] = [];
  for (const r of rows) {
    const el = elementsById.get(r.elementId);
    const changes = diffSpecs(r.oldSpecs, r.newSpecs);
    if (changes.length === 0 && r.changeType === 'UPDATE') continue;
    entries.push({
      id: r.id,
      at: r.changedAt ? new Date(r.changedAt).toISOString() : '',
      elementId: el?.id || '',
      itemCode: el?.itemCode || '—',
      where: el ? `${el.systemName} · ${el.monoblockName}` : '',
      version: Number(r.version || 0),
      changeType: RU_CHANGE[String(r.changeType)] || String(r.changeType || ''),
      changes,
      route: el ? `/equipment?element=${encodeURIComponent(el.id)}` : '',
    });
  }
  return {
    since,
    until: new Date().toISOString(),
    total: entries.reduce((n, e) => n + Math.max(1, e.changes.length), 0),
    entries,
  };
}
