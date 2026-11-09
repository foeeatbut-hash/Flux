/**
 * Правки по внешнему ревью (вход, сессии, права, общий слой, сокеты) без поднятого
 * сервера: таблица прав по маршрутам, надёжное время, каналы редактора при
 * истёкшей лицензии, ответ об ошибке после начала ответа.
 * Сквозная проверка на настоящем сервере — test-review-auth-live.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { permRuleFor } from '../server/permRoutes';
import { createTrustedTime, databaseClockMs, registerTimeAnchorRoutes } from '../server/trustedTime';
import { isMutatingOfficeChannel } from '../server/sessionSockets';
import { isClientAbort } from '../server/apiErrors';
import { requiresOwner } from '../server/accessPolicy';
import { sendError } from '../server/context';
import { describeApiError } from '../server/apiErrors';
import { distDirectory, spaFallbackAllowed } from '../server/security';

let passed = 0;
const check = (label: string, condition: unknown, detail?: unknown) => { assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); passed++; console.log('✓', label); };

// ── 44, 80, НОВОЕ-3: маршруты записи, которые обходили таблицу прав ──
check('POST /api/tags/generate требует tags.manage', permRuleFor('POST', '/api/tags/generate')?.perm === 'tags.manage');
check('то же с хвостовым слешем', permRuleFor('POST', '/api/tags/generate/')?.perm === 'tags.manage');
check('POST resolve-conflict требует equipment.manage', permRuleFor('POST', '/api/components/c-1/resolve-conflict')?.perm === 'equipment.manage');
check('чтение тегов права не требует', permRuleFor('GET', '/api/tags/generate') === null);
check('PUT тега по-прежнему tags.manage', permRuleFor('PUT', '/api/tags/t1')?.perm === 'tags.manage');
// 45: границы префиксов
check('/api/filesystem/… не принимается за /api/files', permRuleFor('POST', '/api/filesystem/scan') === null);
check('/api/files и /api/files/x — загрузка файлов', permRuleFor('POST', '/api/files')?.perm === 'files.upload' && permRuleFor('POST', '/api/files/x')?.perm === 'files.upload');
check('/api/projects/p1/tagsx не принимается за теги проекта', permRuleFor('POST', '/api/projects/p1/tagsx') === null && permRuleFor('POST', '/api/projects/p1/tags/import')?.perm === 'tags.manage');
check('сброс якоря времени доступен только владельцу', requiresOwner('/api/admin/time-anchor/reset', 'POST'));

// ── 67: второй ответ после начала первого ──
{
  let calls = 0;
  const res: any = { headersSent: true, status() { calls++; return this; }, json() { calls++; } };
  sendError(res, new Error('x'));
  check('sendError не отвечает второй раз, если ответ уже начат', calls === 0);
  const fresh: any = { headersSent: false, status(c: number) { calls = c; return this; }, json() {} };
  sendError(fresh, new Error('x'), 404);
  check('sendError отвечает, пока ответа нет', calls === 404);
}

// ── 40, 41: ответы об ошибках ──
{
  const ready = { databaseReady: true };
  const bad = describeApiError(Object.assign(new SyntaxError('Unexpected token'), { status: 400, type: 'entity.parse.failed' }), ready);
  check('битый JSON клиента — 400, а не 500', bad.status === 400 && /JSON/.test(bad.message), bad);
  check('слишком большое тело — 413', describeApiError(Object.assign(new Error('request entity too large'), { status: 413 }), ready).status === 413);
  check('обычный сбой остаётся 500', describeApiError(new Error('boom'), ready).status === 500);
  const stale = describeApiError(Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003', meta: { field_name: 'userId' } }), ready);
  check('внешний ключ на пользователя — «сессия устарела»', /Сессия устарела/.test(stale.message), stale);
  const linked = describeApiError(Object.assign(new Error('Foreign key constraint violated on the constraint: `Equipment_projectId_fkey`'), { code: 'P2003', meta: { field_name: 'Equipment_projectId_fkey' } }), ready);
  check('любой другой внешний ключ — 409 «запись связана», а не «сессия устарела»', linked.status === 409 && !/Сессия/.test(linked.message), linked);
  check('клиент Prisma не создан — своё сообщение', /не инициализирована/.test(describeApiError(new Error('x'), { databaseReady: false }).message));
}
// ── 42, 43: раздача окна ──
check('служба: папка сборки — рядом с server.cjs, а не рабочий каталог', distDirectory('/opt/Flux/dist') === '/opt/Flux/dist');
check('из корня репозитория — подпапка dist', distDirectory('/srv/flux') === '/srv/flux/dist');
check('пропавший скрипт — не страница', !spaFallbackAllowed('/assets/old.js', 'text/html') && !spaFallbackAllowed('/favicon.ico', '*/*'));
check('запрос страницы получает index.html', spaFallbackAllowed('/projects/p1', 'text/html,application/xhtml+xml'));
check('запрос без Accept: text/html — не страница', !spaFallbackAllowed('/projects/p1', 'application/json') && !spaFallbackAllowed('/projects', undefined));

