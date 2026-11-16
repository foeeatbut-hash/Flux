/**
 * Клиентские правила записи по предпросмотру (строка 5 очерёдности, .claude/progress/bulk-plan-guard.md):
 * без браузера и без сети, на голых объектах — набор работает и там, где набор интерфейса пропускается.
 *
 *  • shared/tagImportPlan: какие теги ввоз тронет (код строки в режиме «обновить», родитель всегда);
 *  • registry/planWrite: `seen` из версий, отказ → перечень «было → стало» по записям (изменён, удалён,
 *    появился после предпросмотра), версии для повторного подтверждения, разбор отказа сервера;
 *  • capture/replan: после отказа решения человека переносятся там, где основание не менялось, и сняты там, где менялось;
 *  • vdr/planRefusal: то же для строк ВДР.
 */
import assert from 'node:assert/strict';
import { importTouchedKeys, tagIdsOfKeys } from '../shared/tagImportPlan';
import { seenOfTags, planRefusalOf, reseen, runPlan, byIdOf, namesOf } from '../src/components/registry/planWrite';
import { replan } from '../src/capture/replan';
import { buildPlan } from '../src/capture/plan';
import { EMPTY_SHAPE } from '../src/capture/recognize';
import { itemPlanRefusal, reseenItems, shownById } from '../src/components/vdr/planRefusal';

let passed = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 600)}`}`);
  passed++; console.log(`✓ ${label}`);
};

const tag = (id: string, identifier: string, version: number, extra: Record<string, unknown> = {}) => ({ id, identifier, version, metadata: '{}', ...extra });

