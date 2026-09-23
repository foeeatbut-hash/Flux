/**
 * Очередь фонового ввоза: что она обещает и чего не делает.
 *
 * Заказчик приносит расчёт папкой — двадцать три выгрузки за раз. Раньше такой
 * ввоз жил во вкладке браузера и умирал вместе с ней. Теперь очередь живёт в
 * базе, и проверять надо не «импорт работает» (это дело живых прогонов), а
 * свойства самой очереди, которые ломаются молча:
 *
 *   — повтор постановки не заводит второй ввоз;
 *   — задание берётся в аренду, и второй проход чужое не трогает;
 *   — неудача не теряется: отступ растёт, попытки считаются, кончились —
 *     задание становится FAILED с причиной словами;
 *   — партия закрывается сама, когда незаконченных заданий не осталось;
 *   — отмена не обрывает то, что уже пишется.
 *
 * База — заглушка в памяти: настоящая тут не нужна, а нужна возможность
 * подсунуть падение и перемотать время.
 *
 * Запуск: npx tsx scripts/test-import-jobs.ts
 */

import { setPrisma } from '../server/context';
import { queueImport, drainImportJobs, cancelBatch } from '../server/importJobs';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

// ── Заглушка базы ───────────────────────────────────────────────────────────

interface Row { [k: string]: any }

const store: Record<string, Row[]> = { ImportBatch: [], ImportJob: [] };
/** Что должен сделать импорт: пусто — записать, текст — упасть с этой причиной */
let breakImportWith = '';
let imported = 0;

const match = (row: Row, where: Row): boolean => {
  for (const [key, cond] of Object.entries(where || {})) {
    if (key === 'OR') {
      if (!(cond as Row[]).some((c) => match(row, c))) return false;
      continue;
    }
    const v = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond && !(cond as any).in.includes(v)) return false;
      if ('lt' in cond && !(v != null && v < (cond as any).lt)) return false;
      if ('lte' in cond && !(v != null && v <= (cond as any).lte)) return false;
      if ('not' in cond && v === (cond as any).not) return false;
      continue;
    }
    if (v !== cond) return false;
  }
  return true;
};

/**
 * Значения по умолчанию — те же, что в схеме.
 *
 * Без них заглушка врёт в самом важном месте: задание без `availableAt` и
 * `attempt` не подошло бы ни под одно условие выборки, и проверка показала бы
 * «очередь не работает» там, где не работает сама заглушка.
 */
const DEFAULTS: Record<string, () => Row> = {
  ImportBatch: () => ({ state: 'RUNNING' }),
  ImportJob: () => ({ state: 'QUEUED', attempt: 0, availableAt: new Date(), leaseUntil: null, leaseOwner: null }),
};

const table = (name: string) => ({
  create: async ({ data }: any) => {
    const row: Row = {
      id: `${name}-${store[name].length + 1}`,
      createdAt: new Date(), updatedAt: new Date(),
      ...(DEFAULTS[name]?.() || {}), ...data,
    };
    // Уникальный ключ идемпотентности держит база, а не код — здесь тоже
    if (name === 'ImportJob' && store[name].some((r) => r.idemKey === row.idemKey)) {
      throw new Error('UNIQUE constraint failed: ImportJob.idemKey');
    }
    store[name].push(row);
    return { ...row };
  },
  findMany: async ({ where = {}, take, orderBy }: any = {}) => {
    let rows = store[name].filter((r) => match(r, where));
    if (orderBy?.createdAt === 'asc') rows = [...rows].sort((a, b) => a.createdAt - b.createdAt);
    return (take ? rows.slice(0, take) : rows).map((r) => ({ ...r }));
  },
  count: async ({ where = {} }: any = {}) => store[name].filter((r) => match(r, where)).length,
  update: async ({ where, data }: any) => {
    const row = store[name].find((r) => r.id === where.id);
    if (!row) throw new Error('нет такой записи');
    for (const [k, v] of Object.entries(data)) {
      row[k] = v && typeof v === 'object' && 'increment' in (v as any)
        ? (row[k] || 0) + (v as any).increment : v;
    }
    return { ...row };
  },
  updateMany: async ({ where, data }: any) => {
    const rows = store[name].filter((r) => match(r, where));
    for (const row of rows) {
      for (const [k, v] of Object.entries(data)) {
        row[k] = v && typeof v === 'object' && 'increment' in (v as any)
          ? (row[k] || 0) + (v as any).increment : v;
      }
    }
    return { count: rows.length };
  },
});