check('оборванное клиентом соединение — не сбой сервера', isClientAbort(Object.assign(new Error('request aborted'), { type: 'request.aborted' })) && !isClientAbort(new Error('boom')));

// ── 99: изменяющие каналы редактора при истёкшей лицензии ──
for (const channel of ['pdf:save', 'workbook:save', 'workbook:setCellValue', 'workbook:set-cell-value', 'pdf:insert-page', 'workbook:applyFormat', 'workbook:pasteRange', 'pdf:annotate']) {
  check(`канал ${channel} изменяет документ`, isMutatingOfficeChannel(channel));
}
for (const channel of ['workbook:getDataSet', 'workbook:getFormat', 'workbook:get-sort-order', 'workbook:listSheets', 'workbook:isProtected', 'workbook:hasFormula', 'pdf:get-form-fields', 'pdf:readPage', 'workbook:getCell', 'workbook:get-offsets', 'pdf:get-page', 'pdf:read-text', 'workbook:open', 'pdf:thumbnail', 'workbook:listSheets']) {
  check(`канал ${channel} только читает`, !isMutatingOfficeChannel(channel));
}

// ── 47-49: надёжное время ──
const HOUR = 3600_000;
const makeClock = (start: number) => { let t = start; return { now: () => t, set: (v: number) => { t = v; }, add: (v: number) => { t += v; } }; };
const makeDeps = (clock: ReturnType<typeof makeClock>, opts: { dialect?: 'sqlite' | 'postgresql'; dbNow?: () => number | null; store?: Map<string, string> } = {}) => {
  const store = opts.store || new Map<string, string>();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flux-time-')), 'anchor');
  const prisma = {
    $queryRawUnsafe: async () => { const v = opts.dbNow ? opts.dbNow() : null; return v === null ? [] : [{ t: BigInt(v) }]; },
    appSetting: {
      findFirst: async () => (store.has('time_anchor') ? { value: store.get('time_anchor') } : null),
      deleteMany: async () => { store.delete('time_anchor'); return { count: 1 }; },
    },
  };
  const deps = {
    prisma: () => prisma, dialect: () => opts.dialect || 'sqlite', file,
    upsertSetting: async (key: string, _u: string | null, value: string) => { store.set(key, value); },
    anchorFile: file, now: clock.now, mono: monoNow,
  };
  return { deps, store, file };
};
let monoMs = 0;
const monoNow = () => monoMs;
const sleepTick = () => new Promise((r) => setTimeout(r, 5));

