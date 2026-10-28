/**
 * Права, которые сотруднику даёт набор его должностей (основная и дополнительные).
 *
 * Одно место для всех, кто это считает: проверка прав на сервере, профиль при
 * входе и в списке сотрудников, штамп сессии. Если бы каждый складывал сам,
 * человек проходил бы одну проверку и не проходил другую.
 * Правило слияния — shared/positions.ts (mergePositionPermissions).
 */
import { extraPositionCodes, mergePositionPermissions, primaryPositionCode } from '../shared/positions.js';

type LoadRaw = (code: string) => Promise<string | null | undefined>;

const parse = (raw: unknown): Record<string, any> => {
  if (!raw) return {};
  try {
    const obj = JSON.parse(String(raw));
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
};

/**
 * Права должностей строкой JSON — для штампа сессии и поля rolePermissions.
 * Без дополнительных должностей отдаётся запись справочника как есть, как и
 * раньше: иначе после обновления программы у всех сотрудников сменился бы
 * штамп и сессии были бы закрыты.
 */
export async function positionPermissionsString(user: any, loadRaw: LoadRaw): Promise<string | null> {
  if (!user?.role || user.role === 'OWNER') return null;
  // У администратора без записанной должности (заведён до разделения) основной
  // кодом остаётся 'ADMIN' — у такой строки справочника прав нет
  const primary = primaryPositionCode(user) ?? String(user.role);
  const primaryRaw = (await loadRaw(primary)) || null;
  const extras = extraPositionCodes(user);
  if (!extras.length) return primaryRaw;
  const extraRaws = await Promise.all(extras.map((code) => loadRaw(code)));
  return JSON.stringify(mergePositionPermissions(primaryRaw, extraRaws));
}

export async function positionPermissions(user: any, loadRaw: LoadRaw): Promise<Record<string, any>> {
  return parse(await positionPermissionsString(user, loadRaw));
}