/**
 * Сам импорт подменяется через таблицы, которыми он пользуется.
 *
 * Нам важно не то, что он пишет, а то, как очередь ведёт себя, когда он падает
 * и когда проходит. Поэтому «упал» задаётся снаружи одной переменной.
 */
const prisma: any = {
  $executeRawUnsafe: async () => 0,
  importBatch: table('ImportBatch'),
  importJob: table('ImportJob'),
  projectTagPolicy: { findFirst: async () => null },
  equipmentSystem: {
    findFirst: async () => { if (breakImportWith) throw new Error(breakImportWith); return { id: 'sys1' }; },
    // Запись ищет установку тем же сравнением, что и план: списком проекта
    findMany: async () => { if (breakImportWith) throw new Error(breakImportWith); return []; },
    create: async () => ({ id: 'sys1' }),
    update: async ({ data }: any) => ({ id: 'sys1', ...data }),
  },
  project: { findUnique: async () => ({ code: '' }) },
  monoblock: { findFirst: async () => ({ id: 'mb1' }), create: async () => ({ id: 'mb1' }) },
  componentElement: {
    findFirst: async () => null,
    create: async () => { imported++; return { id: `el${imported}` }; },
    update: async () => ({}),
    findMany: async () => [],
  },
  equipmentHistory: { create: async () => ({}) },
  tag: { findMany: async () => [], create: async () => ({ id: 't1' }), findUnique: async () => null, update: async () => ({}) },
};
setPrisma(prisma);

const oneFile = (name: string) => ({
  fileName: name,
  units: [{
    name: 'У1', title: 'Установка', groups: [], tags: [],
    monoblocks: [{ name: 'M1', title: '', blocks: [{
      name: 'Б1', title: 'Вентилятор', equipType: 'ВЕНТИЛЯТОР',
      groups: [{ title: 'Аэродинамика', params: [{ key: 'Расход', value: '5000', unit: 'м³/ч' }] }],
    }] }],
  }],
});

const jobs = () => store.ImportJob;
const byName = (n: string) => jobs().find((j) => j.fileName === n)!;
/** Перемотать время вперёд: отступ перед повтором не ждём по-настоящему */
const rewind = () => { for (const j of jobs()) j.availableAt = new Date(Date.now() - 1000); };

