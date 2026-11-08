import type { WindowsFilesRequest } from '../../filesystem/contracts';

export const CREATE_STAND = new URLSearchParams(location.search).get('createfiles') === '1';
const folderKey = 'create-work';
const binding = { id: 'create-binding', projectId: 'project-1', locationKey: folderKey, label: 'Проекты', actorId: 'admin', at: '', locator: { folderKey, anchors: [] } };
const templatePath = 'Проекты/Шаблон.docx';
const files: Record<string, string> = { [templatePath]: btoa('template bytes') };
const publications: Record<string, string> = {};
export const createStand = { events: [] as string[], files, denied: false, pending: false, release: null as null | (() => void), completeUnknown: false, completeReject: false, existing: false, sequence: 0, plans: {} as Record<string, any>, last: null as any, selections: [] as any[] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const digest = async (base64: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(atob(base64), c => c.charCodeAt(0)))), n => n.toString(16).padStart(2, '0')).join('');
const content = async (relativePath: string) => ({ name: relativePath.split('/').at(-1), size: atob(files[relativePath]).length, base64: files[relativePath], sha256: await digest(files[relativePath]), fileId: relativePath, kind: 'file' });
const ref = (relativePath: string) => ({ rootId: 'desktop-id', relativePath });

export async function createBridge(request: WindowsFilesRequest): Promise<any | undefined> {
  if (!CREATE_STAND) return undefined;
  if (request.action === 'resolvePortableFolder') return { ok: true, data: ref('Проекты') };
  if (request.action === 'resolveAddress') return { ok: true, data: null };
  if (request.action === 'stat' || request.action === 'fileHash' || request.action === 'read') {
    const p = request.ref.relativePath;
    if (!Object.hasOwn(files, p)) return { ok: false, error: { code: 'ENOENT', message: 'Файл не найден' } };
    return { ok: true, data: await content(p) };
  }
  if (request.action === 'publish') {
    const p = `${request.parent.relativePath}/${request.name}`;
    if (publications[request.draftId] && publications[request.draftId] !== p) return { ok: false, error: { code: 'CONFLICT', message: 'Другое имя публикации' } };
    if (Object.hasOwn(files, p) && !publications[request.draftId]) return { ok: false, error: { code: 'EEXIST', message: 'Имя занято' } };
    if (!publications[request.draftId]) { files[p] = request.base64; publications[request.draftId] = p; createStand.events.push('publish'); }
    return { ok: true, data: { ref: ref(p), file: await content(p) } };
  }
  if (request.action === 'trash') {
    const p = request.ref.relativePath;
    if (!files[p] && !Object.hasOwn(files, p)) return { ok: false, error: { code: 'ENOENT', message: 'Файл не найден' } };
    if (request.baseSha256 && await digest(files[p]) !== request.baseSha256) return { ok: false, error: { code: 'CONFLICT', message: 'Файл изменён' } };
    delete files[p]; createStand.events.push('trash'); return { ok: true, data: { trashed: true } };
  }
  if (request.action === 'open') { createStand.events.push('open'); return { ok: true, data: {} }; }
  return undefined;
}

export async function createFetch(path: string, init?: RequestInit): Promise<Response | undefined> {
  if (!CREATE_STAND || !path.startsWith('/api/docflow/create-files/')) return undefined;
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (path.includes('/state?')) { const u = new URL(path, location.origin); return json(u.searchParams.has('last') ? createStand.last : createStand.plans[u.searchParams.get('planId') || ''] || null); }
  if (path.endsWith('/plan')) {
    createStand.events.push('plan'); createStand.selections.push(body);
    if (createStand.pending) await new Promise<void>(resolve => { createStand.release = resolve; });
    const id = `file-plan-${++createStand.sequence}`;
    const rows = body.itemIds.map((itemId: string) => ({ itemId, revision: 'B', fileName: `${itemId}_B.${body.useTemplates ? 'docx' : body.format}`, relativePath: `${itemId}_B.${body.useTemplates ? 'docx' : body.format}`, folderKey, template: body.useTemplates ? 'Шаблон.docx' : '', format: body.useTemplates ? 'docx' : body.format, action: createStand.existing ? 'open' : 'create', binding, link: createStand.existing ? { itemId, revision: 'B', folderKey, relativePath: `${itemId}_B.${body.useTemplates ? 'docx' : body.format}` } : null }));
    const plan = { id, projectId: 'project-1', rows, workBinding: binding, expiresAt: '2099-01-01', state: 'preview', result: null, files: [] };
    createStand.plans[id] = plan; return json(plan);
  }
  const plan = createStand.plans[body.planId];
  if (!plan) return json({ error: 'План не найден' }, 404);
  if (path.endsWith('/claim')) { createStand.events.push('claim'); if (createStand.denied) return json({ error: 'Нет права создавать файлы' }, 403); plan.files = body.files; return json({ applied: false }); }
  if (path.endsWith('/complete')) {
    createStand.events.push('complete');
    if (createStand.completeReject) return json({ error: 'Связь временно недоступна' }, 503);
    plan.state = 'applied'; plan.result = { id: plan.id, count: plan.files.length, links: plan.files.map((f: any) => { const row = plan.rows.find((r: any) => r.itemId === f.itemId); return { ...f, revision: row.revision, folderKey, relativePath: row.relativePath, fileName: row.fileName }; }) }; createStand.last = plan;
    if (createStand.completeUnknown) return json({ error: 'Ответ потерян' }, 503);
    return json(plan.result);
  }
  if (path.endsWith('/undo-plan')) { createStand.events.push('undo-plan'); return json({ files: plan.result.links }); }
  if (path.endsWith('/undo')) { createStand.events.push('undo'); plan.state = 'undone'; createStand.last = null; return json({}); }
  if (path.endsWith('/cancel')) { createStand.events.push(body.prepareOnly ? 'cancel-plan' : 'cancel'); if (!body.prepareOnly) plan.state = 'cancelled'; return json({}); }
  return json({ error: 'Неизвестный запрос' }, 404);
}
