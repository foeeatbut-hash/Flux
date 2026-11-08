import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { normalizeDocflowConfig } from '../shared/docflow/config';
import { writeSettings, copyPlan, saveTemplate, undoLast } from '../server/docflowSettings';
import { registerDocflowRoutes } from '../server/routes/docflow';
import { setPrisma } from '../server/context';

const cfg = (classId: string) => normalizeDocflowConfig({ equipmentClasses: [{ type: 'AHU', classId }] });
const at = new Date('2026-01-01T00:00:00.000Z');
const row = (config: unknown, undo = '') => ({ id: 's', config: JSON.stringify(config), source: '', undo, updatedAt: at });
let target: any = row(cfg('known'));
let source: any = row(cfg('missing'));
let writes = 0; let checks = 0; let removeOnTransaction = false;
const db: any = {
  project: { findUnique: async ({ where }: any) => where.id === 'missing-project' ? null : { id: where.id, name: where.id } },
  catalogClass: { findMany: async ({ where }: any) => { checks++; return where.id.in.filter((id: string) => id === 'known' && !(removeOnTransaction && checks > 1)).map((id: string) => ({ id })); } },
  docflowSettings: { findUnique: async ({ where }: any) => where.projectId === 'source' ? source : target, updateMany: async () => { writes++; return { count: 1 }; }, create: async () => { writes++; }, deleteMany: async () => { writes++; return { count: 1 }; } },
  docStandard: { create: async () => { writes++; return { id: 't', name: 'Шаблон' }; } },
  $transaction: async (fn: any) => fn(db),
};
const rejects400 = (fn: () => Promise<unknown>) => assert.rejects(fn, (e: any) => e.status === 400);
async function main() {
  await rejects400(() => writeSettings(db, { projectId: 'target', config: { ...cfg('known'), equipmentClasses: [{ type: 'ahu', classId: 'known' }, { type: ' AHU ', classId: 'known' }] }, expected: at.toISOString(), actorId: 'a' }));
  await rejects400(() => writeSettings(db, { projectId: 'target', config: cfg('missing'), expected: at.toISOString(), actorId: 'a' }));
  assert.equal(writes, 0, 'невалидная запись не меняет данные');
  checks = 0; removeOnTransaction = true;
  await rejects400(() => writeSettings(db, { projectId: 'target', config: cfg('known'), expected: at.toISOString(), actorId: 'a' }));
  assert.equal(writes, 0, 'удаление класса между проверками блокирует запись');
  removeOnTransaction = false; checks = 0;
  await rejects400(() => copyPlan(db, 'target', { projectId: 'source' }, ['equipmentClasses']));
  await rejects400(() => saveTemplate(db, 'Шаблон', cfg('missing')));
  target = row(cfg('known'), JSON.stringify({ config: JSON.stringify(cfg('missing')), source: '', afterUpdatedAt: at.toISOString() }));
  await rejects400(() => undoLast(db, 'target', 'a'));
  assert.equal(writes, 0, 'план, шаблон и отмена с отсутствующим классом не записывают данные');
  await assert.rejects(() => copyPlan(db, 'missing-project', { projectId: 'source' }, ['equipmentClasses']), (e: any) => e.status === 404);
  const app = express(); app.use(express.json()); registerDocflowRoutes(app); setPrisma(db);
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/docflow/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'target', config: cfg('missing'), expectedUpdatedAt: at.toISOString() }) });
    assert.equal(response.status, 400, 'маршрут возвращает статус ошибки проверки');
    target = row({ equipmentClasses: [{ type: 'AHU', classId: '' }] });
    const template = await fetch(`http://127.0.0.1:${address.port}/api/docflow/templates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'target', name: 'Шаблон' }) });
    assert.equal(template.status, 400, 'шаблон не теряет повреждённые исходные строки при чтении');
    assert.equal(writes, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); setPrisma(null); }
  console.log('Настройки классов: сырые ошибки, ссылки, транзакция, план, шаблон, отмена и HTTP проверены');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