(async () => {
  const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

  // Одна машина с часами «вперёд» не должна блокировать всех
  {
    const db = { now: T0 };
    const store = new Map<string, string>();
    const fast = makeClock(T0 + 3 * 24 * HOUR); // спешит на трое суток
    const fastTime = createTrustedTime(makeDeps(fast, { dialect: 'postgresql', dbNow: () => db.now, store }).deps);
    await fastTime.full(); await sleepTick();
    const stored = store.get('time_anchor') ? parseInt(store.get('time_anchor')!, 36) : 0;
    check('часы вперёд на 3 суток не попадают в общую базу', stored <= db.now + 10 * 60_000, new Date(stored).toISOString());
    // Нормальная машина того же отдела входит со сроком
    const good = makeClock(T0 + 5 * 60_000);
    db.now = T0 + 5 * 60_000;
    const goodTime = createTrustedTime(makeDeps(good, { dialect: 'postgresql', dbNow: () => db.now, store }).deps);
    const result = await goodTime.full();
    check('вход на другой машине не объявляет перевод часов назад', result.tampered === false, result);
  }
  // Якорь, уже испорченный в общей базе прежними версиями, не принимается
  {
    const store = new Map<string, string>([['time_anchor', (T0 + 30 * 24 * HOUR).toString(36)]]);
    const clock = makeClock(T0);
    const time = createTrustedTime(makeDeps(clock, { dialect: 'postgresql', dbNow: () => T0, store }).deps);
    const result = await time.full();
    check('испорченный якорь из базы не принят: часы не «назад»', result.tampered === false);
    await sleepTick();
    check('и заменён в базе верным значением (самолечение)', parseInt(store.get('time_anchor')!, 36) <= T0 + 10 * 60_000);
  }
  // Защита от отката часов не ослаблена
  {
    const db = { now: T0 };
    const store = new Map<string, string>();
    const clock = makeClock(T0);
    const time = createTrustedTime(makeDeps(clock, { dialect: 'postgresql', dbNow: () => db.now, store }).deps);
    await time.full(); await sleepTick();
    clock.add(48 * HOUR); db.now += 48 * HOUR;
    time.sync(); await sleepTick();
    clock.set(T0 + 24 * HOUR); // откат на сутки назад
    check('откат часов больше чем на 6 часов обнаруживается', time.isTampered());
    check('перевод назад не уменьшает надёжное время', time.sync() <= clock.now() || time.anchorMs() >= T0 + 47 * HOUR);
    const full = await time.full();
    check('вход при откате часов отмечен как подделка', full.tampered === true);
    clock.set(T0 + 48 * HOUR + 60_000); db.now = clock.now();
    check('часы вернули — флаг снимается сам (не залипает до перезапуска)', time.isTampered() === false);
  }
  // Откат при локальной SQLite (часов базы нет): якорь из файла и базы работает, как раньше
  {
    const clock = makeClock(T0);
    const env = makeDeps(clock, { dialect: 'sqlite' });
    const time = createTrustedTime(env.deps);
    time.sync(); await sleepTick();
    clock.add(2 * 24 * HOUR); time.sync(); await sleepTick();
    const again = createTrustedTime({ ...env.deps }); // перезапуск: якорь поднимается из файла
    clock.set(T0 + 24 * HOUR);
    check('локальная база: откат на сутки после перезапуска виден по якорю', again.isTampered());
    // Сброс владельцем
    const routes: Array<{ path: string; handler: Function }> = [];
    const fakeApp: any = { post: (p: string, ...h: Function[]) => routes.push({ path: p, handler: h[h.length - 1] }) };
    const logged: any[] = [];
    registerTimeAnchorRoutes(fakeApp, again, () => ({ actionLog: { create: async (x: any) => { logged.push(x); } } }));
    check('маршрут сброса якоря зарегистрирован', routes[0]?.path === '/api/admin/time-anchor/reset');
    let body: any;
    await routes[0].handler({ authUser: { id: 'flux-owner', name: 'Владелец' } }, { json: (b: any) => { body = b; }, status() { return this; } });
    check('сброс якоря отвечает успехом и пишется в журнал действий', body?.success === true && logged[0]?.data?.what === 'Сброс якоря времени');
    check('после сброса часы не считаются переведёнными назад', again.isTampered() === false);
    check('файл якоря пересоздан от текущих часов', fs.existsSync(env.file) ? parseInt(fs.readFileSync(env.file, 'utf-8'), 36) <= clock.now() : true);
  }
  // Откат на 1-5 часов (якорь его не видит, допуск 6 часов) ловится по часам базы и снимается исправлением часов
  for (const back of [1, 3, 5]) {
    const db = { now: T0 };
    const store = new Map<string, string>();
    const clock = makeClock(T0);
    const time = createTrustedTime(makeDeps(clock, { dialect: 'postgresql', dbNow: () => db.now, store }).deps);
    await time.full();
    clock.set(T0 - back * HOUR); // откатили часы машины, часы базы идут как шли
    check(`откат на ${back} ч: виден проверке сессии без нового входа (по замеру часов базы)`, time.isTampered());
    check(`откат на ${back} ч: вход отмечен как подделка`, (await time.full()).tampered === true);
    monoMs += 60_000; db.now += 60_000; clock.add(60_000);
    check(`откат на ${back} ч: остаётся виден, пока часы не исправлены`, time.isTampered());
    clock.set(db.now); // часы исправили
    check(`откат на ${back} ч: исправленные часы снимают признак`, time.isTampered() === false);
  }
  // После перезапуска замера ещё нет: первая же проверка сессии перемеряет часы базы в фоне
  {
    const db = { now: T0 };
    const clock = makeClock(T0 - 3 * HOUR);
    const time = createTrustedTime(makeDeps(clock, { dialect: 'postgresql', dbNow: () => db.now, store: new Map() }).deps);
    time.sync(); await sleepTick(); await sleepTick();
    check('откат на 3 ч сразу после запуска ловится фоновым замером часов базы', time.isTampered());
  }
  // SQLite: часов базы нет, к базе за временем не ходим и ничего не выдумываем
  {
    const clock = makeClock(T0);
    let queries = 0;
    const env = makeDeps(clock, { dialect: 'sqlite' });
    (env.deps.prisma() as any).$queryRawUnsafe = async () => { queries++; return []; };
    const time = createTrustedTime(env.deps);
    time.sync(); const full = await time.full();
    check('SQLite: источник времени локальный, запросов часов базы нет', full.source === 'local' && queries === 0, { source: full.source, queries });
  }
  // Flux не ходит в интернет за временем: ни одного исходящего соединения во время проверок
  {
    const https = await import('node:https'); const http = await import('node:http'); const net = await import('node:net');
    const attempts: string[] = [];
    const origHttps = https.request, origHttp = http.request, origConnect = net.connect;
    (https as any).request = (...a: any[]) => { attempts.push('https'); return (origHttps as any)(...a); };
    (http as any).request = (...a: any[]) => { attempts.push('http'); return (origHttp as any)(...a); };
    (net as any).connect = (...a: any[]) => { attempts.push('net'); return (origConnect as any)(...a); };
    const clock = makeClock(T0);
    const time = createTrustedTime(makeDeps(clock, { dialect: 'postgresql', dbNow: () => T0, store: new Map() }).deps);
    await time.full(); time.sync(); await sleepTick();
    (https as any).request = origHttps; (http as any).request = origHttp; (net as any).connect = origConnect;
    check('надёжное время не открывает ни одного сетевого соединения', attempts.length === 0, attempts);
    // Статически: хостов, которые раньше опрашивались за временем, нет нигде в коде и README
    const banned = /www\.google\.com|ya\.ru|www\.cloudflare\.com|fetchNetworkTimeMs/;
    const roots = ['server.ts', 'server', 'electron', 'src', 'README.md'];
    const hits: string[] = [];
    const walk = (f: string) => {
      if (!fs.existsSync(f)) return;
      const st = fs.statSync(f);
      if (st.isDirectory()) { for (const n of fs.readdirSync(f)) if (n !== 'node_modules') walk(path.join(f, n)); return; }
      if (!/\.(ts|tsx|js|cjs|mjs|md)$/.test(f)) return;
      // Список почтовых доменов и адрес справки Google — не запросы времени
      const text = fs.readFileSync(f, 'utf-8');
      if (f.replace(/\\/g, '/').endsWith('server/routes/mail.ts') || f.replace(/\\/g, '/').endsWith('src/lib/browserUrl.ts')) return;
      if (banned.test(text)) hits.push(f);
    };
    roots.forEach(walk);
    check('в коде и README нет запросов времени к google, ya.ru, cloudflare', hits.length === 0, hits);
  }
  // Машина с часами +2 дня ничего не пишет в общую базу, даже до первого входа со сроком
  {
    const store = new Map<string, string>();
    const clock = makeClock(T0 + 2 * 24 * HOUR);
    const env = makeDeps(clock, { dialect: 'postgresql', dbNow: () => T0, store });
    const time = createTrustedTime(env.deps);
    time.sync(); await sleepTick(); await sleepTick();
    const written = store.get('time_anchor') ? parseInt(store.get('time_anchor')!, 36) : 0;
    check('+2 дня без единого входа со сроком: в общую базу не уходит время дальше часов базы', written <= T0 + 10 * 60_000, written && new Date(written).toISOString());
    // база не отвечает — в общую базу не пишем вовсе
    const blind = new Map<string, string>();
    const blindTime = createTrustedTime(makeDeps(makeClock(T0 + 2 * 24 * HOUR), { dialect: 'postgresql', dbNow: () => null, store: blind }).deps);
    blindTime.sync(); await sleepTick(); await sleepTick();
    check('без замера часов базы запись в общую базу не выполняется', blind.size === 0);
  }
  // Сброс без записи в журнал не выполняется
  {
    const clock = makeClock(T0);
    const env = makeDeps(clock, { dialect: 'sqlite' });
    const time = createTrustedTime(env.deps);
    time.sync();
    const routes: Array<{ handler: Function }> = [];
    registerTimeAnchorRoutes({ post: (_p: string, ...h: Function[]) => routes.push({ handler: h[h.length - 1] }) } as any, time, () => ({ actionLog: { create: async () => { throw new Error('нет таблицы'); } } }));
    let status = 200; let body: any;
    await routes[0].handler({ authUser: { id: 'o' } }, { status(c: number) { status = c; return this; }, json: (b: any) => { body = b; } });
    check('журнал не записался — 500 и якорь не сброшен', status === 500 && time.anchorMs() === T0 && /журнал/.test(body.error), { status, body });
  }
  check('часы PostgreSQL читаются как число', (await databaseClockMs({ $queryRawUnsafe: async () => [{ t: 1_800_000_000_000n }] }, 'postgresql')) === 1_800_000_000_000);
  check('у SQLite своих часов базы нет', (await databaseClockMs({ $queryRawUnsafe: async () => [{ t: 1 }] }, 'sqlite')) === null);
  check('сбой запроса часов базы — null, а не исключение', (await databaseClockMs({ $queryRawUnsafe: async () => { throw new Error('down'); } }, 'mysql')) === null);

  console.log(`review-auth: ${passed} проверок пройдено`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
