/**
 * Настройки документооборота проекта (docs/docflow-program.md, раздел 5):
 * своя копия у проекта, запись под версией, перенос разделов из другого
 * проекта или шаблона с предпросмотром и отменой, перенос прежних глобальных
 * стандартов в проекты (план → применение → отмена).
 *
 * Настоящая SQLite-база и настоящий express.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import express from 'express';
import { registerVdrRoutes } from '../server/routes/vdr.js';
import { registerDocflowRoutes } from '../server/routes/docflow.js';
import { vdrPermissionFor } from '../server/vdrPermissions.js';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma, setBroadcaster } from '../server/context.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-docflow-settings-'));
const dbPath = path.join(temp, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let passed = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  passed++;
};

async function main() {
  // Права маршрутов — та же таблица, что у сервера
  check('чтение настроек — просмотр', vdrPermissionFor('GET', '/api/docflow/settings')?.perm === 'docflow.view');
  check('запись настроек — право настроек', vdrPermissionFor('PUT', '/api/docflow/settings')?.perm === 'docflow.settings'
    && vdrPermissionFor('POST', '/api/docflow/settings/copy-apply')?.perm === 'docflow.settings'
    && vdrPermissionFor('POST', '/api/docflow/templates')?.perm === 'docflow.settings'
    && vdrPermissionFor('POST', '/api/docflow/migration/apply')?.perm === 'docflow.settings');

  const app = express();
  app.use(express.json());
  let actor: any = { id: 'admin', role: 'ADMIN' };
  app.use((req, _res, next) => { (req as any).authUser = actor; next(); });
  registerVdrRoutes(app as any, { chunkBytes: async () => 1024 });
  registerDocflowRoutes(app as any);
  const server = createServer(app);
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);
    setBroadcaster(() => {});
    await prisma.project.create({ data: { id: 'p-a', name: 'ЗапСиб PDH2' } });
    await prisma.project.create({ data: { id: 'p-b', name: 'Азот' } });
    await prisma.project.create({ data: { id: 'p-c', name: 'Пустой' } });
    const stdOld = await prisma.docStandard.create({ data: { name: 'Старый стандарт', config: JSON.stringify({ fileNameMask: '{docNo}_{rev}', vdrTypes: [{ code: 'K32', titleRu: 'Паспорт' }], reviewCodes: [{ code: 'B', label: 'Замечания', action: 'revise', deadlineDays: 5 }] }) } });
    await prisma.docRegister.create({ data: { id: 'reg-a', projectId: 'p-a', name: 'ВДР', standardId: stdOld.id } });
    await prisma.docRegister.create({ data: { id: 'reg-b', projectId: 'p-b', name: 'ВДР' } });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const send = async (method: string, url: string, body?: any) => {
      const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    const get = async (projectId: string) => (await send('GET', `/api/docflow/settings?projectId=${projectId}`)).body;

    // ── Чтение: до своей записи — настройки стандарта реестров проекта ──
    const a0 = await get('p-a');
    check('без своей записи проект показывает стандарт своих реестров', !a0.stored && a0.source.kind === 'standard' && a0.source.name === 'Старый стандарт' && a0.config.vdrTypes[0].code === 'K32', a0);
    check('прежняя маска стандарта читается в метках проекта', a0.config.masks.file === '{шифр}_{ред}');
    check('статусы по умолчанию — решение владельца', a0.config.statuses.map((s: any) => s.label).join(' → ') === 'В работе → На проверке → Согласован → Выдан → Замечания → Принят → Аннулирован');

    // ── Запись под версией ──
    const created = await send('PUT', '/api/docflow/settings', { projectId: 'p-a', config: a0.config, expectedUpdatedAt: null });
    check('первая запись создаёт свою копию проекта', created.status === 200 && created.body.stored && created.body.updatedAt, created.body);
    const noVersion = await send('PUT', '/api/docflow/settings', { projectId: 'p-a', config: a0.config });
    check('запись без версии — отказ, а не перезапись', noVersion.status === 400);
    const edited = { ...created.body.config, vdrTypes: [...created.body.config.vdrTypes, { code: 'E02', titleRu: 'Общий вид', titleEn: '' }] };
    const ok = await send('PUT', '/api/docflow/settings', { projectId: 'p-a', config: edited, expectedUpdatedAt: created.body.updatedAt });
    check('правка по текущей версии проходит', ok.status === 200 && ok.body.config.vdrTypes.length === 2);
    const stale = await send('PUT', '/api/docflow/settings', { projectId: 'p-a', config: a0.config, expectedUpdatedAt: created.body.updatedAt });
    check('правка по устаревшей версии — 409 с текущими настройками', stale.status === 409 && stale.body.current?.config?.vdrTypes?.length === 2, stale.body);
    const badMask = await send('PUT', '/api/docflow/settings', { projectId: 'p-a', config: { ...edited, masks: { ...edited.masks, file: '{шифр}{ред}' } }, expectedUpdatedAt: ok.body.updatedAt });
    check('неисправная маска не сохраняется', badMask.status === 400 && /Маска имени/.test(badMask.body.error), badMask.body);
    const raceA = send('PUT', '/api/docflow/settings', { projectId: 'p-c', config: a0.config, expectedUpdatedAt: null });
    const raceB = send('PUT', '/api/docflow/settings', { projectId: 'p-c', config: a0.config, expectedUpdatedAt: null });
    const race = [await raceA, await raceB].map((r) => r.status).sort();
    check('две одновременные первые записи: одна проходит, вторая 409', race[0] === 200 && race[1] === 409, race);

    // ── Перенос из проекта: предпросмотр ничего не пишет ──
    const b0 = await get('p-b');
    const plan = await send('POST', '/api/docflow/settings/copy-plan', { projectId: 'p-b', from: { projectId: 'p-a' }, sections: ['types'] });
    const typesDiff = plan.body.sections?.find((s: any) => s.key === 'types');
    check('предпросмотр показывает различия по отмеченным разделам', plan.status === 200 && typesDiff.lines.includes('добавится E02') && plan.body.sections.length === 1, plan.body);
    check('предпросмотр ничего не записал', !(await get('p-b')).stored);
    const noSections = await send('POST', '/api/docflow/settings/copy-plan', { projectId: 'p-b', from: { projectId: 'p-a' }, sections: [] });
    check('без отмеченных разделов — отказ', noSections.status === 400);
    const applied = await send('POST', '/api/docflow/settings/copy-apply', { projectId: 'p-b', from: { projectId: 'p-a' }, sections: ['types'], expectedUpdatedAt: b0.updatedAt });
    check('перенос применён: типы взяты, остальное своё', applied.status === 200 && applied.body.config.vdrTypes.some((t: any) => t.code === 'E02') && applied.body.config.reviewCodes[0].code === b0.config.reviewCodes[0].code, applied.body);
    check('видно, откуда скопировано', applied.body.source?.kind === 'project' && applied.body.source.name === 'ЗапСиб PDH2' && /\d{2}\.\d{2}\.\d{4}/.test(applied.body.source.at));
    check('перенос можно отменить', applied.body.canUndo && /ЗапСиб PDH2/.test(applied.body.undoLabel));
    const undone = await send('POST', '/api/docflow/settings/undo', { projectId: 'p-b' });
    check('отмена одним действием возвращает как было', undone.status === 200 && !undone.body.stored, undone.body);

    // Отмена закрывается после следующей правки
    const again = await send('POST', '/api/docflow/settings/copy-apply', { projectId: 'p-b', from: { projectId: 'p-a' }, sections: ['types', 'masks'], expectedUpdatedAt: null });
    const after = await send('PUT', '/api/docflow/settings', { projectId: 'p-b', config: again.body.config, expectedUpdatedAt: again.body.updatedAt });
    check('после правки отмена переноса закрыта', after.status === 200 && !after.body.canUndo);
    const lateUndo = await send('POST', '/api/docflow/settings/undo', { projectId: 'p-b' });
    check('поздняя отмена не затирает правку', lateUndo.status === 404 || lateUndo.status === 409, lateUndo);
    const stalePlan = await send('POST', '/api/docflow/settings/copy-apply', { projectId: 'p-b', from: { projectId: 'p-a' }, sections: ['types'], expectedUpdatedAt: again.body.updatedAt });
    check('перенос по устаревшей версии — 409', stalePlan.status === 409);

    // ── Шаблоны ──
    const tpl = await send('POST', '/api/docflow/templates', { projectId: 'p-a', name: 'Шаблон ЗапСиб' });
    check('настройки проекта сохраняются шаблоном', tpl.status === 200 && tpl.body.template?.id);
    const list = (await send('GET', '/api/docflow/templates')).body.templates;
    check('шаблоны — прежние стандарты и новые', list.length === 2 && list.some((t: any) => t.name === 'Старый стандарт'));
    const fromTpl = await send('POST', '/api/docflow/settings/copy-apply', { projectId: 'p-b', from: { templateId: tpl.body.template.id }, sections: ['types'], expectedUpdatedAt: after.body.updatedAt });
    check('проект создаётся из шаблона', fromTpl.status === 200 && fromTpl.body.source.kind === 'template' && fromTpl.body.config.vdrTypes.some((t: any) => t.code === 'E02'));
    const aBefore = await get('p-a');
    await send('PUT', '/api/docflow/settings', { projectId: 'p-b', config: { ...fromTpl.body.config, vdrTypes: [] }, expectedUpdatedAt: fromTpl.body.updatedAt });
    check('копия, а не ссылка: правка проекта не трогает источник', (await get('p-a')).config.vdrTypes.length === aBefore.config.vdrTypes.length);

    // ── Сроки по коду рассмотрения берутся из настроек проекта ──
    const pA = await get('p-a');
    await send('PUT', '/api/docflow/settings', { projectId: 'p-a', config: { ...pA.config, reviewCodes: [{ code: '2', label: 'С замечаниями', action: 'revise', deadlineDays: 10, status: 'REMARKS' }, { code: '4', label: 'Для сведения', action: 'info', deadlineDays: 0 }] }, expectedUpdatedAt: pA.updatedAt });
    const item = (await send('POST', '/api/vdr/items', { registerId: 'reg-a', contractorNo: 'X-1', titleRu: 'Док' })).body.item;
    const coded = await send('PUT', `/api/vdr/items/${item.id}`, { reviewCode: '2', expectedUpdatedAt: item.updatedAt });
    const days = (new Date(coded.body.item.dueDate).getTime() - Date.now()) / 86400000;
    check('код рассмотрения из настроек проекта: статус и срок', coded.body.item.status === 'REMARKS' && days > 9.9 && days < 10.1, coded.body);
    const info = await send('PUT', `/api/vdr/items/${item.id}`, { reviewCode: '4', expectedUpdatedAt: coded.body.item.updatedAt });
    check('«для сведения» статус не меняет', info.body.item.status === 'REMARKS', info.body);
    const status = await send('PUT', `/api/vdr/items/${item.id}`, { status: 'CHECK', expectedUpdatedAt: info.body.item.updatedAt });
    check('статус из настроек проекта принимается', status.body.item.status === 'CHECK', status.body);

    // ── Перенос прежних стандартов в проекты ──
    actor = { id: 'eng', role: 'USER' };
    check('план переноса стандартов — только администратору', (await send('GET', '/api/docflow/migration')).status === 403);
    actor = { id: 'admin', role: 'ADMIN' };
    await prisma.docflowSettings.deleteMany({ where: { projectId: { in: ['p-a', 'p-b'] } } });
    const mplan = (await send('GET', '/api/docflow/migration')).body;
    check('план называет проекты с реестрами и их стандарт', mplan.projects.length === 2 && mplan.projects.find((p: any) => p.projectId === 'p-a').standardName === 'Старый стандарт', mplan);
    check('проект без реестров и проект со своей копией в план не входят', !mplan.projects.some((p: any) => p.projectId === 'p-c'));
    const mapplied = await send('POST', '/api/docflow/migration/apply', { projectIds: ['p-a', 'p-b'] });
    check('применение создаёт копии одной транзакцией', mapplied.status === 200 && (await prisma.docflowSettings.count()) === 3 && mapplied.body.projects.length === 0, mapplied.body);
    const twice = await send('POST', '/api/docflow/migration/apply', { projectIds: ['p-a'] });
    check('повтор не плодит копий', twice.status === 400 && (await prisma.docflowSettings.count()) === 3);
    const pA2 = await get('p-a');
    await send('PUT', '/api/docflow/settings', { projectId: 'p-a', config: pA2.config, expectedUpdatedAt: pA2.updatedAt });
    const mundo = await send('POST', '/api/docflow/migration/undo', {});
    check('отмена переноса убирает только нетронутые копии', mundo.status === 200 && mundo.body.kept.includes('p-a') && !(await get('p-b')).stored && (await get('p-a')).stored, mundo.body);
  } finally {
    server.close();
    await prisma.$disconnect();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(`Настройки документооборота проекта: ${passed} проверок прошли`);
}

main().catch((err) => { console.error(err); process.exit(1); });
