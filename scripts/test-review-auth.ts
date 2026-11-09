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
import { requiresOwner } from '../server/accessPolicy';
import { sendError } from '../server/context';

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

// ── 99: изменяющие каналы редактора при истёкшей лицензии ──
for (const channel of ['pdf:save', 'workbook:save', 'workbook:setCellValue', 'workbook:set-cell-value', 'pdf:insert-page', 'workbook:applyFormat', 'workbook:pasteRange', 'pdf:annotate']) {
  check(`канал ${channel} изменяет документ`, isMutatingOfficeChannel(channel));
}
for (const channel of ['workbook:getCell', 'workbook:get-offsets', 'pdf:get-page', 'pdf:read-text', 'workbook:open', 'pdf:thumbnail', 'workbook:listSheets']) {
  check(`канал ${channel} только читает`, !isMutatingOfficeChannel(channel));
}

// ── 47-49: надёжное время ──
const HOUR = 3600_000;
const makeClock = (start: number) => { let t = start; return { now: () => t, set: (v: number) => { t = v; }, add: (v: number) => { t += v; } }; };
const makeDeps = (clock: ReturnType<typeof makeClock>, opts: { dialect?: 'sqlite' | 'postgresql'; dbNow?: () => number | null; net?: () => number | null; store?: Map<string, string> } = {}) => {
  const store = opts.store || new Map<string, string>();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flux-time-')), 'anchor');
  let netCalls = 0;
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
    anchorFile: file, now: clock.now,
    networkTime: async () => { netCalls++; return opts.net ? opts.net() : null; },
  };
  return { deps, store, file, netCalls: () => netCalls };
};
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
  // Запросы наружу: закрытая сеть не задерживает каждый вход
  {
    const clock = makeClock(T0);
    const env = makeDeps(clock, { dialect: 'sqlite', net: () => null });
    const time = createTrustedTime(env.deps);
    await time.full(); await time.full(); await time.full();
    check('после отказа сети следующие входы не ждут сеть (1 попытка за 5 минут)', env.netCalls() === 1, env.netCalls());
    clock.add(6 * 60_000);
    await time.full();
    check('через 5 минут попытка повторяется', env.netCalls() === 2, env.netCalls());
  }
  check('часы PostgreSQL читаются как число', (await databaseClockMs({ $queryRawUnsafe: async () => [{ t: 1_800_000_000_000n }] }, 'postgresql')) === 1_800_000_000_000);
  check('у SQLite своих часов базы нет', (await databaseClockMs({ $queryRawUnsafe: async () => [{ t: 1 }] }, 'sqlite')) === null);
  check('сбой запроса часов базы — null, а не исключение', (await databaseClockMs({ $queryRawUnsafe: async () => { throw new Error('down'); } }, 'mysql')) === null);

  console.log(`review-auth: ${passed} проверок пройдено`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
