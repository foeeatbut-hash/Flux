import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { testCredentials } from './testCredentials';

const BASE = process.env.FLUX_API || 'http://127.0.0.1:4310';
const PROJECT_ID = process.env.FLUX_PROJECT_ID || '';
const ADMIN = testCredentials();
const PEER = { symbol: process.env.FLUX_PEER_USER || '', password: process.env.FLUX_PEER_PASS || '' };
if (!PROJECT_ID || !PEER.symbol || !PEER.password) throw new Error('Ожидается принадлежащий тесту fixture: задайте FLUX_PROJECT_ID и синтетические FLUX_PEER_USER/FLUX_PEER_PASS.');

let failures = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  if (condition) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)); }
};
const sha256 = async (bytes: Buffer) => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
};
let token = '';
let peerToken = '';
const request = async (method: string, route: string, body?: unknown, asPeer = false) => {
  const response = await fetch(BASE + route, {
    method,
    headers: {
      ...(asPeer ? (peerToken ? { Authorization: `Bearer ${peerToken}` } : {}) : (token ? { Authorization: `Bearer ${token}` } : {})),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { }
  return { status: response.status, json, text, response };
};
const raw = async (method: string, route: string, body: Buffer, headers: Record<string, string> = {}) => {
  const response = await fetch(BASE + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', ...headers }, body });
  const bytes = Buffer.from(await response.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { }
  return { status: response.status, json, bytes };
};
const login = async (credentials: { symbol: string; password: string }) => {
  const result = await request('POST', '/api/login', credentials);
  return result.json?.token || '';
};

function officePackage(kind: 'docx' | 'xlsx'): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="' + (kind === 'docx' ? 'word/document.xml' : 'xl/workbook.xml') + '"/></Relationships>');
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/' + (kind === 'docx' ? 'word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' : 'xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>') + '</Types>');
  if (kind === 'docx') zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>');
  else {
    zip.file('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
    zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
    zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>');
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function upload(name: string, bytes: Buffer): Promise<string> {
  const created = await request('POST', '/api/files', { name, filePath: `/shared/${name}` });
  const id = String(created.json?.file?.id || created.json?.id || '');
  check(`${name} created through file API`, created.status === 200 && !!id, created.json);
  if (!id) return '';
  const chunk = await request('POST', `/api/files/${encodeURIComponent(id)}/chunk`, { idx: 0, data: bytes.toString('base64') });
  const done = await request('POST', `/api/files/${encodeURIComponent(id)}/done`, { count: 1 });
  check(`${name} bytes uploaded through file API`, chunk.status === 200 && done.status === 200, [chunk.status, done.status]);
  return id;
}

const schema = (sourceRevision: string) => ({ version: 1, anchors: [
  { kind: 'word-row', id: 'word-header', documentPart: 'word/document.xml', parts: [{ kind: 'field', binding: { fieldKey: 'name', sourceId: 'equipment', entityType: 'element', entityId: null, sourceRevision, anchorId: 'word-header' } }] },
  { kind: 'excel-range', id: 'xlsx-header', sheetName: 'Sheet1', address: 'A1', parts: [{ kind: 'field', binding: { fieldKey: 'param:Аэродинамика|Расход воздуха', sourceId: 'equipment', entityType: 'element', entityId: null, sourceRevision, unit: 'м³/ч', anchorId: 'xlsx-header' } }] },
] });

void (async () => {
  const createdFiles: string[] = [];
  let personalId = '', sharedId = '';
  try {
    token = await login(ADMIN);
    peerToken = await login(PEER);
    check('synthetic owner and peer authenticate', !!token && !!peerToken);
    if (!token || !peerToken) throw new Error('Fixture login failed');

    console.log('1. Project catalog, units, row query and revisions');
    const catalog = await request('GET', `/api/project-data/catalog?projectId=${encodeURIComponent(PROJECT_ID)}`);
    const airflow = catalog.json?.params?.find((item: any) => item.group === 'Аэродинамика' && item.key === 'Расход воздуха');
    check('catalog exposes synthetic equipment fields and parameter metadata', catalog.status === 200 && catalog.json?.elementFields?.some((field: any) => field.path === 'name') && !!airflow, catalog.json);
    check('catalog keeps source unit metadata', airflow?.unit === 'м³/ч', airflow);

    const query = { entity: 'element', columns: ['name', 'equipType', 'param:Аэродинамика|Расход воздуха'], filters: [], sort: [{ field: 'name', dir: 'asc' }], limit: 50, excludedEntityIds: [] };
    const data = await request('POST', '/api/project-data/office/query', { projectId: PROJECT_ID, query });
    const fan = data.json?.rows?.find((row: any) => row.values?.name?.value === 'FAN_HIGH');
    check('query returns stable entity identity and project revision', data.status === 200 && !!data.json?.revision && !!fan?.entityId, data.json);
    check('query returns numeric values with source units and revision', fan?.values?.['param:Аэродинамика|Расход воздуха']?.value === 1200 && fan?.values?.['param:Аэродинамика|Расход воздуха']?.unit === 'м³/ч' && !!fan?.values?.['param:Аэродинамика|Расход воздуха']?.revision, fan);
    check('query rejects a stale source revision', (await request('POST', '/api/project-data/office/query', { projectId: PROJECT_ID, sourceRevision: 'stale-revision', query })).status === 409);

    console.log('2. Synthetic DOCX/XLSX state, repeated rows and compare-and-set preview');
    const docId = await upload(`__office_api_${Date.now()}.docx`, await officePackage('docx'));
    const xlsxId = await upload(`__office_api_${Date.now()}.xlsx`, await officePackage('xlsx'));
    createdFiles.push(...[docId, xlsxId].filter(Boolean));
    if (!docId || !xlsxId || !fan) throw new Error('Office fixture setup failed');
    const initialDocState = await request('GET', `/api/project-data/files/${docId}/office-state`);
    const initialXlsxState = await request('GET', `/api/project-data/files/${xlsxId}/office-state`);
    check('DOCX and XLSX return empty versioned schema state and hashes', initialDocState.status === 200 && initialXlsxState.status === 200 && !!initialDocState.json?.baseHash && initialDocState.json?.schema?.version === 1 && !!initialXlsxState.json?.baseHash, [initialDocState.json, initialXlsxState.json]);

    const officeSchema = schema(data.json.revision);
    const previewBody = { projectId: PROJECT_ID, baseHash: initialDocState.json.baseHash, sourceRevision: data.json.revision, selectedEntityIds: [fan.entityId], query, schema: officeSchema };
    const preview = await request('POST', `/api/project-data/files/${docId}/preview`, previewBody);
    check('preview maps selected row into Word and Excel anchor metadata', preview.status === 200 && !!preview.json?.planId && preview.json?.adds?.includes(fan.entityId) && preview.json?.writes?.some((item: any) => item.anchorId === 'word-header' && item.value === 'FAN_HIGH') && preview.json?.writes?.some((item: any) => item.anchorId === 'xlsx-header' && item.value === 1200 && item.unit === 'м³/ч'), preview.json);
    check('preview rejects stale document hash', (await request('POST', `/api/project-data/files/${docId}/preview`, { ...previewBody, baseHash: 'stale-hash' })).status === 409);
    check('preview rejects stale source revision', (await request('POST', `/api/project-data/files/${docId}/preview`, { ...previewBody, sourceRevision: 'stale-revision' })).status === 409);
    const confirmBody = { ...previewBody, planId: preview.json?.planId };
    const confirm = await request('POST', `/api/project-data/files/${docId}/confirm`, confirmBody);
    check('confirm rechecks the same plan and returns ready-for-editor', confirm.status === 200 && confirm.json?.status === 'ready-for-editor' && confirm.json?.writes?.length === preview.json?.writes?.length, confirm.json);
    check('confirm rejects stale document hash, source revision, or plan identity',
      (await request('POST', `/api/project-data/files/${docId}/confirm`, { ...confirmBody, baseHash: 'stale-hash' })).status === 409
      && (await request('POST', `/api/project-data/files/${docId}/confirm`, { ...confirmBody, sourceRevision: 'stale-revision' })).status === 409
      && (await request('POST', `/api/project-data/files/${docId}/confirm`, { ...confirmBody, planId: 'stale-plan' })).status === 409);
    const savedDocState = await request('PUT', `/api/project-data/files/${docId}/office-state`, { baseHash: initialDocState.json.baseHash, sourceRevision: data.json.revision, schema: officeSchema });
    const readDocState = await request('GET', `/api/project-data/files/${docId}/office-state`);
    check('DOCX stores versioned schema metadata and changes its file hash', savedDocState.status === 200 && readDocState.json?.schema?.anchors?.length === 2 && readDocState.json?.baseHash !== initialDocState.json.baseHash, [savedDocState.json, readDocState.json]);
    check('DOCX schema metadata save rejects reuse of the prior hash', (await request('PUT', `/api/project-data/files/${docId}/office-state`, { baseHash: initialDocState.json.baseHash, sourceRevision: data.json.revision, schema: officeSchema })).status === 409);
    const repeatedRows = [
      { entityId: fan.entityId, entityType: 'element', sourceId: 'equipment', sourceRevision: data.json.revision, anchorIds: ['word-header', 'xlsx-header'], cells: { 'word-header': 'B2', 'xlsx-header': 'A2' }, values: { 'word-header': 'FAN_HIGH', 'xlsx-header': '1200 м³/ч' } },
      { entityId: fan.entityId, entityType: 'element', sourceId: 'equipment', sourceRevision: data.json.revision, anchorIds: ['word-header'], cells: { 'word-header': 'B3' }, values: { 'word-header': 'duplicate row' } },
      { entityId: 'manual:synthetic-row', entityType: 'manual', sourceId: '', sourceRevision: data.json.revision, anchorIds: ['word-header'], cells: { 'word-header': 'B4' }, values: { 'word-header': 'manual row' } },
    ];
    const savedState = await request('PUT', `/api/project-data/files/${xlsxId}/office-state`, { baseHash: initialXlsxState.json.baseHash, sourceRevision: data.json.revision, schema: officeSchema, rows: repeatedRows });
    const readState = await request('GET', `/api/project-data/files/${xlsxId}/office-state`);
    check('XLSX state save uses base hash compare-and-set', savedState.status === 200 && savedState.json?.ok && !!savedState.json?.baseHash, savedState.json);
    check('XLSX state keeps schema anchors, duplicate entity rows, cell references, values and manual metadata', readState.status === 200 && readState.json?.schema?.anchors?.length === 2 && readState.json?.rows?.length === 3 && readState.json?.rows?.[0]?.cells?.['xlsx-header'] === 'A2' && readState.json?.rows?.[0]?.values?.['xlsx-header'] === '1200 м³/ч' && readState.json?.rows?.[1]?.values?.['word-header'] === 'duplicate row' && readState.json?.rows?.[2]?.cells?.['word-header'] === 'B4' && readState.json?.rows?.[2]?.values?.['word-header'] === 'manual row', readState.json);
    check('XLSX state rejects stale hash', (await request('PUT', `/api/project-data/files/${xlsxId}/office-state`, { baseHash: initialXlsxState.json.baseHash, sourceRevision: data.json.revision, schema: officeSchema, rows: [] })).status === 409);

    console.log('3. Personal/shared template persistence, pins and owner ACL');
    const personal = await request('POST', '/api/project-data/office/templates', { name: 'Synthetic personal template', scope: 'PERSONAL', schema: officeSchema, query }, true);
    personalId = String(personal.json?.template?.id || '');
    check('peer creates a persistent personal template', personal.status === 200 && !!personalId && personal.json.template.ownerId, personal.json);
    const peerTemplates = await request('GET', '/api/project-data/office/templates', undefined, true);
    const adminTemplates = await request('GET', '/api/project-data/office/templates');
    check('personal template appears only for its owner', peerTemplates.json?.templates?.some((item: any) => item.id === personalId) && !adminTemplates.json?.templates?.some((item: any) => item.id === personalId));
    const updatedPersonal = await request('PUT', `/api/project-data/office/templates/${personalId}`, { name: 'Synthetic personal template updated', description: 'updated', schema: officeSchema, query }, true);
    check('owner updates personal template', updatedPersonal.status === 200 && updatedPersonal.json?.template?.name === 'Synthetic personal template updated', updatedPersonal.json);
    check('another user cannot edit personal template', (await request('PUT', `/api/project-data/office/templates/${personalId}`, { name: 'hijack', schema: officeSchema }, false)).status === 404);
    const peerPin = await request('POST', `/api/project-data/office/templates/${personalId}/pin`, { pinned: true }, true);
    check('owner can pin personal template', peerPin.status === 200 && peerPin.json?.pinned?.includes(personalId), peerPin.json);

    const shared = await request('POST', '/api/project-data/office/templates', { name: 'Synthetic shared template', scope: 'SHARED', schema: officeSchema, query });
    sharedId = String(shared.json?.template?.id || '');
    check('administrator creates a shared template', shared.status === 200 && !!sharedId && shared.json?.template?.scope === 'SHARED', shared.json);
    const peerSeesShared = await request('GET', '/api/project-data/office/templates', undefined, true);
    check('shared template is visible to other employees', peerSeesShared.json?.templates?.some((item: any) => item.id === sharedId));
    const sharedUpdated = await request('PUT', `/api/project-data/office/templates/${sharedId}`, { name: 'Synthetic shared template updated', schema: officeSchema, query });
    check('shared template creator can update shared template', sharedUpdated.status === 200 && sharedUpdated.json?.template?.scope === 'SHARED' && sharedUpdated.json?.template?.name === 'Synthetic shared template updated', sharedUpdated.json);
    check('non-creator employee cannot modify shared template', (await request('PUT', `/api/project-data/office/templates/${sharedId}`, { name: 'hijack', schema: officeSchema }, true)).status === 404);
    const peerSharedPin = await request('POST', `/api/project-data/office/templates/${sharedId}/pin`, { pinned: true }, true);
    check('employee can pin visible shared template', peerSharedPin.status === 200 && peerSharedPin.json?.pinned?.includes(sharedId), peerSharedPin.json);
    const unpinned = await request('POST', `/api/project-data/office/templates/${personalId}/pin`, { pinned: false }, true);
    check('owner can unpin template', unpinned.status === 200 && !unpinned.json?.pinned?.includes(personalId), unpinned.json);
    const deletedPersonal = await request('DELETE', `/api/project-data/office/templates/${personalId}`, undefined, true);
    personalId = '';
    check('owner deletes personal template and clears its pin', deletedPersonal.status === 200 && deletedPersonal.json?.deleted === true);
    const deletedShared = await request('DELETE', `/api/project-data/office/templates/${sharedId}`);
    sharedId = '';
    check('shared template creator deletes shared template', deletedShared.status === 200 && deletedShared.json?.deleted === true);
  } catch (error: any) {
    check('Office addon API contract run completed', false, String(error?.message || error));
  } finally {
    for (const id of createdFiles) await request('DELETE', `/api/files/${encodeURIComponent(id)}`).catch(() => {});
    if (personalId) await request('DELETE', `/api/project-data/office/templates/${personalId}`, undefined, true).catch(() => {});
    if (sharedId) await request('DELETE', `/api/project-data/office/templates/${sharedId}`).catch(() => {});
  }
  console.log(failures ? `\nOffice addon API failures: ${failures}` : '\nOffice addon API contracts passed');
  process.exitCode = failures ? 1 : 0;
})();
