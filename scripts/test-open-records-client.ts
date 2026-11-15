/**
 * Клиент открытых записей (src/lib/openRecords.ts): окно сообщает серверу, что у него открыто.
 *
 * Без браузера и службы: подставной fetch и ручной таймер. Проверяется договор из
 * .claude/progress/conflict-details.md, раздел 2:
 *   - при смене списка — сразу PUT /api/open-records { holderKey, records } с ПОЛНЫМ списком;
 *   - пока что-то открыто — повтор каждые 15 с, пока список пуст и сервер это знает — тишина;
 *   - при закрытии окна — пустой список маяком (POST, keepalive);
 *   - ключ окна случайный и один на окно; несколько источников объединяются без повторов;
 *   - не дошедший запрос повторяется следующим ударом; два запроса подряд не обгоняют друг друга;
 *   - смена «снять старое, поставить новое» уходит одним запросом.
 *
 * Запуск: npx tsx scripts/test-open-records-client.ts
 */
import assert from 'node:assert/strict';
import { createOpenRecordsClient, OPEN_RECORDS_BEAT_MS, OPEN_RECORDS_URL } from '../src/lib/openRecords';

let passed = 0;
const same = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); passed++; console.log(`  ✓ ${name}`); };
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };

/** Ручной таймер: время идёт, только когда его двигают. */
function manualTimers() {
  const handles = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    timers: { set: (fn: () => void, ms: number) => { handles.set(next, { fn, ms }); return next++; }, clear: (h: unknown) => { handles.delete(h as number); } },
    active: () => handles.size,
    periods: () => [...handles.values()].map((h) => h.ms),
    fire: () => { for (const h of [...handles.values()]) h.fn(); },
  };
}

function fakeFetch(status = 200) {
  const calls: Array<{ url: string; method?: string; keepalive?: boolean; body: any }> = [];
  const state = { status, throws: false, gate: null as null | Promise<void> };
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, keepalive: init?.keepalive, body: JSON.parse(String(init?.body ?? '{}')) });
    if (state.gate) await state.gate;
    if (state.throws) throw new TypeError('fetch failed');
    return new Response('{}', { status: state.status });
  };
  return { calls, state, fetcher };
}
/** Дать отработать цепочке промисов клиента. */
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };

const FAN = { model: 'ComponentElement', id: 'c1' };
const SYS = { model: 'EquipmentSystem', id: 's1' };

