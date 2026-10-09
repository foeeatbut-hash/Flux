/**
 * Отмена импорта расчёта.
 *
 * Правило программы: любая массовая запись должна отменяться (skill
 * flux-data-safety §6). У захвата с экрана отмена была, у ввоза расчёта — нет,
 * хотя он меняет именно характеристики, по которым потом заказывают железо.
 *
 * Отменяем по партии: у каждой записи истории есть batchId того ввоза, который
 * её сделал. Собирать партию по времени было нельзя — два импорта подряд
 * слились бы в один.
 *
 * Чужие правки не трогаем. Если после импорта человек уже поправил элемент
 * руками, откат его пропускает и говорит об этом: молча стереть чужую работу
 * хуже, чем не доделать откат.
 */

export interface HistoryRow {
  id: string;
  elementId: string;
  version: number;
  changedAt: string | Date;
  oldSpecs: string | null;
  newSpecs: string | null;
  changeType: string;
}

export interface ElementNow {
  id: string;
  itemCode: string;
  specs: string | null;
  overrides?: string | null;
  version: number;
  where: string;
  /** Состояние для отмены снятия, переезда и переноса тегов (загрузка партии их заполняет) */
  status?: string;
  conflictLog?: string | null;
  monoblockId?: string;
  /** Установка позиции: по ней отмена переименования проверяет, что имя ещё то, что дал ввоз */
  systemId?: string;
  systemName?: string;
  projectId?: string;
}

export type UndoAction = 'restore' | 'remove' | 'skip' | 'reinstate' | 'reremove' | 'unmove' | 'retag' | 'unrename';

export interface UndoItem {
  elementId: string;
  itemCode: string;
  where: string;
  action: UndoAction;
  /** Почему пропускаем — показывается человеку до применения */
  reason?: string;
  /** Значение, которое вернём (только для restore) */
  specs?: string | null;
  version?: number;
  /** unmove: адрес, на который позиция возвращается */
  address?: { monoblockId: string; itemCode: string; parentElementId: string | null };
  /** reremove: что лежало в conflictLog до возврата */
  conflictLog?: string | null;
  /** retag: теги, которые вернутся с новой записи на прежнюю */
  tagIds?: string[];
  toId?: string;
  /** unrename: установка и имя, которое вернётся */
  systemId?: string;
  name?: string;
}

export interface UndoPlan {
  batchId: string;
  restore: UndoItem[];
  remove: UndoItem[];
  skip: UndoItem[];
  /** Снятые этой партией позиции, которые вернутся (статус OK, отметка убрана) */
  reinstate: UndoItem[];
  /** Возвращённые этой партией, которые снова станут снятыми */
  reremove: UndoItem[];
  /** Переехавшие позиции — на прежний адрес */
  unmove: UndoItem[];
  /** «Переподобрано»: теги возвращаются на прежнюю запись */
  retag: UndoItem[];
  /** Переименованные этой партией установки — прежнее имя */
  unrename: UndoItem[];
}

const LIFE = new Set(['REMOVE', 'RESTORE', 'MOVE', 'TAG_MOVE', 'SYS_RENAME']);
const parse = (x: string | null | undefined): any => { try { return x ? JSON.parse(x) : null; } catch (_) { return null; } };

/** Сравнение характеристик по смыслу, а не по строке: пробелы и порядок ключей
 *  в JSON меняются при пересохранении, а данные при этом те же */
function sameSpecs(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  const norm = (x: string | null) => {
    if (!x) return '';
    try {
      const groups = (JSON.parse(x)?.groups || []).map((g: any) => ({
        t: String(g?.title || ''),
        p: (g?.params || []).map((p: any) => `${p?.key}=${p?.value ?? ''}`).sort(),
      }));
      groups.sort((g1: any, g2: any) => g1.t.localeCompare(g2.t));
      return JSON.stringify(groups);
    } catch (_) { return String(x); }
  };
  return norm(a) === norm(b);
}

/**
 * Что сделает отмена: список на возврат, на удаление и на пропуск.
 *
 * Считается до записи, показывается человеку и только потом применяется —
 * прямой записи «по кнопке» в программе быть не должно.
 */
export function planUndo(batchId: string, allRows: HistoryRow[], elements: Map<string, ElementNow>): UndoPlan {
  const plan: UndoPlan = { batchId, restore: [], remove: [], skip: [], reinstate: [], reremove: [], unmove: [], retag: [], unrename: [] };
  const life = allRows.filter(r => LIFE.has(r.changeType));
  const rows = allRows.filter(r => !LIFE.has(r.changeType));

  // Свежие записи первыми: если импорт трогал элемент дважды, возвращаем к
  // тому, что было до первого касания
  const byElement = new Map<string, HistoryRow[]>();
  for (const r of rows) {
    if (!byElement.has(r.elementId)) byElement.set(r.elementId, []);
    byElement.get(r.elementId)!.push(r);
  }

  for (const [elementId, list] of byElement) {
    list.sort((a, b) => new Date(a.changedAt).getTime() - new Date(b.changedAt).getTime());
    const first = list[0];
    const last = list[list.length - 1];
    const el = elements.get(elementId);

    if (!el) {
      plan.skip.push({ elementId, itemCode: '—', where: '', action: 'skip', reason: 'элемента уже нет' });
      continue;
    }

    if (first.changeType === 'CREATE') {
      // Элемент завёл этот импорт. Удаляем, только если после него никто не
      // трогал: иначе человек уже вложил в него работу
      if (!sameSpecs(el.specs, last.newSpecs)) {
        plan.skip.push({ elementId, itemCode: el.itemCode, where: el.where, action: 'skip', reason: 'после импорта его правили вручную' });
      } else {
        plan.remove.push({ elementId, itemCode: el.itemCode, where: el.where, action: 'remove' });
      }
      continue;
    }

    // Обновление: возвращаем то, что было до импорта
    if (!sameSpecs(el.specs, last.newSpecs)) {
      plan.skip.push({ elementId, itemCode: el.itemCode, where: el.where, action: 'skip', reason: 'характеристики уже изменили после импорта' });
      continue;
    }
    plan.restore.push({
      elementId, itemCode: el.itemCode, where: el.where, action: 'restore',
      specs: first.oldSpecs, version: first.version,
    });
  }

  planLife(plan, life, elements, batchId);

  const byCode = (a: UndoItem, b: UndoItem) => a.itemCode.localeCompare(b.itemCode, 'ru');
  for (const l of [plan.restore, plan.remove, plan.skip, plan.reinstate, plan.reremove, plan.unmove, plan.retag, plan.unrename]) l.sort(byCode);
  return plan;
}

