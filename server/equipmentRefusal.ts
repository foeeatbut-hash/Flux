/**
 * Отказы маршрутов оборудования: что отдать в ответе и что считать вложенным
 * при удалении (docs/roadmap/offline-work.md, 0.5; .claude/progress/conflict-details.md).
 *
 * Сверку версии и открытых записей делает server/versionGuard.ts; здесь то, что
 * знает только оборудование:
 *  • отказ по позиции несёт в `current` теги — `[{ id, code }]` (у «сырой» строки
 *    позиции тегов нет), иначе экрану нечего сравнить с показанным;
 *  • что уйдёт вместе с позицией и с установкой — для защиты открытой записи.
 */

import type { Response } from 'express';
import { getPrisma, sendError } from './context.js';
import { VersionConflict, sendGuardRefusal } from './versionGuard.js';
import type { OpenRef } from './openRecords.js';

/** Строка позиции (ComponentElement), а не моноблока или установки */
const isElementRow = (row: any): boolean => !!row && typeof row.id === 'string' && 'itemCode' in row && 'monoblockId' in row;

/** Теги позиции в виде, который отдаёт отказ: `code` — написание тега (`Tag.identifier`). */
async function tagsOfElement(prisma: any, id: string): Promise<Array<{ id: string; code: string }> | null> {
  try {
    const row = await prisma.componentElement.findUnique({ where: { id }, select: { tags: { select: { id: true, identifier: true } } } });
    return (row?.tags || []).map((t: any) => ({ id: t.id, code: t.identifier }));
  } catch (_) {
    // Отказ важнее перечня тегов: без них экран просто не покажет различий по тегам
    return null;
  }
}

/**
 * Ответ на отказ защиты записи (версия, открытая запись, запись удалена, сбой
 * чтения открытых). `true` — ответ дан; иначе ошибка не отказ и решать маршруту.
 */
export async function sendEquipmentRefusal(res: Response, err: unknown, prisma: any = getPrisma()): Promise<boolean> {
  if (err instanceof VersionConflict && isElementRow(err.current)) {
    const tags = await tagsOfElement(prisma, err.current.id);
    return sendGuardRefusal(res, err, tags ? (row) => ({ ...row, tags }) : undefined);
  }
  return sendGuardRefusal(res, err);
}

/** Для `catch` маршрутов: отказ — своим ответом, остальное — как у всех маршрутов. */
export async function replyEquipmentError(res: Response, err: any): Promise<void> {
  try {
    if (await sendEquipmentRefusal(res, err)) return;
  } catch (_) { /* ответ об отказе не вышел — ниже обычный */ }
  sendError(res, err);
}

const nameOf = (r: any): string => String(r?.name || r?.itemCode || '').trim();

/**
 * Вложенное в позицию: все позиции под ней, на любую глубину. Удаление поднимает
 * детей на уровень выше, но человек, открывший датчик на двигателе, не должен
 * увидеть, что у него из-под рук убрали владельца: защита смотрит всё вложенное.
 * Читает только через `db` транзакции.
 */
export async function elementCascade(db: any, current: any): Promise<OpenRef[]> {
  const out: OpenRef[] = [];
  const seen = new Set<string>([current.id]);
  let frontier = [current.id];
  while (frontier.length) {
    const rows = await db.componentElement.findMany({ where: { parentElementId: { in: frontier } }, select: { id: true, name: true, itemCode: true } });
    frontier = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      frontier.push(r.id);
      out.push({ model: 'ComponentElement', id: r.id, name: nameOf(r) });
    }
  }
  return out;
}

/** Вложенное в установку: её блоки и все позиции этих блоков. */
export async function systemCascade(db: any, current: any): Promise<OpenRef[]> {
  const monoblocks = await db.monoblock.findMany({ where: { systemId: current.id }, select: { id: true, name: true } });
  const out: OpenRef[] = monoblocks.map((m: any) => ({ model: 'Monoblock', id: m.id, name: nameOf(m) }));
  const ids = monoblocks.map((m: any) => m.id);
  if (ids.length) {
    const components = await db.componentElement.findMany({ where: { monoblockId: { in: ids } }, select: { id: true, name: true, itemCode: true } });
    for (const c of components) out.push({ model: 'ComponentElement', id: c.id, name: nameOf(c) });
  }
  return out;
}
