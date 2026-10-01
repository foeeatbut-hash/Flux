import assert from 'node:assert/strict';
import { groupIncidents } from '../diagnostics/incidents';
import type { DiagnosticEvent } from '../diagnostics/contracts';

function ev(event: string, data: Record<string, string | number | boolean>, i: number, source = 'server'): DiagnosticEvent {
  return { v: 1, time: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), session: `session-${i}`, seq: i, source, event, data: { ...data, trace: `trace-${i}` } };
}

const ignored = [
  ev('http.end', { status: '400', outcome: 'error' }, 1),
  ev('http.end', { status: '404', outcome: 'error' }, 2),
  ev('http.end', { status: '401', outcome: 'error' }, 3),
  ev('fetch.error', { outcome: 'cancelled', error: 'AbortError' }, 4, 'renderer'),
  ev('http.end', { status: '409', outcome: 'conflict' }, 5),
  ev('db.op', { ok: false, outcome: 'cancelled', code: 'P2024' }, 6),
];
assert.deepEqual(groupIncidents(ignored), [], 'expected client errors, cancellations, conflicts are excluded');

const failures = [
  ev('http.end', { route: '/api/items/:id', status: '503', outcome: 'error' }, 10),
  ev('http.end', { route: '/api/items/:id', status: '503', outcome: 'error' }, 11),
  ev('http.end', { route: '/api/items/:id', status: '502', outcome: 'error' }, 12),
  ev('http.end', { route: '/api/other', status: '503', outcome: 'error' }, 13),
];
const grouped = groupIncidents(failures);
const repeated503 = grouped.find(i => i.routes[0] === '/api/items/:id' && i.codes[0] === '503')!;
assert.equal(repeated503.count, 2);
assert.equal(repeated503.evidence.length, 2);
assert.equal(repeated503.traces.length, 2);
assert.equal(repeated503.severity, 'error');
assert.equal(grouped.length, 3, 'status and route distinguish otherwise similar HTTP incidents');
assert.equal(repeated503.id, groupIncidents([...failures].reverse()).find(i => i.fingerprint === repeated503.fingerprint)!.id, 'id is stable across ordering and trace/sequence changes');

const stalls = Array.from({ length: 25 }, (_, i) => ev('ui.stall', { durationMs: 6000 }, 30 + i, 'renderer'));
const warnings = groupIncidents(stalls);
assert.equal(warnings.length, 1);
assert.equal(warnings[0].severity, 'warning');
assert.equal(warnings[0].count, 25);
assert.equal(warnings[0].evidence.length, 20, 'evidence is capped while total count is retained');
assert.equal(groupIncidents([ev('ui.stall', { durationMs: 6000 }, 1, 'renderer')]).length, 0, 'one-off stall is omitted');

const slow = [ev('http.end', { route: '/api/slow', status: '200', durationMs: 5000 }, 1), ev('http.end', { route: '/api/slow', status: '200', durationMs: 5100 }, 2)];
assert.equal(groupIncidents(slow)[0]?.severity, 'warning');
assert.equal(groupIncidents([slow[0]]).length, 0, 'one slow request is not a persistent incident');

const many = Array.from({ length: 120 }, (_, i) => ev('process.uncaught', { error: `E${i}` }, i + 1));
assert.equal(groupIncidents(many).length, 100, 'incident list is capped');
const timeout = groupIncidents([ev('db.op', { ok: false, code: 'P2024' }, 1)]);
assert.match(timeout[0].title, /тайм-аут/i);

// Unknown values are never surfaced as a title, key, route, or evidence field.
const hostile = ev('http.end', { route: '/api/:id', status: '500', outcome: 'error' }, 1);
hostile.data.route = 'secret project name';
hostile.data.message = 'customer@example.test';
const safeOutput = JSON.stringify(groupIncidents([hostile]));
assert.equal(safeOutput.includes('secret'), false);
assert.equal(safeOutput.includes('customer@'), false);

console.log('diagnostic incident tests passed');
