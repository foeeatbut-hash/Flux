/**
 * Стенд документооборота для браузерных проверок (?docflow=1 у windows-explorer-ui.html):
 * папка проекта «Проекты», привязанная как рабочая, строки ВДР, связи файлов и ответы сервера
 * на запросы Проводника и ДО. Проверка имени — настоящая (shared/docflow/nameMask), чтобы
 * стенд не мог согласиться с тем, с чем не согласился бы сервер.
 */
import { diffSections, mergeSections, normalizeDocflowConfig } from '../../shared/docflow/config';
import { buildFileName, checkName, type RowForCheck } from '../../shared/docflow/nameMask';
import type { DocLinkDto, LinkedItemBrief } from '../../shared/docflow/links';
import type { WindowsFileEntry } from '../../filesystem/contracts';

export const DOCFLOW = new URLSearchParams(location.search).get('docflow') === '1';
/** Ключ места так же, как его считает стенд моста (locationKeys): по пути в нижнем регистре. */
export const keyOfPath = (path: string) => Array.from(new TextEncoder().encode(`net:${path.toLowerCase()}`), (b) => b.toString(16).padStart(2, '0')).join('');

const WORK_KEY = keyOfPath('Проекты');
const RETURNS_KEY = keyOfPath('Возвраты');
let config = normalizeDocflowConfig({ vdrTypes: [{ code: 'E02', titleRu: 'Общий вид', titleEn: '' }, { code: 'C32', titleRu: 'Опросный лист', titleEn: '' }], deadlines: { milestones: [{ code: 'START', label: 'Старт', date: '' }], byType: [] } });
const sourceConfig = normalizeDocflowConfig({ kits: [{ classId: 'class-ahu', items: [{ docType: 'C32', stage: 'П', unit: 'project', necessity: 'optional', responsibleRole: 'ENGINEER', milestone: 'START', workdays: 7, condition: null }] }] });
const file = (name: string, fileId: string, size: number): WindowsFileEntry => ({ name, relativePath: `Проекты/${name}`, storage: 'windows', kind: 'file', fileId, size, modifiedAt: '2026-11-04T09:00:00.000Z', linked: false });

export const docflowFiles: WindowsFileEntry[] = DOCFLOW ? [
  file('3700-B01-E02-001_B.pdf', 'df-1', 2048), file('3700-B01-E02-004_A.pdf', 'df-2', 1500),
  file('черновик.docx', 'df-3', 800), file('3700-B01-E02-001.pdf', 'df-4', 1200), file('3700-B01-E02-005_A.pdf', 'df-5', 600),
] : [];

const item = (id: string, no: string, revision: string, status: string, title: string, extra: Partial<LinkedItemBrief> = {}): LinkedItemBrief & { row: RowForCheck } => ({
  id, cipher: no, title, vdrCode: 'E02', revision, status, registerId: 'r1', dueDate: null, assignee: '', tags: [], row: { contractorNo: no, vdrCode: 'E02', revision }, ...extra,
});
const items = [
  item('i1', '3700-B01-E02-001', 'C', 'ISSUED', 'Общий вид установки П1', { assignee: 'Иванов И. И.', dueDate: '2026-11-20T00:00:00.000Z', tags: ['П1'] }),
  item('i2', '3700-B01-E02-002', 'A', 'DRAFT', 'Общий вид установки П2'),
  item('i4', '3700-B01-E02-004', 'A', 'CHECK', 'Общий вид установки П4'),
  item('i5', '3700-B01-E02-005', 'A', 'READY', 'Общий вид установки П5'),
];
const link = (id: string, itemId: string, revision: string, relativePath: string, over: Partial<DocLinkDto> = {}): DocLinkDto => ({
  id, itemId, projectId: 'project-1', revision, role: 'file', toLinkId: null, folderKey: WORK_KEY, relativePath, fileName: relativePath.split('/').pop()!, sha256: 'a'.repeat(64), size: 0,
  reviewCode: '', receivedAt: null, lostAt: null, linkedById: 'admin', createdAt: '2026-11-01T09:00:00.000Z', unlinkedAt: null, unlinkReason: '', locked: false, lockedAt: null, lockedByName: '', unlockedAt: null, unlockedByName: '', lockViolation: '', ...over,
});
export const links: DocLinkDto[] = DOCFLOW ? [
  link('l1', 'i1', 'B', '3700-B01-E02-001_B.pdf', { size: 2048, locked: true, lockedAt: '2026-11-02T10:00:00.000Z', lockedByName: 'Иванов И. И.' }),
  link('l5', 'i5', 'A', '3700-B01-E02-005_A.pdf', { size: 600 }),
  link('l2', 'i2', 'A', '3700-B01-E02-002_A.pdf', { size: 100 }), // файла в папке нет: слежение пометит «не найден»
  link('l3', 'i1', 'B', 'E02/Замечания.pdf', { role: 'remarks', toLinkId: 'l1', folderKey: RETURNS_KEY, reviewCode: '2', receivedAt: '2026-11-03T00:00:00.000Z', locked: true, lockedAt: '2026-11-03T10:00:00.000Z', lockedByName: 'Иванов И. И.' }),
] : [];

