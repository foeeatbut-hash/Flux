import assert from 'node:assert/strict';
import { uploadDropped } from '../src/lib/dropUpload.js';
import { WINDOWS_IMPORT_READ_BYTES, type ImportedFileRef } from '../filesystem/contracts.js';

async function main() {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as any).window;
  const size = 70 * 1024 * 1024 + 19;
  const ticket: ImportedFileRef = { ticket: 'ticket-stream', name: 'large.ifc', size };
  let bytesRead = 0; let uploaded = 0; let maxRange = 0; let chunkCount = 0; let released = false;
  (globalThis as any).window = { electron: { windowsFiles: { invoke: async (request: any) => {
    if (request.action === 'readImportRef') {
      const length = Math.min(request.length, size - request.offset);
      bytesRead += length; maxRange = Math.max(maxRange, length);
      return { ok: true, data: { name: ticket.name, size, offset: request.offset, base64: Buffer.alloc(length, request.offset % 251).toString('base64') } };
    }
    if (request.action === 'releaseImportRefs') { released = request.tickets.includes(ticket.ticket); return { ok: true, data: { released: true } }; }
    return { ok: false, error: { code: 'INVALID_ACTION', message: 'unexpected action' } };
  }, onChanged: () => () => {} } } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/limits') return new Response(JSON.stringify({ chunkBytes: WINDOWS_IMPORT_READ_BYTES * 2 }), { status: 200 });
    if (url === '/api/files' && init?.method === 'POST') return new Response(JSON.stringify({ file: { id: 'file-1' } }), { status: 200 });
    if (url === '/api/files/file-1/chunk') {
      const body = JSON.parse(String(init?.body || '{}'));
      const data = Buffer.from(body.data, 'base64');
      uploaded += data.length; chunkCount += 1;
      assert.equal(body.idx, chunkCount - 1);
      assert.ok(data.length <= WINDOWS_IMPORT_READ_BYTES);
      return new Response('{}', { status: 200 });
    }
    if (url === '/api/files/file-1/done') return new Response('{}', { status: 200 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  try {
    const outcome = await uploadDropped([ticket], { folderId: null, scope: 'PERSONAL', userId: 'u1' });
    assert.equal(outcome.ok, 1);
    assert.equal(bytesRead, size);
    assert.equal(uploaded, size);
    assert.ok(maxRange <= WINDOWS_IMPORT_READ_BYTES);
    assert.equal(chunkCount, Math.ceil(size / WINDOWS_IMPORT_READ_BYTES));
    assert.equal(released, true);
    console.log('PASS Desktop upload streams a >64 MiB ticket without building a File');
    console.log('PASS ranged reads, upload chunks, order and ticket release are verified');
    console.log('2/2 import-ref upload checks passed');
  } finally { globalThis.fetch = originalFetch; (globalThis as any).window = originalWindow; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
