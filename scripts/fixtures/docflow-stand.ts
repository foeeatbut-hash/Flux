/**
 * Стенд документооборота для браузерных проверок (?docflow=1 у windows-explorer-ui.html):
 * папка проекта «Проекты», привязанная как рабочая, строки ВДР, связи файлов и ответы сервера
 * на запросы Проводника и ДО. Проверка имени — настоящая (shared/docflow/nameMask), чтобы
 * стенд не мог согласиться с тем, с чем не согласился бы сервер.
 */
import { normalizeDocflowConfig } from '../../shared/docflow/config';
import { buildFileName, checkName, type RowForCheck } from '../../shared/docflow/nameMask';
import type { DocLinkDto, LinkedItemBrief } from '../../shared/docflow/links';
import type { WindowsFileEntry } from '../../filesystem/contracts';

export const DOCFLOW = new URLSearchParams(location.search).get('docflow') === '1';
/** Ключ места так же, как его считает стенд моста (locationKeys): по пути в нижнем регистре. */
export const keyOfPath = (path: string) => Array.from(new TextEncoder().encode(`net:${path.toLowerCase()}`), (b) => b.toString(16).padStart(2, '0')).join('');

const WORK_KEY = keyOfPath('Проекты');
const RETURNS_KEY = keyOfPath('Возвраты');
let config = normalizeDocflowConfig({ vdrTypes: [{ code: 'E02', titleRu: 'Общий вид', titleEn: '' }, { code: 'C32', titleRu: 'Опросный лист', titleEn: '' }] });
const file = (name: string, fileId: string, size: number): WindowsFileEntry => ({ name, relativePath: `Проекты/${name}`, storage: 'windows', kind: 'file', fileId, size, modifiedAt: '2026-11-04T09:00:00.000Z', linked: false });

export const docflowFiles: WindowsFileEntry[] = DOCFLOW ? [
  file('3700-B01-E02-001_B.pdf', 'df-1', 2048), file('3700-B01-E02-004_A.pdf', 'df-2', 1500),
  file('черновик.docx', 'df-3', 800), file('3700-B01-E02-001.pdf', 'df-4', 1200),
] : [];

const item = (id: string, no: string, revision: string, status: string, title: string, extra: Partial<LinkedItemBrief> = {}): LinkedItemBrief & { row: RowForCheck } => ({
  id, cipher: no, title, vdrCode: 'E02', revision, status, registerId: 'r1', dueDate: null, assignee: '', tags: [], row: { contractorNo: no, vdrCode: 'E02', revision }, ...extra,
});
const items = [
  item('i1', '3700-B01-E02-001', 'C', 'ISSUED', 'Общий вид установки П1', { assignee: 'Иванов И. И.', dueDate: '2026-11-20T00:00:00.000Z', tags: ['П1'] }),
  item('i2', '3700-B01-E02-002', 'A', 'DRAFT', 'Общий вид установки П2'),
  item('i4', '3700-B01-E02-004', 'A', 'CHECK', 'Общий вид установки П4'),
];
const link = (id: string, itemId: string, revision: string, relativePath: string, over: Partial<DocLinkDto> = {}): DocLinkDto => ({
  id, itemId, projectId: 'project-1', revision, role: 'file', toLinkId: null, folderKey: WORK_KEY, relativePath, fileName: relativePath.split('/').pop()!, sha256: 'a'.repeat(64), size: 0,
  reviewCode: '', receivedAt: null, lostAt: null, linkedById: 'admin', createdAt: '2026-11-01T09:00:00.000Z', unlinkedAt: null, unlinkReason: '', ...over,
});
export const links: DocLinkDto[] = DOCFLOW ? [
  link('l1', 'i1', 'B', '3700-B01-E02-001_B.pdf', { size: 2048 }),
  link('l2', 'i2', 'A', '3700-B01-E02-002_A.pdf', { size: 100 }), // файла в папке нет: слежение пометит «не найден»
  link('l3', 'i1', 'B', 'E02/Замечания.pdf', { role: 'remarks', toLinkId: 'l1', folderKey: RETURNS_KEY, reviewCode: '2', receivedAt: '2026-11-03T00:00:00.000Z' }),
] : [];

export const docflowBindings = DOCFLOW ? [
  { id: 'b-work', locationKey: WORK_KEY, projectId: 'project-1', label: 'Проекты', actorId: 'admin', at: '2026-10-01T00:00:00.000Z', purpose: 'work', locator: { folderKey: WORK_KEY, anchors: [{ key: WORK_KEY, relativePath: '' }] } },
  { id: 'b-ret', locationKey: RETURNS_KEY, projectId: 'project-1', label: 'Возвраты', actorId: 'admin', at: '2026-10-01T00:00:00.000Z', purpose: 'returns' },
] : [];

