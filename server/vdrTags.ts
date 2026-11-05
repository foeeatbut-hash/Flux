/**
 * ВДР ↔ теги по id (docs/docflow-integration.md, этап A).
 *
 * Строка реестра раньше знала тег только по коду, записанному строкой в
 * `DocRegisterItem.equipmentTags`: тег переименовали — связь порвалась, а
 * «Документы» у тега потеряли строку. Теперь ключ связи — `Tag.id`
 * (`DocRegisterItemTag`); JSON с кодами остаётся отображаемой копией и тем, что
 * читают экспорт, Office и клиенты: он не удаляется, пока владелец не решит иначе.
 *
 * Правила, которые держат модуль:
 *  • код → тег сопоставляется строго: тот же код без учёта регистра и пробелов
 *    по краям (`tagCodeKey`, как проверка уникальности кода). «AHU-2» и «AHU2»
 *    — разные коды, сходство по написанию не угадывается (flux-data-safety, п. 5);
 *  • код, под которым в проекте два тега, не связывается — решает человек;
 *  • «All items»/«Все позиции» — не тег, а отметка «документ на все позиции»;
 *  • связь с удалённым тегом остаётся (копия `tagIdentifier`), пока код есть в
 *    строке; строка не удаляется никогда;
 *  • массовый перенос идёт через план: сначала считается, что будет связано и
 *    что нет, запись — по подтверждению с тем же отпечатком плана, и отменяется
 *    по списку созданных связей.
 *
 * Все функции получают клиент `db`: и сам Prisma, и клиент транзакции.
 */

import { createHash } from 'node:crypto';
import { tagCodeKey } from './tagWrite.js';

/** Отметка «документ относится ко всем позициям» — не тег, в связях не участвует. */
const GENERIC_CODES = new Set(['all items', 'все позиции']);
export const isGenericTagCode = (code: string): boolean => GENERIC_CODES.has(tagCodeKey(code));

/** Коды из JSON-поля строки: только непустые строки без пробелов по краям. */
export function codesOfItem(raw: unknown): string[] {
  let v: unknown = raw;
  if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch { v = []; } }
  return Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean) : [];
}

interface TagRef { id: string; identifier: string }
interface LinkRow { itemId: string; tagId: string; tagIdentifier: string }

/** Теги проекта по ключу кода: больше одного под ключом — неоднозначность. */
function indexTags(tags: TagRef[]): Map<string, TagRef[]> {
  const by = new Map<string, TagRef[]>();
  for (const t of tags) {
    const key = tagCodeKey(t.identifier);
    if (key) by.set(key, [...(by.get(key) || []), t]);
  }
  return by;
}

export interface ItemTagVerdict {
  /** Связи, которые нужно добавить: код найден в Тегах ровно один раз */
  toLink: { code: string; tagId: string; identifier: string }[];
  /** Коды, которых нет в Тегах проекта */
  unmatched: string[];
  /** Коды, под которыми в проекте больше одного тега */
  ambiguous: string[];
  /** Коды, уже покрытые связью */
  linked: number;
  /** Отметки «на все позиции» */
  generic: number;
}

/**
 * Разбор кодов одной строки против тегов проекта и её текущих связей.
 * Чистая функция: ни базы, ни побочных эффектов.
 */
export function judgeItemCodes(codes: string[], tagsByKey: Map<string, TagRef[]>, links: LinkRow[]): ItemTagVerdict {
  const covered = new Set(links.map(l => tagCodeKey(l.tagIdentifier)));
  const out: ItemTagVerdict = { toLink: [], unmatched: [], ambiguous: [], linked: 0, generic: 0 };
  const seen = new Set<string>();
  for (const code of codes) {
    const key = tagCodeKey(code);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isGenericTagCode(code)) { out.generic++; continue; }
    if (covered.has(key)) { out.linked++; continue; }
    const found = tagsByKey.get(key) || [];
    if (found.length === 1) out.toLink.push({ code, tagId: found[0].id, identifier: found[0].identifier });
    else if (found.length > 1) out.ambiguous.push(code);
    else out.unmatched.push(code);
  }
  return out;
}

