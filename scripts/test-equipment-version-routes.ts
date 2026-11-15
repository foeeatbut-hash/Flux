/**
 * Сверка версии от клиента в поштучных маршрутах оборудования
 * (docs/roadmap/offline-work.md, 0.5, часть 1; сверку делает server/versionGuard.ts).
 *
 * Настоящая SQLite-база (таблицы из schema.prisma), настоящие маршруты на настоящем
 * express, клиент базы — `withVersionBump(raw)`, как на сервере. На каждый маршрут:
 *  • чужая версия → 409, `code: 'VERSION_CONFLICT'`, текст для человека без кода,
 *    текущая запись в `current`, и в базе НЕ изменилось ничего (в том числе не заведён тег);
 *  • своя версия → применено, версия записи выросла ровно на 1 (создание по месту:
 *    владелец не тронут, у новой позиции версия 1), в ответе новая `version`;
 *  • без версии (старый клиент) → работает;
 *  • нечитаемая версия → 400, в базе ничего не изменилось.
 * Отдельно: проигранная гонка двух клиентов с одной версией; рост версии у детей и тегов при
 * удалении позиции; чтение дерева оборудования отдаёт `version` у установки, моноблока и позиции.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma } from '../server/context.js';
import { withVersionBump } from '../server/versionBump.js';
import { ensureCatalog } from '../server/routes/catalog.js';
import { registerEquipmentEditRoutes } from '../server/routes/equipmentEdit.js';
import { registerEquipmentCoreRoutes } from '../server/routes/equipmentCore.js';
import { registerTagRoutes } from '../server/routes/tags.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-equipment-version-routes-'));
const dbPath = path.join(root, 'fixture.sqlite');
const raw = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 700)}`}`);
  checks++;
  console.log(`✓ ${label}`);
};

/** Всё, что маршруты оборудования могут затронуть: сравнение «до и после» ловит любую запись, в том числе лишнюю. */
async function world() {
  return {
    systems: await raw.equipmentSystem.findMany({ orderBy: { id: 'asc' } }),
    monoblocks: await raw.monoblock.findMany({ orderBy: { id: 'asc' } }),
    components: await raw.componentElement.findMany({ orderBy: { id: 'asc' }, include: { tags: { select: { id: true }, orderBy: { id: 'asc' } } } }),
    tags: await raw.tag.findMany({ orderBy: { id: 'asc' } }),
  };
}
type World = Awaited<ReturnType<typeof world>>;
const comp = (w: World, id: string) => w.components.find((c: any) => c.id === id);
const tagsOf = (w: World, id: string): string[] => (comp(w, id)?.tags || []).map((t: any) => t.id);

