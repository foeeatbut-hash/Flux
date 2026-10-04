import assert from 'node:assert/strict';
import { base64ToBytes, bytesToBase64, decodeWindowsFileRef, fileRefHref, fileRefFromSearch } from '../src/lib/windowsFiles';

const ref = { rootId: 'documents', relativePath: 'Проект 7/Схема #1.pdf', draftId: 'draft:α' };
const href = fileRefHref(ref);
assert.equal(href, '/windows-file?root=documents&path=%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82+7%2F%D0%A1%D1%85%D0%B5%D0%BC%D0%B0+%231.pdf&draft=draft%3A%CE%B1');
assert.deepEqual(fileRefFromSearch(href.slice(href.indexOf('?'))), ref,
  'Unicode, spaces, reserved path characters, and draft identity survive URL round-trip');
assert.deepEqual(decodeWindowsFileRef(href), ref,
  'opening the encoded Windows file reference preserves the same target');
assert.equal(fileRefFromSearch('?path=missing-root'), null,
  'an incomplete reference cannot resolve to a different file');

const original = Uint8Array.from([0, 0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x80, 0x0a, 0, 0x7f]);
const encoded = bytesToBase64(original);
assert.deepEqual(base64ToBytes(encoded), original,
  'synthetic binary file bytes survive renderer transfer without text conversion');

console.log('Windows file references and byte transfer: 5 checks PASS');
