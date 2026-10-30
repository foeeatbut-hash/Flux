/**
 * Должности и уровень доступа при создании и правке сотрудника.
 *
 * Правила (shared/positions.ts): должность обязательна у всех, кроме владельца;
 * «администратор» и «владелец» — уровни, а не должности; уровень назначает
 * только владелец. Уровень хранится в User.role, и у сотрудника там код его
 * основной должности — всё, что читает role, продолжает работать.
 */
import { accessLevelOf, checkPositions, extraPositionCodes, isNonPositionCode, primaryPositionCode, stripAdminPermissions, type AccessLevel } from '../shared/positions.js';

export type PositionDecision =
  | { ok: true; role: string; positionCode: string; extraPositions: string | null; level: AccessLevel }
  | { ok: true; unchanged: true; level: AccessLevel }
  | { ok: false; status: number; message: string };

/** Коды справочника, которые можно назначить должностью */
export async function knownPositionCodes(prisma: any): Promise<Set<string>> {
  const rows = await prisma.role.findMany({ select: { code: true } });
  return new Set((rows as Array<{ code: string }>).map((r) => r.code).filter((code) => !isNonPositionCode(code)));
}

/**
 * Что записать в role / positionCode / extraPositions.
 * target — правимый сотрудник (null при создании). Поле тела `accessLevel`
 * ('ADMIN' | 'EMPLOYEE') задаёт уровень явно; старый вызов с `role` читается
 * так: 'ADMIN' — администратор, иной код — сотрудник с этой основной должностью.
 */
export async function decidePositions(prisma: any, body: any, target: any | null, actorIsOwner: boolean): Promise<PositionDecision> {
  const roleField = body?.role === undefined || body?.role === null || body?.role === '' ? undefined : String(body.role).trim().toUpperCase();
  const explicit = body?.accessLevel;
  if (explicit !== undefined && explicit !== 'ADMIN' && explicit !== 'EMPLOYEE') {
    return { ok: false, status: 400, message: 'Уровень доступа — «Администратор» или «Сотрудник».' };
  }
  const currentLevel: AccessLevel = target ? accessLevelOf(target) : 'EMPLOYEE';
  const level: AccessLevel = explicit === 'ADMIN' ? 'ADMIN' : explicit === 'EMPLOYEE' ? 'EMPLOYEE'
    : roleField === 'ADMIN' ? 'ADMIN' : roleField !== undefined ? 'EMPLOYEE' : currentLevel;

  const touched = !target || explicit !== undefined || roleField !== undefined
    || body?.positionCode !== undefined || body?.extraPositions !== undefined;
  if (!touched) return { ok: true, unchanged: true, level };

  if (level === 'ADMIN' && !actorIsOwner) return { ok: false, status: 403, message: 'Администратора и его права назначает только владелец' };
  if (currentLevel === 'ADMIN' && level !== 'ADMIN' && !actorIsOwner) return { ok: false, status: 403, message: 'Уровень доступа администратора меняет только владелец' };

  const primaryRaw = body?.positionCode !== undefined ? body.positionCode
    : roleField !== undefined && roleField !== 'ADMIN' ? roleField
    : target ? primaryPositionCode(target) : undefined;
  const extrasRaw = body?.extraPositions !== undefined ? body.extraPositions
    : target ? extraPositionCodes(target) : undefined;
  const checked = checkPositions(primaryRaw, extrasRaw, await knownPositionCodes(prisma));
  if (checked.ok === false) return { ok: false, status: 400, message: checked.error };
  return {
    ok: true, level,
    role: level === 'ADMIN' ? 'ADMIN' : checked.primary,
    positionCode: checked.primary,
    extraPositions: checked.extras.length ? JSON.stringify(checked.extras) : null,
  };
}

/** Строка прав без admin.*: полномочия администратора есть только у администратора */
export function permissionsWithoutAdmin(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const cleaned = stripAdminPermissions(raw);
  return Object.keys(cleaned).length ? JSON.stringify(cleaned) : null;
}

/** В строке прав есть записи admin.* */
export function hasAdminKeys(raw: unknown): boolean {
  if (!raw) return false;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return !!parsed && typeof parsed === 'object' && Object.keys(parsed).some((key) => key.startsWith('admin.'));
  } catch { return false; }
}
