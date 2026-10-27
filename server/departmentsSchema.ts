import { ensureTables, type TableSpec } from './ddl.js';
import { ensureUserProfileSchema } from './userProfileSchema.js';

/**
 * Таблицы подразделений на случай, когда автомиграция (SQLite — localSchema.ts,
 * общая база — schema-sync.ts) не отработала. SQL собирается под движок
 * (server/ddl.ts); ошибка не глотается, а уходит наверх.
 */
const DEPARTMENT_TABLES: TableSpec[] = [{
  table: 'Department',
  cols: [
    { name: 'id', kind: 'text', pk: true },
    { name: 'name', kind: 'text', notNull: true, def: '' },
    { name: 'shortName', kind: 'text' },
    { name: 'kind', kind: 'text', notNull: true, def: 'division' },
    { name: 'city', kind: 'text' },
    { name: 'timezone', kind: 'text' },
    { name: 'parentId', kind: 'text', indexed: true },
    { name: 'sortOrder', kind: 'int', notNull: true, def: 0 },
    { name: 'archivedAt', kind: 'time' },
    { name: 'createdAt', kind: 'time', notNull: true, def: 'now' },
    { name: 'createdBy', kind: 'text', notNull: true, def: '' },
  ],
  indexes: [{ name: 'Department_parentId_idx', cols: ['parentId'] }],
}, {
  table: 'UserDepartmentHistory',
  cols: [
    { name: 'id', kind: 'text', pk: true },
    { name: 'userId', kind: 'text', notNull: true, def: '', indexed: true },
    { name: 'fromId', kind: 'text' },
    { name: 'toId', kind: 'text' },
    { name: 'by', kind: 'text', notNull: true, def: '' },
    { name: 'at', kind: 'time', notNull: true, def: 'now', indexed: true },
    { name: 'reason', kind: 'text' },
    { name: 'batchId', kind: 'text', notNull: true, def: '', indexed: true },
  ],
  indexes: [
    { name: 'UserDepartmentHistory_userId_at_idx', cols: ['userId', 'at'] },
    { name: 'UserDepartmentHistory_batchId_idx', cols: ['batchId'] },
  ],
}];

export const departmentTableSpecs = (): TableSpec[] => DEPARTMENT_TABLES;

export async function ensureDepartmentSchema(prisma: any): Promise<void> {
  await ensureUserProfileSchema(prisma);
  const failure = await ensureTables(prisma, DEPARTMENT_TABLES, undefined, true);
  if (failure) throw new Error(failure);
}
