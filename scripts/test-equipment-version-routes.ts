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
 *
 * Отказы с изменениями коллеги и открытая запись (.claude/progress/conflict-details.md):
 *  • текст отказа — из словаря по случаю (правка, удаление, создание внутри), без кода;
 *  • отказ по позиции несёт в `current` теги `[{ id, code }]`;
 *  • записи уже нет — 404 `RECORD_GONE` с текстом словаря и без записи в базу (удаление удалённого — 200);
 *  • два человека: позиция, открытая у коллеги, или установка, открытая (или с открытой вложенной
 *    позицией) у коллеги, не удаляется; открытая вложенная позиция удалению позиции-владельца не мешает
 *    (вложенные поднимаются на уровень выше, версия растёт) — 409 `RECORD_OPEN`, держатели и запись названы, в базе ничего не
 *    изменилось; свои окна, несвежие отметки (больше 90 с) и чужие записи удалению не мешают;
 *    таблицы открытых записей нет — удаление идёт.
 *
 * Мутации, которыми набор проверен (каждая роняет его): убрать `openCheck` у удаления позиции;
 * убрать его у удаления установки; не смотреть вложенные у установки; смотреть вложенные у позиции; убрать `tags` из
 * `current`; вернуть 404 без кода; вернуть прежнюю строку отказа вместо словаря.
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
import { ensureOpenTable } from '../server/openRecords.js';
import {
  editChangedText, deleteChangedText, createInsideChangedText, editGoneText, createInsideGoneText, deleteOpenText, deleteOpenNestedText,
} from '../src/lib/refusalTexts.js';

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
  await raw.openRecord.deleteMany({});
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
    for (const [id, name] of [['u-petrova', 'Петрова А. А.'], ['u-sidorov', 'Сидоров С. С.']]) await raw.user.create({ data: { id, symbol: `s-${id}`, password: 'x', name } });

    const app = express();
    app.use(express.json());
    // Кто действует — заголовком: в наборе двое людей, а личность маршруты берут только из сессии
    app.use((req, _res, next) => { (req as any).authUser = { id: req.header('x-test-user') || 'fixture-user', name: 'Инженер', role: 'ADMIN', isActive: true }; next(); });
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

    // ── Тексты отказов, теги в отказе по позиции, «записи уже нет» ──
    console.log('\n── отказы: тексты, теги, RECORD_GONE');
    const byName = (n: string) => cases.find((c) => c.name === n)!;
    const staleTextOf = (c: Case): string => {
      if (c.name === 'DELETE /api/equipment/component/:id') return deleteChangedText('position', 'Вентилятор');
      if (c.name === 'DELETE /api/systems/:id') return deleteChangedText('system', 'SYS-1');
      if (c.name === 'POST /api/equipment/component/:id/position') return createInsideChangedText('position', 'Вентилятор');
      if (c.name === 'POST /api/equipment/monoblock/:id/position') return createInsideChangedText('block', 'M1');
      return editChangedText('position', 'Вентилятор');
    };
    const goneTextOf = (c: Case): string => {
      if (c.name === 'POST /api/equipment/component/:id/position') return createInsideGoneText('position');
      if (c.name === 'POST /api/equipment/monoblock/:id/position') return createInsideGoneText('block');
      return editGoneText('position');
    };
    const removeTarget = async (t: Target) => {
      if (t.model === 'componentElement') {
        await raw.componentElement.update({ where: { id: t.id }, data: { tags: { set: [] } } });
        await raw.componentElement.delete({ where: { id: t.id } });
      } else await (raw as any)[t.model].delete({ where: { id: t.id } });
    };
    for (const c of cases) {
      await seed();
      const v = await versionOf(c.target);
      const refused = await send(c, v - 1);
      check(`${c.name}: текст отказа — из словаря по случаю`, refused.status === 409 && refused.body?.error === staleTextOf(c), refused.body?.error);
      check(`${c.name}: в тексте отказа нет кода`, !/VERSION_CONFLICT|RECORD_/.test(refused.body?.error));
      if (c.target.model === 'componentElement') {
        const expectTags = (await raw.componentElement.findUnique({ where: { id: c.target.id }, include: { tags: true } })).tags
          .map((t: any) => ({ id: t.id, code: t.identifier })).sort((a: any, b: any) => a.id.localeCompare(b.id));
        const got = [...(refused.body?.current?.tags || [])].sort((a: any, b: any) => a.id.localeCompare(b.id));
        check(`${c.name}: current отказа несёт теги позиции [{ id, code }]`, expectTags.length > 0 && JSON.stringify(got) === JSON.stringify(expectTags), { got, expectTags });
      } else {
        check(`${c.name}: у отказа по ${c.target.model} тегов в current нет`, refused.body?.current && refused.body.current.tags === undefined, refused.body?.current);
      }

      // Записи уже нет: 404 с кодом и текстом словаря, ничего не записано; удаление удалённого — 200, как было
      await seed();
      await removeTarget(c.target);
      const before = await world();
      const gone = await send(c, v);
      if (c.growth === 'gone') {
        check(`${c.name}: запись уже удалена — 200 alreadyGone, как и раньше`, gone.status === 200 && (gone.body?.alreadyGone === true), gone);
      } else {
        check(`${c.name}: записи нет — 404, RECORD_GONE и текст словаря`, gone.status === 404 && gone.body?.code === 'RECORD_GONE' && gone.body?.error === goneTextOf(c), gone);
        check(`${c.name}: в тексте «записи нет» нет кода`, !/RECORD_GONE|VERSION_CONFLICT/.test(gone.body?.error));
        check(`${c.name}: записи нет — в базе не изменилось ничего`, same(before, await world()));
      }
    }
    void byName;

    // ── Открытая запись не удаляется: два человека, настоящие маршруты ──
    console.log('\n── открытые записи: два человека');
    const ME = 'fixture-user';
    const holds = (userId: string, model: string, recordId: string, at: Date = new Date()) =>
      raw.openRecord.create({ data: { model, recordId, userId, holderKey: `window-${userId}`, at } });
    const delPosition = byName('DELETE /api/equipment/component/:id');
    const delSystem = byName('DELETE /api/systems/:id');
    const ago = (ms: number) => new Date(Date.now() - ms);
    const open409 = (r: { status: number; body: any }) => r.status === 409 && r.body?.code === 'RECORD_OPEN';
    const petrova = [{ userId: 'u-petrova', name: 'Петрова А. А.' }];

    {
      await seed();
      await holds('u-petrova', 'ComponentElement', 'C1');
      const before = await world();
      const r = await send(delPosition, await versionOf(delPosition.target));
      check('позиция открыта у коллеги: 409 RECORD_OPEN', open409(r), r);
      check('позиция открыта у коллеги: держатель и запись названы',
        JSON.stringify(r.body?.holders) === JSON.stringify(petrova) && JSON.stringify(r.body?.record) === JSON.stringify({ model: 'ComponentElement', id: 'C1', name: 'Вентилятор' }), r.body);
      check('позиция открыта у коллеги: текст словаря, без кода', r.body?.error === deleteOpenText('position', 'Вентилятор', petrova) && !/RECORD_OPEN/.test(r.body?.error), r.body?.error);
      check('позиция открыта у коллеги: в базе не изменилось ничего (ни позиция, ни дети, ни теги)', same(before, await world()));
      const withoutVersion = await send(delPosition, undefined);
      check('клиент без версии (старая сборка) открытую позицию тоже не удалит', open409(withoutVersion) && same(before, await world()), withoutVersion);
    }
    {
      // Вложенные не удаляются, а поднимаются на уровень выше: открытая у коллеги вложенная владельцу не мешает
      await seed();
      await raw.componentElement.create({ data: { id: 'C4', name: 'Датчик ПТС', itemCode: 'FAN-1/м/д', monoblockId: 'M1', role: 'ДАТЧИК', parentElementId: 'C2' } });
      await holds('u-petrova', 'ComponentElement', 'C2');
      await holds('u-petrova', 'ComponentElement', 'C4');
      const before = await world();
      const r = await send(delPosition, await versionOf(delPosition.target));
      const after = await world();
      check('открыта вложенная у коллеги: владелец удаляется', r.status === 200 && !comp(after, 'C1'), r);
      check('открытая вложенная цела и поднята на уровень выше', !!comp(after, 'C2') && comp(after, 'C2').parentElementId === null && comp(after, 'C4')?.parentElementId === 'C2', after.components.map((c: any) => [c.id, c.parentElementId]));
      check('у поднятой вложенной версия выросла на 1: сохранение коллеги по старой версии получит отказ, а не затрёт',
        comp(after, 'C2').version === comp(before, 'C2').version + 1, [comp(before, 'C2').version, comp(after, 'C2').version]);
      const staleSave = await fetch(`${origin}/api/equipment/component/C2/class`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'x-test-user': 'u-petrova' }, body: JSON.stringify({ equipClass: 'ВЕНТИЛЯТОР', expectedVersion: comp(before, 'C2').version }),
      });
      check('правка коллеги по версии до подъёма — 409 VERSION_CONFLICT', staleSave.status === 409 && (await staleSave.json() as any).code === 'VERSION_CONFLICT');
    }

    {
      await seed();
      await holds('u-petrova', 'ComponentElement', 'C3');
      const r = await send(delPosition, await versionOf(delPosition.target));
      check('открыта чужая, не вложенная позиция: удаление проходит', r.status === 200 && !comp(await world(), 'C1'), r);
    }
    {
      await seed();
      await holds(ME, 'ComponentElement', 'C1');
      const r = await send(delPosition, await versionOf(delPosition.target));
      check('своё окно удалению не мешает', r.status === 200 && !comp(await world(), 'C1'), r);
    }
    {
      await seed();
      await holds('u-petrova', 'ComponentElement', 'C1', ago(100_000));
      const r = await send(delPosition, await versionOf(delPosition.target));
      check('несвежая отметка (100 с) запись не держит: удаление проходит', r.status === 200 && !comp(await world(), 'C1'), r);
    }
    {
      await seed();
      await holds('u-petrova', 'ComponentElement', 'C1');
      const r = await send(delPosition, (await versionOf(delPosition.target)) - 1);
      check('и изменена, и открыта: отказ по версии идёт первым', r.status === 409 && r.body?.code === 'VERSION_CONFLICT', r);
    }

    {
      await seed();
      await holds('u-petrova', 'EquipmentSystem', 'S1');
      const before = await world();
      const r = await send(delSystem, await versionOf(delSystem.target));
      check('установка открыта у коллеги: 409 RECORD_OPEN, текст словаря',
        open409(r) && r.body?.error === deleteOpenText('system', 'SYS-1', petrova) && r.body?.record?.model === 'EquipmentSystem' && JSON.stringify(r.body?.holders) === JSON.stringify(petrova), r.body);
      check('установка открыта у коллеги: в базе не изменилось ничего', same(before, await world()));
    }
    for (const id of ['C1', 'C2', 'C3']) {
      await seed();
      await holds('u-petrova', 'ComponentElement', id);
      const before = await world();
      const r = await send(delSystem, await versionOf(delSystem.target));
      const inner = comp(before, id);
      check(`открыта позиция ${id} внутри установки: удаление установки отказано, названа позиция`,
        open409(r) && r.body?.record?.id === id && r.body?.error === deleteOpenNestedText({ noun: 'system', name: 'SYS-1' }, { noun: 'position', name: inner.name }, petrova), r.body);
      check(`открыта позиция ${id} внутри установки: ни установка, ни блоки, ни позиции, ни теги не тронуты`, same(before, await world()));
    }
    {
      await seed();
      await holds('u-petrova', 'ComponentElement', 'C1');
      await holds('u-sidorov', 'ComponentElement', 'C3');
      const r = await send(delSystem, await versionOf(delSystem.target));
      check('открыто двумя людьми разных позиций: отказ, назван первый найденный держатель', open409(r) && ['C1', 'C3'].includes(r.body?.record?.id), r.body);
    }
    {
      await seed();
      await holds('u-petrova', 'ComponentElement', 'OTHER');
      await holds('u-petrova', 'EquipmentSystem', 'S2');
      const r = await send(delSystem, await versionOf(delSystem.target));
      check('открыто чужое, не из этой установки: удаление проходит', r.status === 200 && (await world()).systems.length === 0, r);
    }
    {
      await seed();
      await holds(ME, 'EquipmentSystem', 'S1');
      await holds(ME, 'ComponentElement', 'C2');
      const r = await send(delSystem, await versionOf(delSystem.target));
      check('свои окна установке не мешают', r.status === 200 && (await world()).systems.length === 0, r);
    }

    // Таблицы открытых записей нет (общая база старой версии): удаление идёт без этой защиты, а не встаёт
    {
      await seed();
      await raw.$executeRawUnsafe('DROP TABLE "OpenRecord"');
      const r = await send(delPosition, await versionOf(delPosition.target));
      check('таблицы открытых записей нет: удаление позиции проходит', r.status === 200 && !comp(await world(), 'C1'), r);
      await ensureOpenTable(raw);
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
