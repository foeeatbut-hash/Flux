import assert from 'node:assert/strict';
import { canManageOfficeTemplate, templateScopeAllowed } from '../server/routes/projectOffice.js';
import { cleanOfficeTemplate } from '../server/officeTemplates.js';

const schema = { version: 1, anchors: [{ kind: 'excel-range', id: 'a', sheetName: 'Sheet1', address: 'A1', parts: [{ kind: 'text', text: 'Header' }] }] };
const personal = cleanOfficeTemplate({ name: 'Personal', scope: 'PERSONAL', schema, query: { excludedEntityIds: ['tags:tag:excluded'] }, rows: [{ entityId: 'private-row', value: 'secret' }] }, 'owner');
const shared = cleanOfficeTemplate({ name: 'Shared', scope: 'SHARED', schema, query: {} }, 'admin');
assert.equal(templateScopeAllowed(personal, { id: 'owner' }), true);
assert.equal(templateScopeAllowed(personal, { id: 'other' }), false);
assert.equal(templateScopeAllowed(shared, { id: 'other' }), true);
assert.equal(canManageOfficeTemplate(personal, { id: 'other' }, false), false);
assert.equal(canManageOfficeTemplate(personal, { id: 'owner' }, false), true);
assert.equal(canManageOfficeTemplate(shared, { id: 'other' }, false), false);
assert.equal(canManageOfficeTemplate(shared, { id: 'admin' }, false), true);
assert.equal(canManageOfficeTemplate(shared, { id: 'other' }, true), true);
assert.equal(JSON.stringify(personal).includes('private-row'), false);
assert.deepEqual(personal.query.excludedEntityIds, ['tags:tag:excluded']);
console.log('Права владельца, общего доступа и чистка шаблонов проверены');