async function main() {
  // ── какие теги тронет ввоз ──
  {
    const rows = [{ identifier: ' AHU-1 ', parent: 'ahu-0' }, { identifier: 'FAN-2' }, { identifier: '' }];
    check('режим «обновить»: тронуты коды строк и родитель (по ключу: регистр и пробелы не мешают)',
      [...importTouchedKeys(rows, 'update')].sort().join() === 'ahu-0,ahu-1,fan-2');
    check('режим «добавить»: совпавший по коду тег не пишется — тронут только родитель', [...importTouchedKeys(rows, 'add')].join() === 'ahu-0');
    check('строка сама себе родитель не добавляет лишнего', [...importTouchedKeys([{ identifier: 'A-1', parent: 'a-1' }], 'add')].length === 0);
    const tags = [tag('T1', 'AHU-1', 3), tag('T0', 'AHU-0', 1), tag('T9', 'ZZZ-9', 1)];
    check('теги по ключам: находятся независимо от регистра', tagIdsOfKeys(tags, importTouchedKeys(rows, 'update')).sort().join() === 'T0,T1');
  }

  // ── seen и перечень ──
  const tags = [tag('T1', 'AHU-1', 3, { brand: 'Acme' }), tag('T2', 'AHU-2', 5), tag('T3', 'AHU-3', 2), { id: 'T4', identifier: 'AHU-4' }];
  {
    check('seen: версии только названных тегов; тег без версии (старый ответ) не попадает', JSON.stringify(seenOfTags(tags, ['T1', 'T4', 'T9'])) === '{"T1":3}');
    check('seen: версия строкой «5» читается, «0» и дробная — нет', JSON.stringify(seenOfTags([tag('A', 'a', '5' as any), tag('B', 'b', 0), tag('C', 'c', 1.5)], ['A', 'B', 'C'])) === '{"A":5}');
  }
  {
    const shown = byIdOf(tags);
    const data = {
      error: 'Пока вы смотрели предпросмотр, часть записей изменили. Ничего не записано.',
      changed: [
        { id: 'T1', current: { ...tags[0], version: 4, brand: 'Beta' } },
        { id: 'T7', current: { id: 'T7', identifier: 'NEW-7', version: 1, metadata: '{}' } },
      ],
      gone: ['T3'],
    };
    const r = planRefusalOf(data, shown, namesOf(tags));
    check('отказ: текст сервера как есть, вид — «изменили»', r.kind === 'conflict' && r.message === data.error);
    check('отказ: изменённый тег — «Марка: Acme → Beta» под кодом тега', r.groups?.[0].title === 'AHU-1' && JSON.stringify(r.groups[0].changes) === JSON.stringify([{ label: 'Марка', was: 'Acme', now: 'Beta' }]), r.groups);
    check('отказ: тег, которого предпросмотр не видел, назван своим кодом и «появился после предпросмотра»',
      r.groups?.[1].title === 'NEW-7' && r.groups[1].changes[0].now === 'появился после предпросмотра', r.groups?.[1]);
    check('отказ: удалённый тег — «есть → удалён» под кодом из предпросмотра', r.groups?.[2].title === 'AHU-3' && r.groups[2].changes[0].now === 'удалён', r.groups?.[2]);
    check('версии для повторного подтверждения: изменённый — новая версия, удалённый — убран, остальные те же',
      JSON.stringify(reseen({ T1: 3, T2: 5, T3: 2 }, [{ id: 'T1', current: data.changed[0].current }], ['T3'])) === '{"T1":4,"T2":5}');
  }

  // ── разбор отказа сервера ──
  {
    const refused = (status: number, body: any) => Object.assign(new Error(String(body?.error || 'x')), { name: 'WriteRefusal', status, body });
    const shown = byIdOf(tags);
    const conflict = await runPlan(async () => { throw refused(409, { error: 't', code: 'VERSION_CONFLICT', changed: [{ id: 'T1', current: { ...tags[0], version: 9, brand: 'B' } }], gone: ['T3'] }); }, shown, {}, 'сбой');
    check('отказ по версии → «changed» с перечнем и версиями', conflict.kind === 'changed' && conflict.changed[0].id === 'T1' && conflict.gone.join() === 'T3' && conflict.refusal.groups?.length === 2, conflict);
    const open = await runPlan(async () => { throw refused(409, { error: 'открыто', code: 'RECORD_OPEN', holders: [{ userId: 'u', name: 'Петрова' }], record: null }); }, shown, {}, 'сбой');
    check('запись открыта у коллеги — не «изменили»: перечитывать план нечего', open.kind === 'failed' && open.refusal.kind === 'open', open);
    const duplicate = await runPlan(async () => { throw refused(409, { error: 'Тег «A» уже заведён', duplicate: true, code: 'A' }); }, shown, {}, 'сбой');
    check('занятый код (409 без кода отказа) — прочий отказ, текст сервера', duplicate.kind === 'failed' && duplicate.refusal.kind === 'plain' && /уже заведён/.test(duplicate.refusal.message), duplicate);
    const offline = await runPlan(async () => { throw new TypeError('Failed to fetch'); }, shown, {}, 'сбой');
    check('сеть пропала — прочий отказ', offline.kind === 'failed' && offline.refusal.kind === 'plain', offline);
    const ok = await runPlan(async () => ({ created: 1 }), shown, {}, 'сбой');
    check('успех — данные как есть', ok.kind === 'ok' && (ok.data as any).created === 1);
  }

  // ── план захвата заново ──
  {
    const rows = [
      { key: 'r1', identifier: 'AHU-1', verdict: 'fits', spans: [], brand: 'Новая' },
      { key: 'r2', identifier: 'FAN-2', verdict: 'fits', spans: [], brand: 'Zed' },
      { key: 'r3', identifier: 'NEW-9', verdict: 'fits', spans: [] },
    ] as any[];
    const shape = EMPTY_SHAPE;
    const before = [tag('T1', 'AHU-1', 3, { brand: null }), tag('T2', 'FAN-2', 5, { brand: null })];
    const plan = buildPlan(rows, before, shape).map((r) => (r.key === 'r3' ? { ...r, action: 'skip' as const, on: false } : r));
    check('исходный план: две строки «дополнить» отмечены, третья снята человеком', plan.filter((r) => r.on).length === 2 && !plan[2].on, plan.map((r) => [r.key, r.cls, r.on]));
    // FAN-2 изменили (отдел), AHU-1 нет
    const fresh = [before[0], { ...before[1], version: 6, department: 'ВК', brand: 'Чужая' }];
    const next = replan(plan, rows, fresh as any, shape, new Set(['T2']));
    const by = Object.fromEntries(next.map((r) => [r.key, r]));
    check('строка нетронутого тега сохранила решение человека', by.r1.on && by.r1.action === plan[0].action);
    check('строка изменённого тега пришла со снятой отметкой (подтверждать заново)', by.r2.on === false);
    check('строка изменённого тега пересчитана по свежим данным («Чужая» ≠ «Zed» — расхождение)', by.r2.cls === 'exactDiff', by.r2.cls);
    check('снятая человеком строка осталась снятой', by.r3.on === false);
    const gone = replan(plan, rows, [before[0]] as any, shape, new Set(['T2']));
    check('удалённая цель: строка стала «новой» и пришла снятой — программа сама не создаёт вместо удалённого', gone[1].cls !== 'exactFill' && gone[1].on === false, gone[1].cls);
  }

  // ── строки ВДР ──
  {
    const items = [
      { id: 'I1', contractorNo: 'ДОК-1', titleRu: 'Общий вид', revision: 'A', version: 4, extra: {}, equipmentTags: '[]' },
      { id: 'I2', contractorNo: 'ДОК-2', titleRu: 'Схема', revision: 'A', version: 4, extra: {}, equipmentTags: '[]' },
    ];
    const data = {
      error: 'Пока шёл ввоз изменили.',
      changed: [{ id: 'I1', current: { ...items[0], titleRu: 'Общий вид (правка)', version: 5 } }, { id: 'I2', current: { ...items[1], version: 5 } }],
      gone: ['I9'],
    };
    const r = itemPlanRefusal(data, shownById(items));
    check('ВДР: изменённая строка — «Наименование (рус): было → стало» под номером документа', r.groups?.[0].title === 'ДОК-1' && r.groups[0].changes[0].now === 'Общий вид (правка)', r.groups);
    check('ВДР: строка, у которой видимое не изменилось (выросла только версия), названа в примечаниях, а не молча пропущена', r.notes?.[0].title === 'ДОК-2', r.notes);
    check('ВДР: удалённая строка — «есть → удалена»', r.groups?.some((g) => g.changes[0].now === 'удалена') === true, r.groups);
    check('ВДР: версии для повторного подтверждения — новые у изменённых, удалённые убраны',
      JSON.stringify(reseenItems({ I1: 4, I2: 4, I9: 2 }, data)) === '{"I1":5,"I2":5}');
  }

  console.log(`\nПройдено проверок: ${passed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