async function seed() {
  await raw.$executeRawUnsafe('DELETE FROM "_ComponentElementToTag"');
  await raw.componentElement.deleteMany({});
  await raw.monoblock.deleteMany({});
  await raw.equipmentSystem.deleteMany({});
  await raw.tag.deleteMany({});
  await raw.systemChangeLog.deleteMany({}).catch(() => null);
  await raw.equipmentSystem.create({ data: { id: 'S1', name: 'SYS-1', projectId: 'p1', version: 3 } });
  await raw.monoblock.create({ data: { id: 'M1', name: 'M1', systemId: 'S1', version: 2 } });
  const specs = JSON.stringify({ groups: [{ title: 'Параметры', params: [{ key: 'Давление', value: '1', unit: 'Па' }] }], Расход: '1' });
  await raw.componentElement.create({
    data: {
      id: 'C1', name: 'Вентилятор', itemCode: 'FAN-1', monoblockId: 'M1', role: 'ВЕНТИЛЯТОР', version: 4, specs,
      hasConflict: true, conflictType: 'PARAM', status: 'CONFLICT',
      paramConflicts: JSON.stringify([{ group: 'Параметры', key: 'Давление', oldValue: '1', newValue: '2', unit: 'Па' }]),
      conflictLog: JSON.stringify({ Расход: { old: '1', new: '2' } }),
    },
  });
  await raw.componentElement.create({ data: { id: 'C2', name: 'Двигатель', itemCode: 'FAN-1/м', monoblockId: 'M1', role: 'ДВИГАТЕЛЬ', version: 2, parentElementId: 'C1' } });
  await raw.componentElement.create({ data: { id: 'C3', name: 'Клапан', itemCode: 'VLV-1', monoblockId: 'M1', role: 'КЛАПАН', version: 5 } });
  await raw.tag.create({ data: { id: 'T1', identifier: 'AHU-1', projectId: 'p1', codeKey: 'AHU-1' } });
  await raw.tag.create({ data: { id: 'T2', identifier: 'AHU-2', projectId: 'p1', codeKey: 'AHU-2' } });
  await raw.tag.create({ data: { id: 'T3', identifier: 'AHU-3', projectId: 'p1', codeKey: 'AHU-3' } });
  await raw.componentElement.update({ where: { id: 'C3' }, data: { tags: { connect: { id: 'T2' } } } });
  await raw.componentElement.update({ where: { id: 'C1' }, data: { tags: { connect: { id: 'T3' } } } });
  // Сид идёт на клиенте без расширения, но на всякий случай возвращаем нужные версии явно
  await raw.componentElement.updateMany({ where: { id: 'C1' }, data: { version: 4 } });
  await raw.componentElement.updateMany({ where: { id: 'C3' }, data: { version: 5 } });
}

type Target = { model: 'componentElement' | 'equipmentSystem' | 'monoblock'; id: string };
interface Case {
  name: string;
  method: 'POST' | 'PUT' | 'DELETE';
  url: string;
  body?: Record<string, unknown>;
  /** Где клиент кладёт версию: в тело или (у DELETE) в строку запроса */
  versionIn: 'body' | 'query';
  /** Запись, чью версию клиент видел */
  target: Target;
  /** Что случилось с целью при успехе: +1 (правка), 0 (по месту создали дочернюю), 'gone' (удалена) */
  growth: 1 | 0 | 'gone';
  /** Побочные следствия успеха; возвращает пустую строку, если всё так */
  applied: (before: World, after: World, res: any) => string;
  /** Где в ответе новая версия записи (если маршрут её отдаёт) */
  responseVersion?: (body: any) => unknown;
}

