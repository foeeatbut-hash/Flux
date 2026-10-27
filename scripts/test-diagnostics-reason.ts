/**
 * Причина отказа API доходит до архива диагностики: и с сервера (`http.end`),
 * и из окна (`fetch.headers`), причём шаблоном без данных проекта.
 *
 * Было: архив показывал «409» трижды подряд и не показывал, чем отказал
 * сервер, поэтому причину приходилось угадывать по коду.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

let checks = 0;
const ok = (label: string, value: unknown, detail?: unknown) => {
  assert.ok(value, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
  checks++; console.log(`  ✓ ${label}`);
};

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-diag-reason-'));
  process.env.FLUX_DIAGNOSTICS_DIR = dir;
  const server = await import('../server/diagnostics');
  const client = await import('../src/lib/diagnostics');
  const app = express();
  app.use(server.traceRequest);
  app.get('/api/equipment/probe/:id', (_req, res) => { res.status(409).json({ error: 'Тег «3700-B01-AS-001A» уже связан с установкой 12' }); });
  app.get('/api/equipment/fine', (_req, res) => { res.json({ ok: true }); });
  const listening = await new Promise<any>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${listening.address().port}`;
  (globalThis as any).location = { href: `${origin}/` };
  try {
    const wrapped = client.diagnosticFetch(fetch);
    const refused = await wrapped(`${origin}/api/equipment/probe/abc`);
    const body = await refused.json();
    ok('тело ответа читается вызывающим кодом как раньше', body.error.startsWith('Тег «3700'));
    ok('заголовок несёт шаблон без тега и числа', decodeURIComponent(refused.headers.get('X-Flux-Error') || '') === 'Тег «…» уже связан с установкой #', refused.headers.get('X-Flux-Error'));
    const fine = await wrapped(`${origin}/api/equipment/fine`);
    ok('у успешного ответа заголовка причины нет', !fine.headers.get('X-Flux-Error'));

    const seen = client.rendererEvents().filter((e) => e.event === 'fetch.headers');
    const refusedEvent = seen.find((e) => e.data.status === '409');
    ok('окно записало причину в fetch.headers', refusedEvent?.data.reason === 'Тег «…» уже связан с установкой #', refusedEvent);
    ok('у успешного запроса причины в записи нет', seen.find((e) => e.data.status === '200')?.data.reason === undefined);

    await server.closeServerDiagnostics();
    const text = (await Promise.all((await fs.readdir(dir)).map((name) => fs.readFile(path.join(dir, name), 'utf8')))).join('\n');
    const end = text.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((e) => e.event === 'http.end' && e.data.status === '409');
    ok('сервер записал код и причину в http.end', end?.data.reason === 'Тег «…» уже связан с установкой #', end);
    ok('в файле нет названия тега', !text.includes('3700-B01'));
  } finally {
    await new Promise<void>((resolve) => listening.close(() => resolve()));
    await server.closeServerDiagnostics();
    await fs.rm(dir, { recursive: true, force: true });
  }
  console.log(`\nПроверок: ${checks}`);
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