/**
 * Снятие, возврат, переезд и перенос тегов — то, что партия сделала с жизнью
 * записи, а не с её характеристиками. Правило то же: чужую работу не трогаем.
 */
function planLife(plan: UndoPlan, rows: HistoryRow[], elements: Map<string, ElementNow>, batchId: string): void {
  const sorted = [...rows].sort((a, b) => new Date(a.changedAt).getTime() - new Date(b.changedAt).getTime());
  const item = (el: ElementNow | undefined, id: string, action: UndoAction, extra: Partial<UndoItem> = {}): UndoItem =>
    ({ elementId: id, itemCode: el?.itemCode || '—', where: el?.where || '', action, ...extra });
  const skip = (el: ElementNow | undefined, id: string, reason: string) => plan.skip.push(item(el, id, 'skip', { reason }));
  const firstLast = (type: string) => {
    const by = new Map<string, HistoryRow[]>();
    for (const r of sorted) if (r.changeType === type) (by.get(r.elementId) ?? by.set(r.elementId, []).get(r.elementId)!).push(r);
    return by;
  };

  for (const [id, list] of firstLast('REMOVE')) {
    const el = elements.get(id);
    if (!el) { skip(el, id, 'позиции уже нет'); continue; }
    if (el.status !== 'REMOVED') { skip(el, id, 'позицию уже вернули'); continue; }
    if (parse(el.conflictLog)?.__removal?.batchId !== batchId) { skip(el, id, 'позицию сняла другая партия'); continue; }
    plan.reinstate.push(item(el, id, 'reinstate'));
  }
  for (const [id, list] of firstLast('RESTORE')) {
    const el = elements.get(id);
    if (!el) { skip(el, id, 'позиции уже нет'); continue; }
    if (el.status === 'REMOVED') { skip(el, id, 'позицию уже сняли'); continue; }
    plan.reremove.push(item(el, id, 'reremove', { conflictLog: list[0].oldSpecs }));
  }
  for (const [id, list] of firstLast('MOVE')) {
    const el = elements.get(id);
    if (!el) { skip(el, id, 'позиции уже нет'); continue; }
    const was = parse(list[0].oldSpecs), now = parse(list[list.length - 1].newSpecs);
    if (!was || !now) continue;
    if (el.monoblockId !== now.monoblockId || el.itemCode !== now.itemCode) { skip(el, id, 'после импорта её уже переносили'); continue; }
    plan.unmove.push(item(el, id, 'unmove', { address: was }));
  }
  for (const [id, list] of firstLast('SYS_RENAME')) {
    const el = elements.get(id);
    const was = parse(list[0].oldSpecs), now = parse(list[list.length - 1].newSpecs);
    if (!el || !was || !now) { skip(el, id, 'позиции установки уже нет'); continue; }
    if (el.systemName !== now.name) { skip(el, id, 'после импорта установку переименовали ещё раз'); continue; }
    plan.unrename.push(item(el, id, 'unrename', { systemId: was.systemId, name: was.name }));
  }
  for (const [id, list] of firstLast('TAG_MOVE')) {
    const was = parse(list[0].oldSpecs), now = parse(list[list.length - 1].newSpecs);
    if (!was?.tagIds?.length || !now?.elementId) continue;
    plan.retag.push(item(elements.get(id), id, 'retag', { tagIds: was.tagIds, toId: now.elementId }));
  }
}

/** Момент импорта, зашитый в идентификатор партии: imp-<мс>-<хвост> */
export function batchTime(batchId: string): number {
  const m = /^imp-(\d+)-/.exec(String(batchId || ''));
  return m ? Number(m[1]) : 0;
}

/** Короткая сводка для подтверждения человеком */
export function describePlan(plan: UndoPlan): string {
  const parts: string[] = [];
  if (plan.restore.length) parts.push(`вернём характеристики: ${plan.restore.length}`);
  if (plan.remove.length) parts.push(`удалим заведённые импортом: ${plan.remove.length}`);
  if (plan.reinstate.length) parts.push(`вернём снятые: ${plan.reinstate.length}`);
  if (plan.reremove.length) parts.push(`снимем снова возвращённые: ${plan.reremove.length}`);
  if (plan.unrename.length) parts.push(`вернём прежние имена установок: ${plan.unrename.length}`);
  if (plan.unmove.length) parts.push(`вернём на прежний адрес: ${plan.unmove.length}`);
  if (plan.retag.length) parts.push(`вернём теги прежним записям: ${plan.retag.length}`);
  if (plan.skip.length) parts.push(`пропустим (уже правили): ${plan.skip.length}`);
  return parts.length ? parts.join(', ') : 'отменять нечего';
}
