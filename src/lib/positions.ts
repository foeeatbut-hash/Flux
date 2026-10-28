/**
 * Должности сотрудника для экранов: кто на какой должности и сколько людей на каждой.
 *
 * Правила хранения — shared/positions.ts (одни на окно и сервер); здесь только
 * перевод кодов в записи справочника для показа, сортировки и поиска.
 */
import { extraPositionCodes, primaryPositionCode, type PositionUser } from '../../shared/positions';
import { roleByCode, type Role } from './roles';

export interface PositionView {
  /** Основная должность; null — не назначена (профиль заведён до разделения, это администратор) */
  primary: Role | null;
  /** Дополнительные, в порядке назначения */
  extras: Role[];
}

export function positionView(user: PositionUser | null | undefined, roles: Role[]): PositionView {
  const main = primaryPositionCode(user);
  return {
    primary: main ? roleByCode(main, roles) : null,
    extras: extraPositionCodes(user).map((code) => roleByCode(code, roles)),
  };
}

/** Сколько людей на должности: основной и дополнительной — для справочника и запрета удаления */
export function usageByPosition(users: PositionUser[]): Map<string, { primary: number; extra: number }> {
  const usage = new Map<string, { primary: number; extra: number }>();
  const slot = (code: string) => {
    let entry = usage.get(code);
    if (!entry) { entry = { primary: 0, extra: 0 }; usage.set(code, entry); }
    return entry;
  };
  for (const user of users) {
    const main = primaryPositionCode(user);
    if (main) slot(main).primary++;
    for (const code of extraPositionCodes(user)) slot(code).extra++;
  }
  return usage;
}

/** Все названия должностей человека одной строкой — для поиска */
export function positionNames(user: PositionUser | null | undefined, roles: Role[]): string {
  const view = positionView(user, roles);
  return [view.primary, ...view.extras].filter(Boolean).map((r) => r!.name || r!.code).join(' ');
}
