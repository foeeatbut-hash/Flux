import assert from 'node:assert/strict';
import { mutateOfficeSettingArray } from '../server/officeTemplateStore.js';

let record: any = { id: 'templates', key: 'office', userId: null, value: '[]' };
let firstReads = 0;
let releaseReads!: () => void;
const bothRead = new Promise<void>((resolve) => { releaseReads = resolve; });
const db = { appSetting: {
  findFirst: async () => {
    const snapshot = { ...record };
    if (firstReads < 2) { firstReads++; if (firstReads === 2) releaseReads(); await bothRead; }
    return snapshot;
  },
  create: async () => { throw new Error('already exists'); },
  updateMany: async ({ where, data }: any) => {
    if (where.id !== record.id || where.value !== record.value) return { count: 0 };
    record = { ...record, ...data }; return { count: 1 };
  },
} };
const change = (id: string) => mutateOfficeSettingArray({
  db, key: 'office', userId: null, parse: (raw) => JSON.parse(raw || '[]'),
  change: (items: string[]) => [...items, id], conflictMessage: 'retry',
});

await Promise.all([change('shared-a'), change('shared-b')]);
assert.deepEqual(JSON.parse(record.value).sort(), ['shared-a', 'shared-b']);
console.log('Параллельное создание общих шаблонов сохраняет обе записи');
