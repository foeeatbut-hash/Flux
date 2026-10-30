import { ensureTables, type TableSpec } from './ddl.js';

/** Добавляет только необязательные поля профиля, не меняя существующие данные. */
const USER_PROFILE_TABLES: TableSpec[] = [{
  table: 'User',
  existingOnly: true,
  cols: [
    { name: 'id', kind: 'text', pk: true },
    { name: 'position', kind: 'text' },
    { name: 'department', kind: 'text' },
    { name: 'email', kind: 'text' },
    { name: 'departmentId', kind: 'text', indexed: true },
    // Должности (shared/positions.ts): основная и JSON-массив дополнительных
    { name: 'positionCode', kind: 'text' },
    { name: 'extraPositions', kind: 'text' },
  ],
  indexes: [{ name: 'User_departmentId_idx', cols: ['departmentId'] }],
}];

export async function ensureUserProfileSchema(prisma: any): Promise<void> {
  const failure = await ensureTables(prisma, USER_PROFILE_TABLES, undefined, true);
  if (failure) throw new Error(failure);
}