/**
 * Привести связи строки к списку её кодов (вызывается при каждой записи
 * `equipmentTags`): добавить связи для найденных кодов, снять связи, чьих кодов
 * в строке больше нет. Ненайденные коды остаются только в JSON.
 */
export async function syncItemTags(db: any, item: { id: string; projectId: string }, equipmentTags: unknown): Promise<void> {
  const codes = codesOfItem(equipmentTags);
  const links: LinkRow[] = await db.docRegisterItemTag.findMany({ where: { itemId: item.id } });
  const tags: TagRef[] = codes.length ? await db.tag.findMany({ where: { projectId: item.projectId }, select: { id: true, identifier: true } }) : [];
  const verdict = judgeItemCodes(codes, indexTags(tags), links);
  const wanted = new Set(codes.map(tagCodeKey));
  for (const l of links) if (!wanted.has(tagCodeKey(l.tagIdentifier))) await db.docRegisterItemTag.deleteMany({ where: { itemId: item.id, tagId: l.tagId } });
  for (const add of verdict.toLink) {
    const has = links.some(l => l.tagId === add.tagId);
    if (!has) await db.docRegisterItemTag.create({ data: { itemId: item.id, tagId: add.tagId, tagIdentifier: add.identifier } });
  }
}

/**
 * Тег переименован: копия кода в связях и код в JSON связанных строк
 * обновляются, связь по id остаётся. Вызывается в той же транзакции, что и
 * сама запись тега.
 */
export async function renameTagInVdr(db: any, tagId: string, oldCode: string, newCode: string): Promise<void> {
  // Проверки на заглушках без таблицы связей и старые базы до миграции: связей нет — менять нечего
  if (!db?.docRegisterItemTag?.findMany) return;
  const links: LinkRow[] = await db.docRegisterItemTag.findMany({ where: { tagId } });
  if (!links.length) return;
  await db.docRegisterItemTag.updateMany({ where: { tagId }, data: { tagIdentifier: newCode } });
  const oldKey = tagCodeKey(oldCode);
  const items = await db.docRegisterItem.findMany({ where: { id: { in: links.map(l => l.itemId) } }, select: { id: true, equipmentTags: true } });
  for (const it of items) {
    const codes = codesOfItem(it.equipmentTags);
    if (!codes.some(c => tagCodeKey(c) === oldKey)) continue;
    const next = codes.map(c => tagCodeKey(c) === oldKey ? newCode : c);
    await db.docRegisterItem.updateMany({ where: { id: it.id }, data: { equipmentTags: JSON.stringify(next) } });
  }
}

/** Связи строк: itemId → [{ tagId, identifier }]. */
export async function linksOfItems(db: any, itemIds: string[]): Promise<Map<string, { tagId: string; identifier: string }[]>> {
  const out = new Map<string, { tagId: string; identifier: string }[]>();
  if (!itemIds.length) return out;
  const rows: LinkRow[] = await db.docRegisterItemTag.findMany({ where: { itemId: { in: itemIds } } });
  for (const r of rows) out.set(r.itemId, [...(out.get(r.itemId) || []), { tagId: r.tagId, identifier: r.tagIdentifier }]);
  return out;
}

/** Коды строки, не покрытые связью и не «на все позиции»: их показывает карточка и счётчик. */
export function unmatchedCodesOf(equipmentTags: unknown, links: { identifier: string }[]): string[] {
  const covered = new Set(links.map(l => tagCodeKey(l.identifier)));
  return codesOfItem(equipmentTags).filter(c => !isGenericTagCode(c) && !covered.has(tagCodeKey(c)));
}

// ── План переноса ────────────────────────────────────────────────────────────