(async () => {
  console.log('1. Смена списка уходит сразу');
  {
    const t = manualTimers(); const f = fakeFetch();
    const client = createOpenRecordsClient({ fetcher: f.fetcher, timers: t.timers, holderKey: 'win-1' });
    client.setSource('screen', [FAN]); await settle();
    same('один PUT на нужный адрес с ключом окна и полным списком', f.calls.map((c) => [c.url, c.method, c.body]), [[OPEN_RECORDS_URL, 'PUT', { holderKey: 'win-1', records: [FAN] }]]);
    client.setSource('screen', [FAN]); await settle();
    same('тот же список — запроса нет', f.calls.length, 1);
    client.setSource('screen', [SYS]); await settle();
    same('другой список — новый PUT с полным списком', f.calls[1].body, { holderKey: 'win-1', records: [SYS] });
    client.setSource('screen', []); await settle();
    same('пустой список — «ничего не держу»', f.calls[2].body, { holderKey: 'win-1', records: [] });
    client.stop();
  }

  console.log('2. Удары каждые 15 секунд, пока что-то открыто');
  {
    const t = manualTimers(); const f = fakeFetch();
    const client = createOpenRecordsClient({ fetcher: f.fetcher, timers: t.timers, holderKey: 'w' });
    same('период удара — 15 с', OPEN_RECORDS_BEAT_MS, 15000);
    client.setSource('screen', [FAN]); await settle();
    same('таймер поставлен с периодом 15 с', t.periods(), [15000]);
    t.fire(); await settle(); t.fire(); await settle();
    same('каждый удар повторяет полный список', f.calls.map((c) => c.body.records.length), [1, 1, 1]);
    client.setSource('screen', []); await settle();
    const before = f.calls.length;
    t.fire(); await settle(); t.fire(); await settle();
    same('список пуст и сервер это знает — удары молчат', f.calls.length, before);
  }

  console.log('3. Закрытие окна — маяк с пустым списком');
  {
    const t = manualTimers(); const f = fakeFetch();
    const client = createOpenRecordsClient({ fetcher: f.fetcher, timers: t.timers, holderKey: 'w' });
    client.setSource('screen', [FAN]); await settle();
    client.release(); await settle();
    const beacon = f.calls[f.calls.length - 1];
    same('POST с пустым списком и тем же ключом окна', [beacon.method, beacon.body], ['POST', { holderKey: 'w', records: [] }]);
    ok('маяк с keepalive: переживает выгрузку страницы', beacon.keepalive === true);
    same('удары остановлены', t.active(), 0);
    const n = f.calls.length;
    client.setSource('screen', [SYS]); await settle();
    same('после закрытия новых отметок нет', f.calls.length, n);
    client.resume(); await settle();
    same('страницу вернули из кэша — список сообщён заново, удары идут', [f.calls[f.calls.length - 1].method, f.calls[f.calls.length - 1].body.records, t.active()], ['PUT', [SYS], 1]);
  }

  console.log('4. Источники и ключ окна');
  {
    const t = manualTimers(); const f = fakeFetch();
    const client = createOpenRecordsClient({ fetcher: f.fetcher, timers: t.timers, holderKey: 'w' });
    client.setSource('screen', [FAN]); client.setSource('dialog', [FAN, SYS]); await settle();
    same('объединение источников без повторов', client.list(), [FAN, SYS]);
    client.setSource('dialog', []); await settle();
    same('закрыт один источник — второй остаётся в списке', f.calls[f.calls.length - 1].body.records, [FAN]);
    const a = createOpenRecordsClient({ fetcher: f.fetcher, timers: t.timers });
    const b = createOpenRecordsClient({ fetcher: f.fetcher, timers: t.timers });
    ok('ключ окна случайный: два окна — два ключа', a.holderKey.length >= 8 && a.holderKey !== b.holderKey);
    same('записи без модели или id отбрасываются', (() => { const c = createOpenRecordsClient({ fetcher: f.fetcher, timers: t.timers }); c.setSource('x', [{ model: '', id: 'a' }, { model: 'M', id: '' }, FAN]); return c.list(); })(), [FAN]);
  }

  console.log('5. Сбои и порядок');
  {
    const t = manualTimers(); const f = fakeFetch();
    const client = createOpenRecordsClient({ fetcher: f.fetcher, timers: t.timers, holderKey: 'w' });
    f.state.throws = true;
    client.setSource('screen', [FAN]); await settle();
    ok('сеть не ответила — исключения нет', f.calls.length === 1);
    f.state.throws = false;
    t.fire(); await settle();
    same('не дошедшее повторяется ближайшим ударом', f.calls.length, 2);
    t.fire(); await settle();
    same('дошло — дальше удары идут как обычно (список не пуст)', f.calls.length, 3);
    f.state.status = 503;
    client.setSource('screen', [SYS]); await settle();
    f.state.status = 200;
    t.fire(); await settle();
    same('отказ сервера (503) тоже не считается доставленным: повтор', f.calls[f.calls.length - 1].body.records, [SYS]);
    client.setSource('screen', []); f.state.throws = true; await settle();
    f.state.throws = false;
    const n = f.calls.length;
    t.fire(); await settle();
    same('пустой список не дошёл — удар повторяет и пустой', [f.calls.length, f.calls[n]?.body.records], [n + 1, []]);
  }
  {
    const t = manualTimers(); const f = fakeFetch();
    let release!: () => void;
    f.state.gate = new Promise<void>((r) => { release = r; });
    const client = createOpenRecordsClient({ fetcher: f.fetcher, timers: t.timers, holderKey: 'w' });
    client.setSource('screen', [FAN]); await settle();
    client.setSource('screen', [SYS]); await settle();
    same('пока первый запрос не вернулся, второй не уходит (порядок сохраняется)', f.calls.length, 1);
    f.state.gate = null; release(); await settle();
    same('потом уходит ровно последний список', f.calls.map((c) => c.body.records), [[FAN], [SYS]]);
  }
  {
    const t = manualTimers(); const f = fakeFetch();
    const client = createOpenRecordsClient({ fetcher: f.fetcher, timers: t.timers, holderKey: 'w' });
    client.setSource('screen', [FAN]); await settle();
    client.setSource('screen', []); client.setSource('screen', [SYS]); await settle();
    same('«снять старое, поставить новое» подряд — один запрос, а не два', f.calls.map((c) => c.body.records), [[FAN], [SYS]]);
  }

  console.log(`\nПройдено проверок: ${passed}`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