const cases: Case[] = [
  {
    name: 'PUT /api/equipment/component/:id/class', method: 'PUT', url: '/api/equipment/component/C1/class',
    body: { equipClass: 'ВЕНТИЛЯТОР', equipKind: 'Радиальный' }, versionIn: 'body', target: { model: 'componentElement', id: 'C1' }, growth: 1,
    applied: (_b, a) => comp(a, 'C1')?.equipClass === 'ВЕНТИЛЯТОР' && comp(a, 'C1')?.equipKind === 'Радиальный' ? '' : 'тип не записан',
    responseVersion: (b) => b.version,
  },
  {
    name: 'POST /api/equipment/component/:id/tag', method: 'POST', url: '/api/equipment/component/C1/tag',
    body: { identifier: 'AHU-9' }, versionIn: 'body', target: { model: 'componentElement', id: 'C1' }, growth: 1,
    applied: (b, a) => {
      const made = a.tags.find((t: any) => t.identifier === 'AHU-9');
      if (!made || a.tags.length !== b.tags.length + 1) return 'тег не заведён';
      return tagsOf(a, 'C1').includes(made.id) ? '' : 'тег не привязан';
    },
    responseVersion: (b) => b.version,
  },
  {
    name: 'DELETE /api/equipment/component/:id', method: 'DELETE', url: '/api/equipment/component/C1',
    versionIn: 'query', target: { model: 'componentElement', id: 'C1' }, growth: 'gone',
    applied: (b, a) => {
      if (tagsOf(a, 'C1').length) return 'позиция жива';
      if (comp(a, 'C2')?.parentElementId !== null) return 'ребёнок не перевешен';
      // отвязка тегов и перевешивание детей версию детей растят (расширение клиента базы)
      if (comp(a, 'C2')?.version !== (comp(b, 'C2')?.version as number) + 1) return `версия ребёнка ${comp(b, 'C2')?.version} → ${comp(a, 'C2')?.version}, а не +1`;
      if (!a.tags.some((t: any) => t.id === 'T3')) return 'тег удалён вместе с позицией';
      return '';
    },
  },
  {
    name: 'POST /api/equipment/component/:id/position', method: 'POST', url: '/api/equipment/component/C1/position',
    body: { name: 'Датчик ПТС', role: 'ДАТЧИК' }, versionIn: 'body', target: { model: 'componentElement', id: 'C1' }, growth: 0,
    applied: (b, a, res) => {
      const made = a.components.find((c: any) => c.name === 'Датчик ПТС');
      if (!made || a.components.length !== b.components.length + 1) return 'позиция не заведена';
      if (made.parentElementId !== 'C1') return 'не под владельцем';
      if (made.version !== 1 || res.body?.component?.version !== 1) return `версия новой позиции ${made.version} / в ответе ${res.body?.component?.version}`;
      return '';
    },
  },
  {
    name: 'POST /api/equipment/monoblock/:id/position', method: 'POST', url: '/api/equipment/monoblock/M1/position',
    body: { name: 'Шкаф управления', role: 'КОРОБКА' }, versionIn: 'body', target: { model: 'monoblock', id: 'M1' }, growth: 0,
    applied: (b, a, res) => {
      const made = a.components.find((c: any) => c.name === 'Шкаф управления');
      if (!made || a.components.length !== b.components.length + 1) return 'позиция не заведена';
      if (made.parentElementId !== null || made.monoblockId !== 'M1') return 'не в моноблоке верхним уровнем';
      return made.version === 1 && res.body?.component?.version === 1 ? '' : 'версия новой позиции не 1';
    },
  },
  {
    name: 'POST /api/equipment/component/:id/resolve', method: 'POST', url: '/api/equipment/component/C1/resolve',
    body: { group: 'Параметры', key: 'Давление', action: 'accept' }, versionIn: 'body', target: { model: 'componentElement', id: 'C1' }, growth: 1,
    applied: (_b, a) => (comp(a, 'C1')?.specs || '').includes('"value":"2"') && !comp(a, 'C1')?.paramConflicts ? '' : 'конфликт не разрешён',
    responseVersion: (b) => b.component?.version,
  },
  {
    name: 'POST /api/equipment/component/:id/override', method: 'POST', url: '/api/equipment/component/C1/override',
    body: { group: 'Параметры', key: 'Давление', value: '77' }, versionIn: 'body', target: { model: 'componentElement', id: 'C1' }, growth: 1,
    applied: (_b, a) => (comp(a, 'C1')?.overrides || '').includes('77') ? '' : 'правка не записана',
    responseVersion: (b) => b.component?.version,
  },
  {
    name: 'POST /api/components/:id/accept-field', method: 'POST', url: '/api/components/C1/accept-field',
    body: { fieldName: 'Расход' }, versionIn: 'body', target: { model: 'componentElement', id: 'C1' }, growth: 1,
    applied: (_b, a) => (comp(a, 'C1')?.specs || '').includes('"Расход":"2"') ? '' : 'значение не принято',
    responseVersion: (b) => b.component?.version,
  },
  {
    name: 'POST /api/components/:id/manual-edit-field', method: 'POST', url: '/api/components/C1/manual-edit-field',
    body: { fieldName: 'Расход', newValue: '5' }, versionIn: 'body', target: { model: 'componentElement', id: 'C1' }, growth: 1,
    applied: (_b, a) => (comp(a, 'C1')?.specs || '').includes('"Расход":"5"') ? '' : 'значение не записано',
    responseVersion: (b) => b.component?.version,
  },
  {
    name: 'POST /api/components/:componentId/tags/:tagId', method: 'POST', url: '/api/components/C1/tags/T1',
    body: {}, versionIn: 'body', target: { model: 'componentElement', id: 'C1' }, growth: 1,
    applied: (_b, a) => tagsOf(a, 'C1').includes('T1') ? '' : 'тег не привязан',
    responseVersion: (b) => b.component?.version,
  },
  {
    name: 'DELETE /api/components/:componentId/tags/:tagId', method: 'DELETE', url: '/api/components/C1/tags/T3',
    versionIn: 'query', target: { model: 'componentElement', id: 'C1' }, growth: 1,
    applied: (_b, a) => tagsOf(a, 'C1').includes('T3') ? 'тег не отвязан' : '',
    responseVersion: (b) => b.component?.version,
  },
  {
    name: 'POST /api/components/:componentId/resolve-conflict', method: 'POST', url: '/api/components/C1/resolve-conflict',
    body: {}, versionIn: 'body', target: { model: 'componentElement', id: 'C1' }, growth: 1,
    applied: (_b, a) => comp(a, 'C1')?.hasConflict === false && comp(a, 'C1')?.conflictType === null ? '' : 'флаг конфликта не снят',
    responseVersion: (b) => b.component?.version,
  },
  {
    name: 'DELETE /api/systems/:id', method: 'DELETE', url: '/api/systems/S1',
    versionIn: 'query', target: { model: 'equipmentSystem', id: 'S1' }, growth: 'gone',
    applied: (_b, a) => {
      if (a.systems.length || a.monoblocks.length || a.components.length) return 'установка или её содержимое осталось';
      return ['T1', 'T2', 'T3'].every((id) => a.tags.some((t: any) => t.id === id)) ? '' : 'теги удалены вместе с установкой';
    },
  },
];