export interface TagLinkPlan {
  projectId: string;
  /** Строк с кодами тегов */
  items: number;
  toLink: { itemId: string; itemNo: string; registerName: string; code: string; tagId: string; identifier: string }[];
  alreadyLinked: number;
  unmatched: { itemId: string; itemNo: string; registerName: string; code: string }[];
  ambiguous: { itemId: string; itemNo: string; registerName: string; code: string }[];
  generic: number;
  /** Связи с тегами, которых в проекте больше нет */
  orphaned: number;
  /** Отпечаток «что будет записано»: применение с другим отпечатком отклоняется */
  digest: string;
}

/**
 * План переноса `equipmentTags` в связи по id. Ничего не пишет. Реестры и
 * строки берутся целиком по проекту: план — про проект, а не про открытый реестр.
 */
export async function planTagLinks(db: any, projectId: string): Promise<TagLinkPlan> {
  const registers: any[] = await db.docRegister.findMany({ where: { projectId }, select: { id: true, name: true } });
  const regName = new Map(registers.map(r => [r.id, String(r.name || 'ВДР')]));
  const items: any[] = await db.docRegisterItem.findMany({
    where: { projectId }, select: { id: true, registerId: true, contractorNo: true, titleRu: true, equipmentTags: true },
    orderBy: [{ registerId: 'asc' }, { contractorNo: 'asc' }, { id: 'asc' }],
  });
  const tags: TagRef[] = await db.tag.findMany({ where: { projectId }, select: { id: true, identifier: true } });
  const links: LinkRow[] = items.length ? await db.docRegisterItemTag.findMany({ where: { itemId: { in: items.map(i => i.id) } } }) : [];
  const byItem = new Map<string, LinkRow[]>();
  for (const l of links) byItem.set(l.itemId, [...(byItem.get(l.itemId) || []), l]);
  const tagIds = new Set(tags.map(t => t.id));
  const index = indexTags(tags);

  const plan: TagLinkPlan = { projectId, items: 0, toLink: [], alreadyLinked: 0, unmatched: [], ambiguous: [], generic: 0, orphaned: links.filter(l => !tagIds.has(l.tagId)).length, digest: '' };
  for (const it of items) {
    const codes = codesOfItem(it.equipmentTags);
    if (!codes.length) continue;
    plan.items++;
    const where = { itemId: it.id as string, itemNo: String(it.contractorNo || it.titleRu || ''), registerName: regName.get(it.registerId) || 'ВДР' };
    const v = judgeItemCodes(codes, index, byItem.get(it.id) || []);
    plan.alreadyLinked += v.linked;
    plan.generic += v.generic;
    for (const a of v.toLink) plan.toLink.push({ ...where, ...a });
    for (const code of v.unmatched) plan.unmatched.push({ ...where, code });
    for (const code of v.ambiguous) plan.ambiguous.push({ ...where, code });
  }
  plan.digest = createHash('sha256').update(JSON.stringify(plan.toLink.map(l => [l.itemId, l.tagId]))).digest('hex').slice(0, 16);
  return plan;
}

/** Запись плана: создаёт только недостающие связи. Возвращает созданные пары — по ним отменяется. */
export async function applyTagLinks(db: any, plan: TagLinkPlan): Promise<{ itemId: string; tagId: string }[]> {
  const created: { itemId: string; tagId: string }[] = [];
  for (const l of plan.toLink) {
    const has = await db.docRegisterItemTag.findFirst({ where: { itemId: l.itemId, tagId: l.tagId } });
    if (has) continue;
    await db.docRegisterItemTag.create({ data: { itemId: l.itemId, tagId: l.tagId, tagIdentifier: l.identifier } });
    created.push({ itemId: l.itemId, tagId: l.tagId });
  }
  return created;
}

/** Отмена: снимает только перечисленные связи. JSON строк перенос не менял, возвращать там нечего. */
export async function undoTagLinks(db: any, created: { itemId: string; tagId: string }[]): Promise<number> {
  let removed = 0;
  for (const c of created) removed += (await db.docRegisterItemTag.deleteMany({ where: { itemId: String(c.itemId), tagId: String(c.tagId) } })).count;
  return removed;
}
