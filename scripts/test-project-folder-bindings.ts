import assert from 'node:assert/strict';
import { effectiveProjectIds, isSafeBindingPath, reanchorBinding, resolveBoundProject, validateBinding, type ProjectFolderBinding } from '../src/lib/projectFolderBindings.js';

const base: ProjectFolderBinding = { id: 'b1', actorId: 'u1', deviceId: 'd1', rootId: 'r1', canonicalFolderId: 'folder-1', relativePath: 'Engineering', projectId: 'p1' };
const checks: Array<[string, () => void]> = [
  ['rejects absolute and parent paths', () => { assert.equal(isSafeBindingPath('C:\\secret'), false); assert.equal(isSafeBindingPath('../secret'), false); assert.equal(isSafeBindingPath('/secret'), false); }],
  ['accepts relative Windows paths', () => assert.equal(isSafeBindingPath('Engineering\\Unit 1'), true)],
  ['validates durable scope identifiers', () => validateBinding(base)],
  ['resolves the closest matching boundary', () => assert.equal(resolveBoundProject([base, { ...base, id: 'b2', canonicalFolderId: 'folder-2', relativePath: 'Engineering/Unit 1', projectId: 'p2' }], { rootId: 'r1', canonicalFileId: 'file', relativePath: 'Engineering/Unit 1/plan.xlsx' }), 'p2')],
  ['matches path components instead of string prefixes', () => assert.equal(resolveBoundProject([base], { rootId: 'r1', canonicalFileId: 'file', relativePath: 'Engineering-old/plan.xlsx' }), null)],
  ['does not cross roots', () => assert.equal(resolveBoundProject([base], { rootId: 'other', canonicalFileId: 'file', relativePath: 'Engineering/plan.xlsx' }), null)],
  ['preserves manual project metadata', () => assert.deepEqual(effectiveProjectIds(['manual', 'manual'], 'inherited'), ['manual'])],
  ['inherits only when manual metadata is absent', () => assert.deepEqual(effectiveProjectIds([], 'inherited'), ['inherited'])],
  ['reanchors only the matching canonical identity', () => { assert.equal(reanchorBinding(base, { rootId: 'r1', canonicalFileId: 'folder-1', relativePath: 'Renamed' }).relativePath, 'Renamed'); assert.equal(reanchorBinding(base, { rootId: 'r1', canonicalFileId: 'replacement', relativePath: 'Engineering' }), base); }],
];

let failed = 0;
for (const [name, check] of checks) {
  try { check(); console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}`, error); }
}
console.log(`${checks.length - failed}/${checks.length} project folder binding checks passed`);
if (failed) process.exitCode = 1;