(async () => {
  console.log('1. Постановка партии');
  {
    const out = await queueImport('p1', 'AHU', 'Расчёт, файлов: 2',
      [oneFile('а.xml'), oneFile('б.xml')], 'сеанс-1', 'u1');
    ok('поставлено два задания', out.queued === 2 && out.already === 0, out);
    ok('партия заведена', store.ImportBatch.length === 1, store.ImportBatch);
    ok('задания ждут очереди', jobs().every((j) => j.state === 'QUEUED'), jobs().map((j) => j.state));
  }

  console.log('\n2. Повтор постановки — не второй ввоз');
  {
    const again = await queueImport('p1', 'AHU', 'Расчёт, файлов: 2',
      [oneFile('а.xml'), oneFile('б.xml')], 'сеанс-1', 'u1');
    ok('ни одного нового задания', again.queued === 0 && again.already === 2, again);
    ok('заданий по-прежнему два', jobs().length === 2, jobs().length);
  }

  console.log('\n3. Проход: по одному заданию за раз, остальное в аренду не берётся');
  {
    const done = await drainImportJobs();
    ok('выполнено одно задание', done === 1, done);
    ok('первое готово', byName('а.xml').state === 'DONE', byName('а.xml'));
    ok('в нём записан итог', !!byName('а.xml').summaryJson, byName('а.xml').summaryJson);
    ok('второе ещё ждёт', byName('б.xml').state === 'QUEUED', byName('б.xml'));
    ok('аренда снята с готового', !byName('а.xml').leaseUntil && !byName('а.xml').leaseOwner);
  }

  console.log('\n4. Чужая аренда не отдаёт задание второму проходу');
  {
    // Сосед взял задание минуту назад и ещё держит
    const b = byName('б.xml');
    b.leaseOwner = 'сосед';
    b.leaseUntil = new Date(Date.now() + 60_000);
    const done = await drainImportJobs();
    ok('проход ничего не взял', done === 0, done);
    ok('задание осталось за соседом', b.leaseOwner === 'сосед', b);
    // Аренда истекла — задание возвращается в очередь само
    b.leaseUntil = new Date(Date.now() - 1000);
    b.leaseOwner = null;
    ok('после истечения аренды проход его берёт', (await drainImportJobs()) === 1);
    ok('и доводит до конца', byName('б.xml').state === 'DONE', byName('б.xml'));
  }

  console.log('\n5. Партия закрывается сама');
  {
    await drainImportJobs();
    ok('партия отмечена готовой', store.ImportBatch[0].state === 'DONE', store.ImportBatch[0]);
  }

  console.log('\n6. Неудача: отступ растёт, попытки считаются, падение видно');
  {
    breakImportWith = 'база недоступна';
    await queueImport('p1', 'AHU', 'Битый', [oneFile('в.xml')], 'сеанс-2', 'u1');

    const first = new Date();
    await drainImportJobs();
    const job = () => byName('в.xml');
    ok('после первой неудачи задание снова в очереди', job().state === 'QUEUED', job());
    ok('попытка засчитана', job().attempt === 1, job().attempt);
    ok('повтор отложен', job().availableAt > first, [job().availableAt, first]);
    ok('причина записана словами', /база недоступна/.test(job().error || ''), job().error);

    // Пока отступ не вышел, проход задание не трогает
    ok('до срока задание не берётся', (await drainImportJobs()) === 0);

    rewind(); await drainImportJobs();
    ok('вторая попытка засчитана', job().attempt === 2, job().attempt);
    rewind(); await drainImportJobs();
    ok('кончились попытки — задание не удалось', job().state === 'FAILED', job());
    ok('и причина осталась при нём', !!job().error, job().error);

    rewind();
    ok('упавшее задание проход больше не берёт', (await drainImportJobs()) === 0);
    const failedBatch = store.ImportBatch.find((b) => b.title === 'Битый');
    ok('партия закрыта как неудачная', failedBatch?.state === 'FAILED', failedBatch);
    breakImportWith = '';
  }

  console.log('\n7. Отмена не обрывает то, что уже пишется');
  {
    const out = await queueImport('p1', 'AHU', 'Отменяемый',
      [oneFile('г.xml'), oneFile('д.xml')], 'сеанс-3', 'u1');
    // Одно уже пишется, второе ждёт
    byName('г.xml').state = 'RUNNING';
    const res = await cancelBatch(out.batchId);
    ok('отменено только ждущее', res.cancelled === 1, res);
    ok('и сказано, сколько пишется', res.running === 1, res);
    ok('ждущее отменено', byName('д.xml').state === 'CANCELLED', byName('д.xml'));
    ok('пишущееся не тронуто', byName('г.xml').state === 'RUNNING', byName('г.xml'));

    const batch = store.ImportBatch.find((b) => b.id === out.batchId);
    ok('партия пока не закрыта — в ней ещё пишут', batch?.state === 'RUNNING', batch);
  }

  console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(failed ? 1 : 0);
})();
