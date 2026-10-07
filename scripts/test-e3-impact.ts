/**
 * Что ввоз расчёта задевает в схемах E3 (docs/e3-integration.md, 9.4):
 * предупреждение «N позиций уже в схеме КИП» в предпросмотре и одно уведомление
 * на ввоз тому, кто выгружал. База подставная: делегаты с теми же вызовами.
 *
 * Запуск: npx tsx scripts/test-e3-impact.ts
 */
import { readFileSync } from 'node:fs';
import { boundElements, inSchemeOf, notifyExporters } from '../server/e3Impact';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failed++;
  console.error(`  ✗ ${name} — получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`);
};

const match = (r: any, w: any = {}) => Object.entries(w).every(([k, v]: [string, any]) => (v && typeof v === 'object' && 'in' in v ? v.in.includes(r[k]) : r[k] === v));
const db = (extra: Record<string, any[]> = {}) => {
  const rows: Record<string, any[]> = {
    e3Project: [{ id: 'P1', fluxProjectId: 'F1', name: 'Корпус 3 — ВК' }, { id: 'P2', fluxProjectId: 'F1', name: 'Корпус 4' }, { id: 'P3', fluxProjectId: 'F2', name: 'Чужой' }],
    e3Binding: [
      { e3ProjectId: 'P1', elementId: 'a', state: 'PLACED' }, { e3ProjectId: 'P1', elementId: 'b', state: 'PLACED' }, { e3ProjectId: 'P1', elementId: 'c', state: 'DETACHED' },
      { e3ProjectId: 'P2', elementId: 'a', state: 'PLACED' }, { e3ProjectId: 'P3', elementId: 'z', state: 'PLACED' },
    ],
    e3Export: [
      { e3ProjectId: 'P1', by: 'kip1', state: 'DONE', at: 2 }, { e3ProjectId: 'P1', by: 'old', state: 'DONE', at: 1 }, { e3ProjectId: 'P1', by: 'run', state: 'RUNNING', at: 3 },
      { e3ProjectId: 'P2', by: 'kip2', state: 'DONE', at: 1 },
    ],
    equipmentHistory: [{ batchId: 'B1', elementId: 'a' }, { batchId: 'B1', elementId: 'c' }, { batchId: 'B1', elementId: 'x' }, { batchId: 'B2', elementId: 'z' }],
    notification: [], ...extra,
  };
  const d = (n: string) => ({
    findMany: async ({ where }: any = {}) => rows[n].filter((r) => match(r, where)).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)),
    create: async ({ data }: any) => { rows[n].push(data); return data; },
  });
  return { rows, client: { e3Project: d('e3Project'), e3Binding: d('e3Binding'), e3Export: d('e3Export'), equipmentHistory: d('equipmentHistory'), notification: d('notification') } };
};

(async () => {
  console.log('Что стоит в схеме');
  const { rows, client } = db();
  eq('в схеме — только PLACED этого проекта Flux', (await boundElements(client, 'F1')).map((b) => `${b.e3ProjectId}:${b.elementId}`), ['P1:a', 'P1:b', 'P2:a']);
  eq('у другого проекта — свои', (await boundElements(client, 'F2')).map((b) => b.elementId), ['z']);
  eq('без делегатов E3 — пусто, ввоз не ломается', await boundElements({}, 'F1'), []);

  console.log('Предпросмотр: «N позиций уже в схеме КИП»');
  const touched = [{ elementId: 'a', systemName: 'П1' }, { elementId: 'b', systemName: 'П1' }, { elementId: 'x', systemName: 'П1' }, { elementId: 'a', systemName: 'П2' }, { elementId: undefined, systemName: 'П2' }];
  eq('считаются только стоящие в схеме, по установкам', await inSchemeOf(client, 'F1', touched), { count: 3, bySystem: { 'П1': 2, 'П2': 1 } });
  eq('нечего задевать — ноль', (await inSchemeOf(client, 'F1', [{ elementId: 'x' }])).count, 0);
  eq('без делегатов — ноль', (await inSchemeOf({}, 'F1', touched)).count, 0);
  const plan = readFileSync('server/equipmentPlan.ts', 'utf8');
  eq('предпросмотр импорта вызывает подсчёт и кладёт его в план', [plan.includes("inSchemeOf(prisma, projectId, touched)"), plan.includes('plan.inScheme = inScheme')], [true, true]);

  console.log('Уведомления: одно на ввоз тому, кто выгружал');
  eq('партия B1 задела a (в двух проектах E3) и c (отвязана): адресаты — авторы последних выгрузок', await notifyExporters(client, 'F1', 'B1', 'ov'), 2);
  const titles = rows.notification.map((n) => [n.userId, n.title, n.targetRoute]);
  eq('каждому — одно уведомление со ссылкой на E3Flux', titles, [
    ['kip1', 'Изменилась 1 позиция, выгруженная в «Корпус 3 — ВК»', '/e3flux'], ['kip2', 'Изменилась 1 позиция, выгруженная в «Корпус 4»', '/e3flux'],
  ]);
  eq('не тот, кто выгружал раньше, и не идущая выгрузка', rows.notification.some((n) => n.userId === 'old' || n.userId === 'run'), false);
  const self = db();
  eq('сам импортирующий об этом знает — ему не пишем', await notifyExporters(self.client, 'F1', 'B1', 'kip1'), 1);
  const none = db();
  eq('партия не задела выгруженное — тишина', await notifyExporters(none.client, 'F1', 'B2', 'ov'), 0);
  eq('без делегатов — тишина', await notifyExporters({}, 'F1', 'B1', 'ov'), 0);
  const imp = readFileSync('server/equipmentImport.ts', 'utf8');
  eq('запись импорта зовёт уведомление один раз, после всего', (imp.match(/notifyExporters\(/g) || []).length, 1);

  if (failed) { console.error(`\nПровалено проверок: ${failed}`); process.exit(1); }
  console.log('\nВсе проверки влияния импорта на схемы E3 пройдены');
})().catch((e) => { console.error(e); process.exit(1); });
