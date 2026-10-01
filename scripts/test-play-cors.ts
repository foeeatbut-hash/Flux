import assert from 'node:assert/strict';
import { corsMiddleware } from '../server/security';

function preflight(origin: string) {
  const headers = new Map<string, string>(); let status = 0;
  corsMiddleware({ method: 'OPTIONS', get: (key: string) => key === 'origin' ? origin : key === 'host' ? 'company.example:3000' : undefined } as any,
    { setHeader: (key: string, value: string) => headers.set(key, value), sendStatus: (value: number) => { status = value; } } as any,
    () => { throw new Error('OPTIONS must finish before routes'); });
  return { headers, status };
}
for (const origin of ['null', 'http://localhost:3000', 'http://company.example:3000']) {
  const result = preflight(origin);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), origin);
  assert.ok(result.headers.get('Access-Control-Allow-Headers')?.toLowerCase().split(',').map(s => s.trim()).includes('idempotency-key'),
    'Приглашения и ходы с Idempotency-Key должны проходить предварительный запрос браузера');
}
const foreign = preflight('https://foreign.example');
assert.equal(foreign.status, 403);
assert.equal(foreign.headers.has('Access-Control-Allow-Origin'), false);
console.log('Play CORS preflight: 11 checks PASS');
