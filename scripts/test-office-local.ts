/**
 * Flux Office для файлов Проводника: state / запись схемы / preview / confirm
 * над присланным содержимым (server/routes/projectOfficeLocal.ts).
 * Проверяет то же, что маршруты файла проекта, плюс три свойства локального
 * варианта: права по выбранному проекту, новые байты вместо записи, ничего не
 * хранится на сервере.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { setPrisma } from '../server/context.js';
import { registerProjectOfficeRoutes } from '../server/routes/projectOffice.js';
import { registerProjectOfficeLocalRoutes } from '../server/routes/projectOfficeLocal.js';
import { docxFieldXml, insertXlsxField, listDocxFields, listXlsxAnchors } from '../server/officeFields.js';
import { readOfficeBindings } from '../server/officeBindings.js';
import { registerSchemaClient } from '../server/schemaRuntime.js';
import { carryFluxPart } from '../office/fluxPart.js';
import { makeDocx, makeXlsx } from './officeHarness';

const tags = [
  { id: '42', projectId: 'project-1', identifier: 'P-42', brand: 'Flux', metadata: null, componentElements: [] },
  { id: '43', projectId: 'project-1', identifier: 'P-43', brand: 'Flux', metadata: null, componentElements: [] },
];
// Любое обращение к файлам сервера означает, что локальный вариант вернулся к FileNode
const forbidden = async () => { throw new Error('локальный вариант не должен трогать файлы сервера'); };
const indexes = new Map<string, { table: string; unique: boolean; cols: string[] }>();
const prisma: any = {
  fileNode: { findUnique: forbidden, create: forbidden, update: forbidden },
  fileChunk: { findMany: forbidden, create: forbidden, createMany: forbidden },
  fileVersion: { create: forbidden },
  folder: { findUnique: async () => null },
  user: { findFirst: async () => null },
  projectMember: { count: async () => 0, findMany: async ({ where }: any) => where?.projectId === 'closed-project' ? [{ userId: 'member' }] : [] },
  project: { findUnique: async () => ({ system: false }) },
  tag: {
    findMany: async () => tags,
    count: async () => tags.length,
    aggregate: async () => ({ _max: { createdAt: null, updatedAt: null } }),
  },
  equipmentSystem: { findMany: async () => [] },
  catalogClass: { findMany: async () => [{ id: 'seeded' }] },
  catalogManufacturer: { findMany: async () => [] },
  catalogFamily: { findMany: async () => [] },
  catalogComponent: { findMany: async () => [] },
  catalogTagRule: { findMany: async () => [] },
  blankTemplate: { count: async () => 1 },
  componentElement: { count: async () => 0, aggregate: async () => ({ _max: { updatedAt: null } }) },
  appSetting: { findFirst: async () => null },
  // Каталог проверяет индексы через PRAGMA: хватает запомнить созданные
  $queryRawUnsafe: async (sql: string) => {
    if (/^PRAGMA table_info/i.test(sql)) return [{ name: 'id' }];
    const table = /^PRAGMA index_list\("(.+)"\)/i.exec(sql)?.[1];
    if (table) return [...indexes].filter(([, index]) => index.table === table).map(([name, index]) => ({ name, unique: index.unique ? 1 : 0, partial: 0 }));
    const named = /^PRAGMA index_info\("(.+)"\)/i.exec(sql)?.[1];
    return named ? (indexes.get(named)?.cols || []).map((name) => ({ name })) : [];
  },
  $executeRawUnsafe: async (sql: string) => {
    const made = /^CREATE (UNIQUE )?INDEX IF NOT EXISTS "(.+?)" ON "(.+?)" \((.+?)\)/i.exec(sql);
    if (made) indexes.set(made[2], { table: made[3], unique: !!made[1], cols: made[4].split(',').map((col) => col.trim().replace(/"/g, '')) });
    return 1;
  },
  $transaction: async (callback: Function) => callback(prisma),
};
registerSchemaClient(prisma, 'sqlite');
setPrisma(prisma);

const handlers = new Map<string, Function>();
const app = {
  get: (path: string, handler: Function) => handlers.set(`GET ${path}`, handler),
  post: (path: string, handler: Function) => handlers.set(`POST ${path}`, handler),
  put: (path: string, handler: Function) => handlers.set(`PUT ${path}`, handler),
  delete: (path: string, handler: Function) => handlers.set(`DELETE ${path}`, handler),
} as any;
registerProjectOfficeRoutes(app);
registerProjectOfficeLocalRoutes(app);

async function call(path: string, body: any, authUser: any = { id: 'owner', role: 'ENGINEER' }) {
  const handler = handlers.get(`POST /api/project-data/office-local/${path}`);
  assert.ok(handler, `маршрут есть: ${path}`);
  const output: any = { statusCode: 200, body: undefined };
  const res = { status(code: number) { output.statusCode = code; return this; }, json(value: any) { output.body = value; return this; } };
  await handler({ body, params: {}, query: {}, authUser }, res);
  return output;
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const schemaOf = (anchorId = 'head-1') => ({ version: 1, anchors: [{ kind: 'word-row', id: anchorId, parts: [{ kind: 'field', binding: { fieldKey: 'identifier', sourceId: 'tags', entityType: 'tag', entityId: null, sourceRevision: '', anchorId } }] }] });

void (async () => {
  const docx = await makeDocx();
  const base64 = docx.toString('base64');

  // Состояние чистого пакета: схемы нет, хеш — от присланных байт
  const empty = await call('state', { projectId: 'project-1', base64 });
  assert.equal(empty.statusCode, 200, JSON.stringify(empty.body));
  assert.equal(empty.body.baseHash, sha(docx));
  assert.deepEqual(empty.body.schema.anchors, []);
  assert.equal(typeof empty.body.sourceRevision, 'string');
  console.log('  ✓ state: чистый пакет, хеш от присланных байт');

  // Запись схемы возвращает байты; присланный файл не меняется
  const refused = await call('write-state', { projectId: 'project-1', base64, baseHash: 'stale', schema: schemaOf() });
  assert.equal(refused.statusCode, 409);
  const written = await call('write-state', { projectId: 'project-1', base64, baseHash: empty.body.baseHash, sourceRevision: empty.body.sourceRevision, schema: schemaOf() });
  assert.equal(written.statusCode, 200, JSON.stringify(written.body));
  const updated = Buffer.from(written.body.base64, 'base64');
  assert.equal(written.body.baseHash, sha(updated));
  assert.notEqual(written.body.baseHash, empty.body.baseHash);
  assert.equal(written.body.anchorCount, 1);
  const bindings = await readOfficeBindings(updated);
  assert.equal(bindings?.anchors[0].id, 'head-1');
  assert.ok((await JSZip.loadAsync(updated)).file('word/document.xml'), 'остальные части пакета на месте');
  console.log('  ✓ write-state: новые байты со схемой, неверный baseHash — 409');

  // Редактор не знает о записанной схеме: хост переносит часть Flux в его байты
  const carried = await carryFluxPart(new Uint8Array(updated), new Uint8Array(docx));
  assert.equal((await readOfficeBindings(Buffer.from(carried)))?.anchors[0].id, 'head-1');
  const plain = new Uint8Array(docx);
  assert.equal(await carryFluxPart(plain, plain), plain, 'без части Flux тело не пережимается');
  console.log('  ✓ carryFluxPart: схема переносится в байты редактора');

  // Круг: состояние новых байт возвращает ту же схему в модели редактора
  const again = await call('state', { projectId: 'project-1', base64: written.body.base64 });
  assert.equal(again.body.baseHash, written.body.baseHash);
  assert.equal(again.body.schema.anchors[0].id, 'head-1');
  assert.equal(again.body.schema.anchors[0].kind, 'word-row');
  console.log('  ✓ state: схема читается из записанных байт');

  // Исходная шапка: применение шаблона кладёт в часть Flux templateId и снимок схемы с датой
  assert.equal(again.body.template, undefined, 'без шаблона снимка нет');
  const applied = await call('write-state', { projectId: 'project-1', base64: written.body.base64, baseHash: written.body.baseHash, sourceRevision: 'R1', schema: schemaOf('head-1'), template: { templateId: 'tpl-1', name: 'Ведомость' } });
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body));
  const withSnapshot = await call('state', { projectId: 'project-1', base64: applied.body.base64 });
  assert.equal(withSnapshot.body.template.templateId, 'tpl-1');
  assert.equal(withSnapshot.body.template.name, 'Ведомость');
  assert.ok(!Number.isNaN(Date.parse(withSnapshot.body.template.appliedAt)), 'дата применения записана');
  assert.deepEqual(withSnapshot.body.template.schema.anchors.map((a: any) => a.id), ['head-1']);
  assert.equal(withSnapshot.body.template.schema.anchors[0].kind, 'word-row');
  // Правка шапки после применения снимок не трогает: он остаётся таким, каким шаблон был применён
  const editedHeader = { version: 1, anchors: [{ kind: 'word-row', id: 'head-1', parts: [{ kind: 'text', text: 'Правка после шаблона' }] }, { kind: 'word-row', id: 'head-2', parts: [{ kind: 'text', text: 'Новая ячейка' }] }] };
  const afterEdit = await call('write-state', { projectId: 'project-1', base64: applied.body.base64, baseHash: applied.body.baseHash, sourceRevision: 'R1', schema: editedHeader });
  const afterEditState = await call('state', { projectId: 'project-1', base64: afterEdit.body.base64 });
  assert.deepEqual(afterEditState.body.schema.anchors.map((a: any) => a.id), ['head-1', 'head-2']);
  assert.equal(afterEditState.body.template.templateId, 'tpl-1');
  assert.deepEqual(afterEditState.body.template.schema.anchors, withSnapshot.body.template.schema.anchors, 'снимок не изменился');
  assert.equal(afterEditState.body.template.appliedAt, withSnapshot.body.template.appliedAt);
  // Возврат к снимку: та же запись схемы с записанной в снимке схемой, шаблон остаётся применённым
  const restored = await call('write-state', { projectId: 'project-1', base64: afterEdit.body.base64, baseHash: afterEdit.body.baseHash, sourceRevision: 'R1', schema: afterEditState.body.template.schema });
  const restoredState = await call('state', { projectId: 'project-1', base64: restored.body.base64 });
  assert.deepEqual(restoredState.body.schema, withSnapshot.body.template.schema, 'шапка равна снимку');
  assert.equal(restoredState.body.template.templateId, 'tpl-1');
  // Другой шаблон заменяет снимок: хранится один, последний
  const second = await call('write-state', { projectId: 'project-1', base64: restored.body.base64, baseHash: restored.body.baseHash, sourceRevision: 'R1', schema: editedHeader, template: { templateId: 'tpl-2' } });
  const secondState = await call('state', { projectId: 'project-1', base64: second.body.base64 });
  assert.equal(secondState.body.template.templateId, 'tpl-2');
  assert.deepEqual(secondState.body.template.schema.anchors.map((a: any) => a.id), ['head-1', 'head-2']);
  // template: null снимает связь — кнопка «Исходная шапка» снова неактивна
  const cleared = await call('write-state', { projectId: 'project-1', base64: second.body.base64, baseHash: second.body.baseHash, sourceRevision: 'R1', schema: editedHeader, template: null });
  assert.equal((await call('state', { projectId: 'project-1', base64: cleared.body.base64 })).body.template, undefined);
  // Снимок переживает перенос части Flux в байты редактора
  const carriedSnapshot = await carryFluxPart(new Uint8Array(Buffer.from(second.body.base64, 'base64')), new Uint8Array(docx));
  assert.equal((await readOfficeBindings(Buffer.from(carriedSnapshot)))?.template?.templateId, 'tpl-2');
  console.log('  ✓ исходная шапка: templateId и снимок схемы с датой, один последний, возврат без потерь');

  // План по содержимому: добавления по выбранным тегам, подтверждение с той же версией
  const query = { entity: 'tag', columns: ['identifier'], filters: [], sort: [], limit: 100, excludedEntityIds: [] };
  const rows = await call('state', { projectId: 'project-1', base64: written.body.base64 });
  const listing = (await (async () => {
    const handler = handlers.get('POST /api/project-data/office/query')!;
    const out: any = {}; await handler({ body: { projectId: 'project-1', query }, authUser: { id: 'owner', role: 'ENGINEER' } }, { status() { return this; }, json(v: any) { out.body = v; } });
    return out.body;
  })());
  assert.ok(listing?.rows, JSON.stringify(listing));
  assert.equal(listing.rows.length, 2, JSON.stringify(listing));
  const request = { projectId: 'project-1', base64: written.body.base64, baseHash: rows.body.baseHash, sourceRevision: listing.revision, selectedEntityIds: listing.rows.map((row: any) => row.entityId), query, schema: again.body.schema };
  const preview = await call('preview', request);
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.baseHash, rows.body.baseHash);
  assert.equal(preview.body.writes.length, 2);
  assert.equal(preview.body.errors.length, 0);
  const confirmed = await call('confirm', { ...request, planId: preview.body.planId });
  assert.equal(confirmed.statusCode, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.status, 'ready-for-editor');
  assert.deepEqual(confirmed.body.writes, preview.body.writes);
  console.log('  ✓ preview и confirm: план по присланным байтам, запись не выполняется');

  // План привязан к версии: другие байты или чужой planId — 409
  const edited = await call('preview', { ...request, base64: base64 });
  assert.equal(edited.statusCode, 409);
  const wrongPlan = await call('confirm', { ...request, planId: 'другой' });
  assert.equal(wrongPlan.statusCode, 409);
  const staleSource = await call('preview', { ...request, sourceRevision: 'старая' });
  assert.equal(staleSource.statusCode, 409);
  const noRows = await call('preview', { ...request, selectedEntityIds: [] });
  assert.equal(noRows.statusCode, 400);
  console.log('  ✓ план привязан к байтам, ревизии источника и набору строк');

  // Права — по выбранному проекту, как у файла проекта
  for (const [name, body] of [['state', { base64 }], ['write-state', { base64, baseHash: sha(docx), schema: schemaOf() }], ['preview', request], ['confirm', { ...request, planId: preview.body.planId }]] as const) {
    const denied = await call(name, { ...body, projectId: 'closed-project' }, { id: 'outsider', role: 'ENGINEER' });
    assert.equal(denied.statusCode, 404, `${name}: посторонний не видит проект`);
    assert.equal(denied.body.error, 'Проект не найден');
  }
  const member = await call('state', { projectId: 'closed-project', base64 }, { id: 'member', role: 'ENGINEER' });
  assert.equal(member.statusCode, 200);
  const admin = await call('state', { projectId: 'closed-project', base64 }, { id: 'boss', role: 'ADMIN' });
  assert.equal(admin.statusCode, 200);
  const noProject = await call('state', { base64 });
  assert.equal(noProject.statusCode, 400);
  const defaultProject = await call('state', { projectId: 'default', base64 });
  assert.equal(defaultProject.statusCode, 400, 'проект «по умолчанию» не подставляется');
  console.log('  ✓ права по проекту: участник и админ читают, посторонний получает 404');

  // Локальный DOCX не знает контекста файла, поэтому doc.name и подпись остаются как есть.
  const docxZip = await JSZip.loadAsync(docx);
  const docxXml = await docxZip.file('word/document.xml')!.async('string');
  const nonPlainField = docxFieldXml('tag[43].identifier', 'Ссылка').replace('<w:r><w:t xml:space="preserve">Ссылка</w:t></w:r>', '<w:hyperlink r:id="rId1"><w:r><w:t>Ссылка</w:t></w:r></w:hyperlink>');
  const refreshFields = `<w:p><w:r><w:t>Непомеченный текст {{tag[42].identifier}}</w:t></w:r></w:p><w:p>${docxFieldXml('tag[42].identifier', 'Старый шифр')}</w:p><w:p>${docxFieldXml('doc.name', 'Имя файла')}</w:p><w:p>${docxFieldXml('sign.prepared.name', 'Разработчик')}</w:p><w:p>${nonPlainField}</w:p>`;
  docxZip.file('word/document.xml', docxXml.replace('<w:sectPr', `${refreshFields}<w:sectPr`));
  const refreshDocx = await docxZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const invalidHash = await call('update-fields', { projectId: 'project-1', base64: refreshDocx.toString('base64'), baseHash: 'short' });
  assert.equal(invalidHash.statusCode, 400);
  const staleHash = await call('update-fields', { projectId: 'project-1', base64: refreshDocx.toString('base64'), baseHash: '0'.repeat(64) });
  assert.equal(staleHash.statusCode, 409);
  assert.equal(staleHash.body.baseHash, sha(refreshDocx));
  assert.equal('base64' in staleHash.body, false, 'CAS conflict не возвращает обновлённые байты');
  const deniedRefresh = await call('update-fields', { projectId: 'closed-project', base64: refreshDocx.toString('base64'), baseHash: sha(refreshDocx) }, { id: 'outsider', role: 'ENGINEER' });
  assert.equal(deniedRefresh.statusCode, 404);

  const refreshed = await call('update-fields', { projectId: 'project-1', base64: refreshDocx.toString('base64'), baseHash: sha(refreshDocx) });
  assert.equal(refreshed.statusCode, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.changed.length, 2, JSON.stringify(refreshed.body.changed));
  assert.equal(refreshed.body.unchanged, false);
  const refreshedDocx = Buffer.from(refreshed.body.base64, 'base64');
  assert.equal(refreshed.body.sha256, sha(refreshedDocx));
  const refreshedFields = await listDocxFields(refreshedDocx);
  assert.equal(refreshedFields.filter(field => field.key === 'tag[42].identifier').every(field => field.text === 'P-42'), true);
  assert.equal(refreshedFields.find(field => field.key === 'doc.name')?.text, 'Имя файла');
  assert.equal(refreshedFields.find(field => field.key === 'sign.prepared.name')?.text, 'Разработчик');
  assert.equal(refreshedFields.find(field => field.key === 'tag[43].identifier')?.text, 'Ссылка');
  assert.ok(refreshed.body.skipped.some((field: any) => field.key === 'doc.name'));
  assert.ok(refreshed.body.skipped.some((field: any) => field.key === 'sign.prepared.name'));
  assert.ok(refreshed.body.skipped.some((field: any) => field.key === 'tag[43].identifier' && field.why.includes('не только текст')));
  const refreshedDocxZip = await JSZip.loadAsync(refreshedDocx);
  assert.ok((await refreshedDocxZip.file('word/document.xml')!.async('string')).includes('Непомеченный текст'));
  const unchangedDocx = await call('update-fields', { projectId: 'project-1', base64: refreshed.body.base64, baseHash: refreshed.body.sha256 });
  assert.equal(unchangedDocx.statusCode, 200);
  assert.equal(unchangedDocx.body.unchanged, true);
  assert.deepEqual(unchangedDocx.body.changed, []);
  assert.equal(unchangedDocx.body.sha256, refreshed.body.sha256);
  console.log('  ✓ update-fields DOCX: метки и поля обновлены, контекстные пропуски и CAS проверены');

  const xlsxSource = await makeXlsx();
  const xlsxAnchor = await insertXlsxField(xlsxSource, 'Перечень', 'B5', 'tag[42].identifier', 'Старый шифр');
  const refreshedXlsxResult = await call('update-fields', { projectId: 'project-1', base64: xlsxAnchor.bytes.toString('base64'), baseHash: sha(xlsxAnchor.bytes) });
  assert.equal(refreshedXlsxResult.statusCode, 200, JSON.stringify(refreshedXlsxResult.body));
  assert.equal(refreshedXlsxResult.body.changed.length, 1);
  assert.equal(refreshedXlsxResult.body.changed[0].key, 'tag[42].identifier');
  assert.equal(refreshedXlsxResult.body.changed[0].to, 'P-42');
  const refreshedXlsx = Buffer.from(refreshedXlsxResult.body.base64, 'base64');
  assert.equal(refreshedXlsxResult.body.sha256, sha(refreshedXlsx));
  const anchors = await listXlsxAnchors(refreshedXlsx);
  assert.equal(anchors.fields.find(field => field.key === 'tag[42].identifier')?.text, 'P-42');
  const xlsxBeforeZip = await JSZip.loadAsync(xlsxAnchor.bytes);
  const xlsxAfterZip = await JSZip.loadAsync(refreshedXlsx);
  const beforeSheet = await xlsxBeforeZip.file('xl/worksheets/sheet1.xml')!.async('string');
  const afterSheet = await xlsxAfterZip.file('xl/worksheets/sheet1.xml')!.async('string');
  assert.ok(afterSheet.includes('<c r="A1" t="s"><v>0</v></c>'), 'немаркированная ячейка сохранена');
  assert.ok(afterSheet.includes('<c r="B4"><f>SUM(B2:B3)</f><v>7</v></c>'), 'формула вне якоря сохранена');
  assert.ok(beforeSheet.includes('<c r="A1" t="s"><v>0</v></c>'));
  const unsupportedZip = new JSZip();
  unsupportedZip.file('[Content_Types].xml', '<Types/>');
  unsupportedZip.file('custom/data.xml', '<data/>');
  const unsupported = await unsupportedZip.generateAsync({ type: 'nodebuffer' });
  const rejectedPackage = await call('update-fields', { projectId: 'project-1', base64: unsupported.toString('base64'), baseHash: sha(unsupported) });
  assert.equal(rejectedPackage.statusCode, 400, 'ZIP без DOCX/XLSX схемы отклонён');
  assert.equal((await call('update-fields', { projectId: 'project-1', base64: Buffer.from('CSV,текст').toString('base64'), baseHash: sha(Buffer.from('CSV,текст')) })).statusCode, 400);
  assert.equal((await call('update-fields', { projectId: 'project-1', base64: 'A'.repeat(42 * 1024 * 1024), baseHash: '0'.repeat(64) })).statusCode, 413);
  console.log('  ✓ update-fields XLSX и границы пакета: якоря обновлены, прочие ячейки и формулы сохранены');

  // Содержимое: пусто, не пакет, слишком большое
  assert.equal((await call('state', { projectId: 'project-1' })).statusCode, 400);
  assert.equal((await call('state', { projectId: 'project-1', base64: Buffer.from('просто текст').toString('base64') })).statusCode, 400);
  assert.equal((await call('state', { projectId: 'project-1', base64: 'A'.repeat(50 * 1024 * 1024) })).statusCode, 413);
  console.log('  ✓ не пакет, пусто и слишком большой файл отклоняются');
  console.log('Office local: маршруты содержимого файла Проводника проверены');
})().catch((error) => { console.error(error); process.exitCode = 1; });