async function main() {
  let server: any;
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, raw, schema, () => {});
    // Клиент с ростом версии — как на сервере (server.ts: createPrismaClient)
    const prisma = withVersionBump(raw);
    setPrisma(prisma);
    await ensureCatalog(prisma);
    await raw.project.create({ data: { id: 'p1', name: 'P1' } });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).authUser = { id: 'fixture-user', name: 'Инженер', role: 'ADMIN', isActive: true }; next(); });
    registerEquipmentEditRoutes(app);
    registerEquipmentCoreRoutes(app);
    registerTagRoutes(app, { io: {} as any, notifyAll: async () => {} });
    server = await new Promise<any>((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const origin = `http://127.0.0.1:${server.address().port}`;

    type Sent = number | string | undefined;
    const send = async (c: Case, version: Sent) => {
      let url = `${origin}${c.url}`;
      const init: any = { method: c.method, headers: { 'content-type': 'application/json' } };
      if (c.versionIn === 'query') { if (version !== undefined) url += `?expectedVersion=${encodeURIComponent(String(version))}`; }
      else init.body = JSON.stringify({ ...(c.body || {}), ...(version !== undefined ? { expectedVersion: version } : {}) });
      const r = await fetch(url, init);
      const text = await r.text();
      let body: any = null;
      try { body = JSON.parse(text); } catch { body = { text }; }
      return { status: r.status, body };
    };
    const versionOf = async (t: Target) => (await (raw as any)[t.model].findUnique({ where: { id: t.id } }))?.version as number;
    const same = (a: World, b: World) => JSON.stringify(a) === JSON.stringify(b);

    for (const c of cases) {
      console.log(`\n── ${c.name}`);

      // 1. Чужая версия: отказ, ничего не записано
      await seed();
      let before = await world();
      const current = await versionOf(c.target);
      assert.ok(current >= 2, `${c.name}: сид должен давать версию ≥ 2`);
      const stale = await send(c, current - 1);
      check(`${c.name}: чужая версия — 409 с кодом отдельным полем`, stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT', stale);
      check(`${c.name}: текст отказа для человека, по-русски, без кода`,
        typeof stale.body?.error === 'string' && /[а-яё]{4,}/i.test(stale.body.error) && !/VERSION_CONFLICT/.test(stale.body.error), stale.body?.error);
      check(`${c.name}: в отказе текущая запись с её версией`, stale.body?.current?.id === c.target.id && stale.body.current.version === current, stale.body?.current);
      check(`${c.name}: чужая версия — в базе не изменилось ничего`, same(before, await world()));

      // 2. Нечитаемая версия: 400, ничего не записано
      for (const bad of ['abc', 0, -3, 1.5]) {
        const r = await send(c, bad as Sent);
        check(`${c.name}: версия ${JSON.stringify(bad)} — 400`, r.status === 400 && typeof r.body?.error === 'string', r);
      }
      check(`${c.name}: нечитаемая версия — в базе не изменилось ничего`, same(before, await world()));

      // 3. Своя версия и 4. без версии: применено
      for (const mode of ['своя версия', 'без версии'] as const) {
        await seed();
        before = await world();
        const res = await send(c, mode === 'своя версия' ? await versionOf(c.target) : undefined);
        check(`${c.name}: ${mode} — 200`, res.status === 200, res);
        const after = await world();
        const why = c.applied(before, after, res);
        check(`${c.name}: ${mode} — запись применена`, why === '', why);
        const now = (await (raw as any)[c.target.model].findUnique({ where: { id: c.target.id } }))?.version as number | undefined;
        if (c.growth === 'gone') check(`${c.name}: ${mode} — запись удалена`, now === undefined);
        else check(`${c.name}: ${mode} — версия цели выросла ровно на ${c.growth} (${current} → ${now})`, now === current + c.growth);
        if (c.responseVersion) check(`${c.name}: ${mode} — в ответе новая версия записи`, c.responseVersion(res.body) === now, res.body);
      }
    }

    // ── Гонка двух клиентов с одной версией: проходит один, второй получает отказ
    console.log('\n── гонка');
    for (const c of cases.filter((x) => ['PUT /api/equipment/component/:id/class', 'POST /api/components/:componentId/tags/:tagId', 'POST /api/equipment/component/:id/override'].includes(x.name))) {
      await seed();
      const v = await versionOf(c.target);
      const results = await Promise.all([send(c, v), send(c, v)]);
      const codes = results.map((r) => r.status).sort();
      check(`${c.name}: два клиента с одной версией — один 200 и один 409`, codes[0] === 200 && codes[1] === 409, results);
      check(`${c.name}: после гонки версия выросла ровно на 1`, (await versionOf(c.target)) === v + 1);
    }
    // Старые клиенты без версии: правка поля повторяется, обе проходят и версия растёт дважды
    {
      const c = cases[0];
      await seed();
      const v = await versionOf(c.target);
      const results = await Promise.all([send(c, undefined), send(c, undefined)]);
      check('PUT class: два клиента без версии — оба 200', results.every((r) => r.status === 200), results);
      check('PUT class: версия выросла на число записей', (await versionOf(c.target)) === v + 2);
    }

    // ── Чтение дерева оборудования отдаёт версию у установки, моноблока и позиции
    {
      await seed();
      const r = await fetch(`${origin}/api/projects/p1/systems`);
      const body: any = await r.json();
      const sys = body.systems?.find((s: any) => s.id === 'S1');
      const mono = sys?.monoblocks?.find((m: any) => m.id === 'M1');
      const el = mono?.components?.find((e: any) => e.id === 'C1');
      check('GET дерева оборудования: version у установки, моноблока и позиции',
        r.status === 200 && sys?.version === 3 && mono?.version === 2 && el?.version === 4, { status: r.status, sys: sys?.version, mono: mono?.version, el: el?.version });
    }

    console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${checks})`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await raw.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
