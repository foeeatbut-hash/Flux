/**
 * Что из открытого у коллег принадлежит удаляемому проекту.
 *
 * Обратный обход: от свежих отметок чужих окон (их мало) к проекту, а не от
 * проекта к его записям (в проекте могут быть десятки тысяч тегов). Результат —
 * вложенные записи для `openCheck.cascade` (server/versionGuard.ts), с названиями
 * для текста отказа.
 */

import { findFreshOpenRefs, type OpenRef } from './openRecords.js';

const CHUNK = 400;

const nameOf = (r: any): string => String(r?.name || r?.itemCode || '').trim();

function* parts<T>(items: T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += CHUNK) yield items.slice(i, i + CHUNK);
}

/** Отметки по модели: id → запись `db`, оставляя те, у которых `owns(row)` верно. */
async function owned(
  db: any, delegate: string, ids: string[], select: Record<string, unknown>, owns: (row: any) => boolean, label: (row: any) => string, model: string,
): Promise<OpenRef[]> {
  const out: OpenRef[] = [];
  for (const part of parts(ids)) {
    const rows = await db[delegate].findMany({ where: { id: { in: part } }, select });
    for (const row of rows) if (owns(row)) out.push({ model, id: row.id, name: label(row) });
  }
  return out;
}

/**
 * Открытые у других записи проекта: теги, установки, блоки, позиции, реестры
 * ВДР и их строки, пункты справочников. Сам проект не входит — его проверяет
 * `guardedDelete`. Порядок — как перечислено: крупное раньше вложенного.
 */
export async function projectOpenCascade(db: any, userId: string, projectId: string): Promise<OpenRef[]> {
  const fresh = await findFreshOpenRefs(db, { userId });
  if (!fresh.length) return [];
  const idsOf = (model: string) => fresh.filter((r) => r.model === model).map((r) => r.id);
  const out: OpenRef[] = [];
  out.push(...await owned(db, 'tag', idsOf('Tag'), { id: true, projectId: true, identifier: true },
    (r) => r.projectId === projectId, (r) => String(r.identifier || '').trim(), 'Tag'));
  out.push(...await owned(db, 'equipmentSystem', idsOf('EquipmentSystem'), { id: true, projectId: true, name: true },
    (r) => r.projectId === projectId, nameOf, 'EquipmentSystem'));
  out.push(...await owned(db, 'monoblock', idsOf('Monoblock'), { id: true, name: true, system: { select: { projectId: true } } },
    (r) => r.system?.projectId === projectId, nameOf, 'Monoblock'));
  out.push(...await owned(db, 'componentElement', idsOf('ComponentElement'),
    { id: true, name: true, itemCode: true, monoblock: { select: { system: { select: { projectId: true } } } } },
    (r) => r.monoblock?.system?.projectId === projectId, nameOf, 'ComponentElement'));
  out.push(...await owned(db, 'docRegister', idsOf('DocRegister'), { id: true, projectId: true, name: true },
    (r) => r.projectId === projectId, nameOf, 'DocRegister'));
  // Строка реестра принадлежит проекту и сама, и через свой реестр (так её находит удаление проекта)
  out.push(...await owned(db, 'docRegisterItem', idsOf('DocRegisterItem'),
    { id: true, projectId: true, contractorNo: true, titleRu: true, titleEn: true, register: { select: { projectId: true } } },
    (r) => r.projectId === projectId || r.register?.projectId === projectId,
    (r) => String(r.contractorNo || r.titleRu || r.titleEn || '').trim(), 'DocRegisterItem'));
  out.push(...await owned(db, 'dictionaryItem', idsOf('DictionaryItem'), { id: true, nameRu: true, dictionary: { select: { projectId: true } } },
    (r) => r.dictionary?.projectId === projectId, (r) => String(r.nameRu || '').trim(), 'DictionaryItem'));
  return out;
}
