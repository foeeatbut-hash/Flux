import assert from 'node:assert/strict';
import type { WindowsFileEntry } from '../src/lib/windowsFiles';
import { visibleDesktopEntries } from '../src/components/desktop/desktopEntries';

const entry = (name: string, storage: WindowsFileEntry['storage'], draftId?: string): WindowsFileEntry =>
  Object.freeze({ name, relativePath: name, storage, draftId, kind: 'file', fileId: name, size: 0, modifiedAt: '', linked: false });
const windows = entry('windows', 'windows');
const flux = entry('flux', 'flux');
const draft = entry('draft', 'windows', 'draft-id');
const entries = Object.freeze([windows, flux, draft]);
const original = JSON.stringify(entries);

assert.deepEqual(visibleDesktopEntries(entries, false), [windows], 'резервный стол показывает только файлы Windows без черновиков');
assert.deepEqual(visibleDesktopEntries(entries, true), [], 'нативная оболочка не получает файловый слой Flux');
assert.equal(JSON.stringify(entries), original, 'исходные записи не меняются');
console.log('3 проверки пройдены');