export const docflowBindings = DOCFLOW ? [
  { id: 'b-work', locationKey: WORK_KEY, projectId: 'project-1', label: 'Проекты', actorId: 'admin', at: '2026-10-01T00:00:00.000Z', purpose: 'work', locator: { folderKey: WORK_KEY, anchors: [{ key: WORK_KEY, relativePath: '' }] } },
  { id: 'b-ret', locationKey: RETURNS_KEY, projectId: 'project-1', label: 'Возвраты', actorId: 'admin', at: '2026-10-01T00:00:00.000Z', purpose: 'returns' },
] : [];

export const posts: Array<{ url: string; body: any }> = [];
export const issueStand = { issued: false, undone: false, lastHashes: {} as Record<string, string> };
export const classStand = { value: '', before: '', planned: '', lastId: '', sequence: 0, denied: '', events: [] as string[], pending: false, release: null as null | (() => void) };
export const kitStand = { created: false, lastId: '', sequence: 0, denied: '', pending: false, release: null as null | (() => void), events: [] as string[], stages: [] as string[] };
export async function waitClassStand(path: string) {
  if (classStand.pending && path.includes('/catalog-classes/plan')) await new Promise<void>(resolve => { classStand.release = resolve; });
  if (kitStand.pending && path === '/api/docflow/kits/plan') await new Promise<void>(resolve => { kitStand.release = resolve; });
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const brief = ({ row: _row, ...rest }: ReturnType<typeof item>): LinkedItemBrief => rest;

/** Ответ стенда на запрос документооборота; undefined — запрос не наш. */
export function docflowFetch(path: string, init?: RequestInit): Response | undefined {
  if (!DOCFLOW) return undefined;
  const method = (init?.method || 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (method !== 'GET') posts.push({ url: path, body });
  if (path.startsWith('/api/catalog') && method === 'GET') return json({ classes: [{ id: 'class-fan', code: 'FAN', title: { ru: 'Вентилятор' } }, { id: 'class-ahu', code: 'AHU', title: { ru: 'Установка' } }], families: [], components: [], manufacturers: [], tagRules: [] });
  if (path === '/api/roles' && method === 'GET') return json({ roles: [{ code: 'ENGINEER', name: 'Инженер' }] });
  if (path.startsWith('/api/docflow/tags?') && method === 'GET') {
    const stage = new URL(path, 'http://fixture').searchParams.get('stage') || '';
    kitStand.stages.push(stage);
    const document = (id: string, contractorNo: string, vdrCode: string) => ({ id, registerId: 'r1', contractorNo, ownerNo: '', vendorNo: '', titleRu: 'Общий вид', vdrCode, revision: 'A', status: 'DRAFT', dueDate: null });
    const requirements = [
      { key: 'manual', docType: 'C32', title: 'Опросный лист', unit: 'tag', scopeId: 'tag-1', needed: true, problem: '', state: 'Строка без файла', hasFile: false, item: document('i-manual', 'MANUAL-001', 'C32') },
      { key: 'missing', docType: 'E02', title: 'Общий вид', unit: 'tag', scopeId: 'tag-1', needed: true, problem: '', state: kitStand.created ? 'Строка без файла' : 'Нет строки', hasFile: false, item: kitStand.created ? document('i-created', '3700-B01-E02-001', 'E02') : null },
    ];
    return json({ tags: [{ id: 'tag-1', identifier: 'П1', classId: 'class-fan', removed: false, items: [], requirements }], totals: { needed: 2, existing: requirements.filter(r => r.hasFile).length, issued: 0, overdue: 0 }, registers: [{ id: 'r1', name: 'ВДР' }], lastPlanId: kitStand.lastId || null });
  }
  if (path.startsWith('/api/docflow/kits/') && method === 'POST') {
    if (kitStand.denied) return json({ error: kitStand.denied }, 403);
    if (path.endsWith('/plan')) return json({ id: `kit-plan-${++kitStand.sequence}`, expiresAt: '2099-01-01T00:00:00.000Z', rows: [{ key: 'missing', tags: ['П1'], tagIds: ['tag-1'], docType: 'E02', unit: 'tag', scopeId: 'tag-1', necessity: 'required', cipher: '3700-B01-E02-001', fileName: '3700-B01-E02-001_A.pdf', titleRu: 'Общий вид', assignee: 'Инженер', dueDate: '2026-12-15', action: kitStand.created ? 'keep' : 'create', problem: '' }] });
    if (path.endsWith('/apply')) { kitStand.created = true; kitStand.lastId = body.planId; kitStand.events.push('apply'); return json({ ok: true }); }
    if (path.endsWith('/undo')) { kitStand.created = false; kitStand.lastId = ''; kitStand.events.push('undo'); return json({ ok: true }); }
  }
  if (path.startsWith('/api/projects/project-1/tags')) return json([{ id: 'tag-1', identifier: 'П1', equipment: { type: 'AHU', catalogClassId: classStand.value } }]);
  if (path.includes('/catalog-classes/')) {
    if (classStand.denied) return json({ error: classStand.denied }, 403);
    if (path.endsWith('/last')) return json({ id: classStand.lastId || null });
    if (path.endsWith('/plan')) { const choice = body?.overrides?.[0]?.classId || config.equipmentClasses.find(x => x.type === 'AHU')?.classId || ''; classStand.planned = choice; return json({ id: `plan-${++classStand.sequence}`, rows: [{ tagId: 'tag-1', tag: 'П1', type: 'AHU', before: classStand.value, classId: choice, classCode: choice === 'class-fan' ? 'FAN' : 'AHU', action: choice && choice !== classStand.value ? 'set' : 'keep', source: 'настройки проекта', problem: '' }] }); }
    if (path.endsWith('/apply')) { classStand.before = classStand.value; classStand.value = classStand.planned; classStand.lastId = body.planId; classStand.events.push('apply'); return json({ ok: true }); }
    if (path.endsWith('/undo')) { classStand.value = classStand.before; classStand.lastId = ''; classStand.events.push('undo'); return json({ ok: true }); }
  }
  if (path === '/api/docflow/settings/copy-plan' && method === 'POST') {
    const next = mergeSections(config, sourceConfig, body.sections);
    return json({ source: { kind: 'project', name: 'Проект 2', at: '' }, expected: '2026-11-01T00:00:00.000Z', sections: diffSections(config, next, body.sections) });
  }
  if (path === '/api/docflow/settings/copy-apply' && method === 'POST') {
    config = mergeSections(config, sourceConfig, body.sections); classStand.events.push('copy');
  }
  if (path === '/api/docflow/settings' && method === 'PUT') { config = normalizeDocflowConfig(body.config); classStand.events.push('settings'); }
  if (path.startsWith('/api/docflow/settings')) return json({ projectId: 'project-1', config, source: { kind: 'default', name: 'по умолчанию', at: '' }, stored: true, updatedAt: '2026-11-01T00:00:00.000Z', canUndo: false, undoLabel: '' });
  if (path.startsWith('/api/docflow/links/plan')) {
    const found = items.find((i) => i.id === body.itemId)!;
    const check = checkName(config, body.fileName, found.row);
    return json({ check, expectedName: buildFileName(config, found.row, /\.[^.]+$/.exec(body.fileName)?.[0] || ''), blocked: !check.ok, reason: check.blocking.map((f) => f.text).join('; '), sameRevisionFile: null, row: found.row });
  }
  if (path === '/api/docflow/links/lock' && method === 'POST') {
    const target = links.find((l) => l.id === body.linkId && l.itemId === body.itemId);
    if (!target) return json({ error: 'Связь не найдена' }, 404);
    target.locked = body.locked === true;
    if (target.locked) { target.lockedAt = '2026-11-08T09:00:00.000Z'; target.lockedByName = 'Администратор'; } else { target.unlockedAt = '2026-11-08T09:00:00.000Z'; target.unlockedByName = 'Администратор'; }
    return json({ link: target });
  }
  if (path === '/api/docflow/issue/plan' && method === 'POST') {
    const rows = body.rows.map((r: any) => {
      const row = items.find((i) => i.id === r.itemId)!;
      const status = config.statuses.find((x) => x.code === row.status);
      const problems = [...(status?.issue ? [] : [`Статус «${status?.label}» не разрешает выпуск`]), ...(/^[0-9a-f]{64}$/.test(r.sha256) ? [] : ['Отпечаток файла не получен: выпуск возможен только из программы на компьютере'])];
      return { ...r, revision: row.revision, cipher: row.cipher, title: row.title, fileName: links.find((l) => l.id === r.linkId)?.fileName || '', status: row.status, problems, notes: [] };
    });
    return json({ id: 'issue-plan-1', projectId: 'project-1', rows, ok: rows.every((r: any) => !r.problems.length), expiresAt: '2099-01-01T00:00:00.000Z' });
  }
  if (path === '/api/docflow/issue/apply' && method === 'POST') { issueStand.issued = true; issueStand.lastHashes = body.hashes; items.find((i) => i.id === 'i5')!.status = 'ISSUED'; return json({ id: body.planId, count: 1, issues: [{ itemId: 'i5', revision: 'A', linkId: 'l5' }] }); }
  if (path === '/api/docflow/issue/undo' && method === 'POST') { issueStand.issued = false; issueStand.undone = true; items.find((i) => i.id === 'i5')!.status = 'READY'; return json({ ok: true }); }
  if (path.startsWith('/api/docflow/issue/last')) return json(null);
  if (path.startsWith('/api/docflow/links/track') || path.startsWith('/api/docflow/links/unlink')) return json({ links: [] });
  if (path.startsWith('/api/docflow/links') && method === 'POST') return json({ link: link('new', body.itemId, 'A', body.relativePath, { fileName: body.fileName }), replaced: null, check: null });
  if (path.startsWith('/api/docflow/links?itemId=')) { const id = new URL(path, 'http://x').searchParams.get('itemId'); return json({ links: links.filter((l) => l.itemId === id), items: {}, issues: [] }); }
  if (path.startsWith('/api/docflow/links')) return json({ links, items: Object.fromEntries(items.map((i) => [i.id, brief(i)])), issues: issueStand.issued ? [{ id: 'is1', itemId: 'i5', revision: 'A', reason: 'IFR', date: '2026-11-08', linkId: 'l5', sha256: 'a'.repeat(64), authorId: 'admin', createdAt: '2026-11-08T09:00:00.000Z', changed: false }] : [] });
  if (path.startsWith('/api/vdr/items/search')) return json({ items: items.map((i) => ({ id: i.id, registerId: 'r1', registerName: 'ВДР', contractorNo: i.cipher, ownerNo: '', vendorNo: '', titleRu: i.title, titleEn: '', vdrCode: i.vdrCode, revision: i.revision, status: i.status })) });
  if (path.startsWith('/api/vdr/registers')) return json({ registers: [{ id: 'r1', projectId: 'project-1', name: 'ВДР', poNumber: '3700', columnsConfig: [], revisions: [], counts: {} }] });
  if (path.startsWith('/api/vdr/items?registerId')) return json({ items: items.map((i) => ({ id: i.id, registerId: 'r1', projectId: 'project-1', contractorNo: i.cipher, ownerNo: '', vendorNo: '', titleEn: '', titleRu: i.title, vdrCode: i.vdrCode, revision: i.revision, status: i.status, equipmentTags: '[]', remarks: '', reviewCode: '', extra: {}, tagLinks: [], unmatchedTags: [], assigneeId: null, dueDate: i.dueDate, updatedAt: '2026-11-01T00:00:00.000Z' })) });
  if (path.startsWith('/api/vdr/standards')) return json({ standards: [] });
  if (path.startsWith('/api/vdr/tag-links')) return json({ plan: null });
  if (path.startsWith('/api/users')) return json({ users: [] });
  return undefined;
}
