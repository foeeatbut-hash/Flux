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

let emptyRecord: any = null;
let emptyReads = 0;
let releaseEmpty!: () => void;
const bothEmptyRead = new Promise<void>((resolve) => { releaseEmpty = resolve; });
const emptyDb = { appSetting: {
  findFirst: async () => {
    const snapshot = emptyRecord && { ...emptyRecord };
    if (emptyReads < 2) { emptyReads++; if (emptyReads === 2) releaseEmpty(); await bothEmptyRead; }
    return snapshot;
  },
  create: async ({ data }: any) => {
    if (emptyRecord) throw new Error('duplicate primary key');
    emptyRecord = data;
  },
  updateMany: async ({ where, data }: any) => {
    if (!emptyRecord || where.id !== emptyRecord.id || where.value !== emptyRecord.value) return { count: 0 };
    emptyRecord = { ...emptyRecord, ...data }; return { count: 1 };
  },
} };
const create = (id: string) => mutateOfficeSettingArray({
  db: emptyDb, key: 'shared-empty', userId: null, parse: (raw) => JSON.parse(raw || '[]'),
  change: (items: string[]) => [...items, id], conflictMessage: 'retry',
});

void (async () => {
  await Promise.all([change('shared-a'), change('shared-b')]);
  assert.deepEqual(JSON.parse(record.value).sort(), ['shared-a', 'shared-b']);
  await Promise.all([create('first-a'), create('first-b')]);
  assert.deepEqual(JSON.parse(emptyRecord.value).sort(), ['first-a', 'first-b']);
  console.log('Параллельное обновление и первичное создание shared-массива сохраняют обе записи');
})().catch((error) => { console.error(error); process.exitCode = 1; });