export const posts: Array<{ url: string; body: any }> = [];
export const classStand = { value: '', before: '', planned: '', lastId: '', sequence: 0, denied: '', events: [] as string[], pending: false, release: null as null | (() => void) };
export async function waitClassStand(path: string) {
  if (classStand.pending && path.includes('/catalog-classes/plan')) await new Promise<void>(resolve => { classStand.release = resolve; });
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
  if (path.startsWith('/api/projects/project-1/tags')) return json([{ id: 'tag-1', identifier: 'П1', equipment: { type: 'AHU', catalogClassId: classStand.value } }]);
  if (path.includes('/catalog-classes/')) {
    if (classStand.denied) return json({ error: classStand.denied }, 403);
    if (path.endsWith('/last')) return json({ id: classStand.lastId || null });
    if (path.endsWith('/plan')) { const choice = body?.overrides?.[0]?.classId || config.equipmentClasses.find(x => x.type === 'AHU')?.classId || ''; classStand.planned = choice; return json({ id: `plan-${++classStand.sequence}`, rows: [{ tagId: 'tag-1', tag: 'П1', type: 'AHU', before: classStand.value, classId: choice, classCode: choice === 'class-fan' ? 'FAN' : 'AHU', action: choice && choice !== classStand.value ? 'set' : 'keep', source: 'настройки проекта', problem: '' }] }); }
    if (path.endsWith('/apply')) { classStand.before = classStand.value; classStand.value = classStand.planned; classStand.lastId = body.planId; classStand.events.push('apply'); return json({ ok: true }); }
    if (path.endsWith('/undo')) { classStand.value = classStand.before; classStand.lastId = ''; classStand.events.push('undo'); return json({ ok: true }); }
  }
  if (path === '/api/docflow/settings' && method === 'PUT') { config = normalizeDocflowConfig(body.config); classStand.events.push('settings'); }
  if (path.startsWith('/api/docflow/settings')) return json({ projectId: 'project-1', config, source: { kind: 'default', name: 'по умолчанию', at: '' }, stored: true, updatedAt: '2026-11-01T00:00:00.000Z', canUndo: false, undoLabel: '' });
  if (path.startsWith('/api/docflow/links/plan')) {
    const found = items.find((i) => i.id === body.itemId)!;
    const check = checkName(config, body.fileName, found.row);
    return json({ check, expectedName: buildFileName(config, found.row, /\.[^.]+$/.exec(body.fileName)?.[0] || ''), blocked: !check.ok, reason: check.blocking.map((f) => f.text).join('; '), sameRevisionFile: null, row: found.row });
  }
  if (path.startsWith('/api/docflow/links/track') || path.startsWith('/api/docflow/links/unlink')) return json({ links: [] });
  if (path.startsWith('/api/docflow/links') && method === 'POST') return json({ link: link('new', body.itemId, 'A', body.relativePath, { fileName: body.fileName }), replaced: null, check: null });
  if (path.startsWith('/api/docflow/links?itemId=')) { const id = new URL(path, 'http://x').searchParams.get('itemId'); return json({ links: links.filter((l) => l.itemId === id), items: {} }); }
  if (path.startsWith('/api/docflow/links')) return json({ links, items: Object.fromEntries(items.map((i) => [i.id, brief(i)])) });
  if (path.startsWith('/api/vdr/items/search')) return json({ items: items.map((i) => ({ id: i.id, registerId: 'r1', registerName: 'ВДР', contractorNo: i.cipher, ownerNo: '', vendorNo: '', titleRu: i.title, titleEn: '', vdrCode: i.vdrCode, revision: i.revision, status: i.status })) });
  if (path.startsWith('/api/vdr/registers')) return json({ registers: [{ id: 'r1', projectId: 'project-1', name: 'ВДР', poNumber: '3700', columnsConfig: [], revisions: [], counts: {} }] });
  if (path.startsWith('/api/vdr/items?registerId')) return json({ items: items.map((i) => ({ id: i.id, registerId: 'r1', projectId: 'project-1', contractorNo: i.cipher, ownerNo: '', vendorNo: '', titleEn: '', titleRu: i.title, vdrCode: i.vdrCode, revision: i.revision, status: i.status, equipmentTags: '[]', remarks: '', reviewCode: '', extra: {}, tagLinks: [], unmatchedTags: [], assigneeId: null, dueDate: i.dueDate, updatedAt: '2026-11-01T00:00:00.000Z' })) });
  if (path.startsWith('/api/vdr/standards')) return json({ standards: [] });
  if (path.startsWith('/api/vdr/tag-links')) return json({ plan: null });
  if (path.startsWith('/api/users')) return json({ users: [] });
  return undefined;
}
