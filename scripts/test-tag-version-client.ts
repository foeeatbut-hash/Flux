/**
 * Экраны «Реестр» и «Закупки» шлют версию тега и узнают отказ по коду (строка 2 очерёдности).
 *
 * Без браузера и без службы. Три половины:
 *   1. Правила полей (src/components/registry/changeRules.ts): что человек видит у тега и
 *      что попадает в перечень «было → стало»; служебное (x, y, кто правил) не шумит.
 *   2. Разбор отказов и запись (tagRefusal.ts, tagWrite.ts) с подставным fetch: узнаётся по
 *      `code`, а не по тексту; запись с экрана берётся ДО подмены свежей копией; набранное
 *      не трогается; удаление несёт целую версию в строке; массовая запись несёт версии.
 *   3. Разбор исходников настоящим TypeScript: запись тега (PUT / PATCH / DELETE по
 *      /api/tags) идёт только через tagWrite.ts; ответ отказа не разбирается по тексту.
 *
 * Запуск: npx tsx scripts/test-tag-version-client.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { tagChanges, descriptionRows, metaOf } from '../src/components/registry/changeRules';
import { outcomeOf, refusalOf, bulkRefusalOf, deleteUrl, needsReread } from '../src/components/registry/tagRefusal';
import { runBulkWrite } from '../src/components/registry/bulkWrite';
import { saveTagMetadataPatch, saveProcurement, deleteTagRequest, bulkMetadataRequest, lastWriteKeptInput } from '../src/components/registry/tagWrite';
import { RECORD_GONE, RECORD_OPEN, VERSION_CONFLICT } from '../src/lib/refusalTexts';

const root = path.resolve(__dirname, '..');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const same = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); passed++; console.log(`  ✓ ${name}`); };

const meta = (o: object) => JSON.stringify(o);
const tag = (over: Record<string, unknown> = {}, m: object = {}) => ({
  id: 't1', version: 3, identifier: 'AHU-1', brand: 'Acme', department: 'ОВ', wbs: '1.1', fluid: 'воздух', equipmentId: null,
  updatedAt: '2026-01-01T10:00:00.000Z', metadata: meta({ x: 10, y: 20, mainName: 'Приточная установка', connections: [], descriptions: [], ...m }), ...over,
});

/** Подставной fetch: помнит запросы, отвечает по очереди заданными статусом и телом. */
function stubFetch(...replies: Array<{ status: number; body?: unknown; throws?: boolean }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const real = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r.throws) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const bodyOf = (c: { init?: RequestInit }) => JSON.parse(String(c.init?.body ?? '{}'));

function deps() {
  const log = { toasts: [] as string[], refusals: [] as any[], fresh: [] as any[], reloads: 0, tags: [tag()] as any[] };
  return {
    log,
    d: {
      setTags: (fn: any) => { log.tags = typeof fn === 'function' ? fn(log.tags) : fn; },
      addToast: (m: string) => { log.toasts.push(m); },
      onFresh: (t: any) => { log.fresh.push(t); },
      onRefusal: (r: any, shown: any) => { log.refusals.push({ r, shown }); },
      reload: () => { log.reloads++; },
    },
  };
}

(async () => {
  console.log('1. Правила полей');
  {
    same('нет изменений — перечня нет', tagChanges(tag(), tag({ version: 4 })), []);
    same('код, марка, WBS', tagChanges(tag(), tag({ identifier: 'AHU-2', brand: 'Beta', wbs: '2.0' })),
      [{ label: 'Код тега', was: 'AHU-1', now: 'AHU-2' }, { label: 'Марка', was: 'Acme', now: 'Beta' }, { label: 'WBS', was: '1.1', now: '2.0' }]);
    same('отдел и среда; пусто — прочерк', tagChanges(tag(), tag({ department: null, fluid: 'вода' })),
      [{ label: 'Отдел', was: 'ОВ', now: '—' }, { label: 'Среда', was: 'воздух', now: 'вода' }]);
    same('наименование из metadata', tagChanges(tag(), tag({}, { mainName: 'Вытяжная установка' })),
      [{ label: 'Наименование', was: 'Приточная установка', now: 'Вытяжная установка' }]);
    same('служебное (x, y, кто правил, разобранный кэш) не шумит',
      tagChanges(tag({ parsedMetadata: { x: 1 } }), tag({ updatedAt: 'иное' }, { x: 99, y: 98, _noPos: true, updatedBy: 'Иван', updatedAt: 'сегодня', __procMeta: {} })), []);
    same('оборудование: имя берётся у показанного тега', tagChanges(tag({ equipmentId: 'e1', equipment: { id: 'e1', type: 'FAN', description: 'Вентилятор' } }), tag({ equipmentId: 'e2' })),
      [{ label: 'Оборудование', was: 'Вентилятор', now: 'e2' }]);
    same('родитель и связи — именами', tagChanges(tag({}, { parentId: 'p1', connections: ['a'] }), tag({}, { parentId: 'p2', connections: ['b'] }), { tag: (id) => ({ p1: 'PAR-1', p2: 'PAR-2', a: 'FAN-1', b: 'FAN-2' } as any)[id] }),
      [{ label: 'Родитель', was: 'PAR-1', now: 'PAR-2' }, { label: 'Связь с FAN-1', was: 'есть', now: '—' }, { label: 'Связь с FAN-2', was: '—', now: 'есть' }]);
    same('связи без имён — по идентификатору', tagChanges(tag(), tag({}, { connections: ['zz'] })), [{ label: 'Связь с zz', was: '—', now: 'есть' }]);
    const d1 = { id: 'd1', text: 'Течь', comment: '', status: 'warning' };
    same('замечания: добавлено, изменено, убрано',
      tagChanges(tag({}, { descriptions: [d1, { id: 'd2', text: 'Шум', comment: '', status: 'actual' }] }), tag({}, { descriptions: [{ ...d1, status: 'critical', comment: 'сильно' }, { id: 'd3', text: 'Пыль', comment: 'ок', status: 'info' }] })),
      [{ label: 'Замечание «Течь»', was: 'проверить', now: 'критично — сильно' }, { label: 'Замечание «Шум»', was: 'актуально', now: '—' }, { label: 'Замечание «Пыль»', was: '—', now: 'в работе — ок' }]);
    same('замечание без статуса и комментария — «есть»', descriptionRows(tag({}, { descriptions: [{ id: 'x', text: 'Т' }] })), [{ label: 'Замечание «Т»', value: 'есть' }]);
    same('дополнительные поля — по названию из справочника', tagChanges(tag({}, { dynamicFields: { c1: 'A' } }), tag({}, { dynamicFields: { c1: 'B' } }), { field: (k) => (k === 'c1' ? 'Давление' : undefined) }),
      [{ label: 'Давление', was: 'A', now: 'B' }]);
    same('закупка: этап, шаблон, поставщик, количество, примечание',
      tagChanges(tag({}, { procurement: { stage: 'ordered', supplier: 'А' } }), tag({}, { procurement: { stage: 'approved', templateId: 'tpl', supplier: 'Б', qty: '2', note: 'срочно' } }),
        { stage: (s) => ({ ordered: 'Заказан', approved: 'Утверждён' } as any)[s], template: () => 'Насосы' }),
      [{ label: 'Этап закупки', was: 'Заказан', now: 'Утверждён' }, { label: 'Шаблон этапов', was: '—', now: 'Насосы' }, { label: 'Поставщик', was: 'А', now: 'Б' }, { label: 'Количество', was: '—', now: '2' }, { label: 'Примечание к закупке', was: '—', now: 'срочно' }]);
    same('журнал этапов (stageLog) отдельной строкой не идёт', tagChanges(tag({}, { procurement: { stage: 'a', stageLog: { a: { at: '1', by: 'x' } } } }), tag({}, { procurement: { stage: 'a', stageLog: { a: { at: '2', by: 'y' } } } })), []);
    same('нет одной из записей — перечень пуст', [tagChanges(null, tag()), tagChanges(tag(), null)], [[], []]);
    same('metadata не строка и не JSON', [metaOf({ metadata: '{оборвано' }), metaOf({ metadata: '[1]' }), metaOf({ parsedMetadata: { a: 1 } })], [{}, {}, { a: 1 }]);
  }

  console.log('2. Отказ узнаётся по коду');
  const asFetch = (status: number, body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status }));
  {
    const current = tag({ version: 4, brand: 'Beta' });
    const o = await outcomeOf(asFetch(409, { error: 'Тег изменили', code: VERSION_CONFLICT, current }));
    ok('409 с кодом — conflict, current доезжает', o.kind === 'conflict' && (o as any).current.brand === 'Beta');
    const r = refusalOf(o, tag(), {}, 'запасной');
    same('перечень «было → стало»', [r?.kind, r?.message, r?.changes], ['conflict', 'Тег изменили', [{ label: 'Марка', was: 'Acme', now: 'Beta' }]]);
    ok('изменилось только скрытое — перечень пуст, но это conflict', refusalOf(await outcomeOf(asFetch(409, { code: VERSION_CONFLICT, current: tag({ version: 9 }) })), tag(), {}, 'x')?.changes?.length === 0);
    ok('нужно перечитать', needsReread(o));
  }
  ok('409 без кода — не conflict (по тексту не узнаётся)', (await outcomeOf(asFetch(409, { error: 'Запись изменили, пока вы её правили' }))).kind === 'refused');
  ok('занятый код — отказ с текстом сервера, перечитывать нечего', await (async () => {
    const o = await outcomeOf(asFetch(409, { error: 'Такой код тега уже есть', duplicate: true }));
    return o.kind === 'refused' && refusalOf(o, tag(), {}, 'x')?.message === 'Такой код тега уже есть' && !needsReread(o);
  })());
  ok('код при чужом статусе — не conflict', (await outcomeOf(asFetch(500, { error: 'сбой', code: VERSION_CONFLICT }))).kind === 'refused');
  {
    const o = await outcomeOf(asFetch(404, { error: 'Тег «AHU-1» уже удалили. Ваша правка не записана.', code: RECORD_GONE }));
    ok('404 с кодом — gone', o.kind === 'gone' && refusalOf(o, tag(), {}, 'x')?.kind === 'gone' && needsReread(o));
    ok('404 без кода — не gone', (await outcomeOf(asFetch(404, { error: 'Не найдено' }))).kind === 'refused');
    ok('код gone при статусе 409 — не gone', (await outcomeOf(asFetch(409, { code: RECORD_GONE }))).kind === 'refused');
  }
  {
    const body = { error: 'Тег «AHU-1» сейчас открыт у сотрудника: Иванов И. И. Удалить его нельзя, пока запись открыта.', code: RECORD_OPEN, holders: [{ userId: 'u2', name: 'Иванов И. И.' }], record: { model: 'Tag', id: 't1', name: 'AHU-1' } };
    const o = await outcomeOf(asFetch(409, body));
    const r = refusalOf(o, tag(), {}, 'x');
    same('открыт у коллеги: текст сервера и кто держит', [o.kind, r?.kind, r?.message, r?.holders], ['open', 'open', body.error, [{ userId: 'u2', name: 'Иванов И. И.' }]]);
    ok('перечитывать при этом нечего', !needsReread(o));
    ok('409 с holders, но без кода — не open', (await outcomeOf(asFetch(409, { error: 'x', holders: [{ name: 'Иванов' }] }))).kind === 'refused');
  }
  ok('сеть не ответила — offline, не исключение', (await outcomeOf(() => Promise.reject(new TypeError('x')))).kind === 'offline');
  same('чужая ошибка — запасной текст', refusalOf(await outcomeOf(asFetch(500, {})), tag(), {}, 'Не удалось удалить тег')?.message, 'Не удалось удалить тег');
  same('принятая запись — не отказ', refusalOf(await outcomeOf(asFetch(200, { tag: {} })), tag(), {}, 'x'), null);

  console.log('2б. Массовый отказ «всё или ничего»');
  {
    const shown = new Map([['t1', tag()], ['t2', tag({ id: 't2', identifier: 'FAN-2' })]]);
    const r = bulkRefusalOf({ error: 'Часть записей изменили. Ничего не записано.', code: VERSION_CONFLICT,
      changed: [{ id: 't1', current: tag({ brand: 'Beta' }) }], gone: ['t2'] }, shown, {});
    same('перечень по записям: изменённая и удалённая', r.groups, [
      { title: 'AHU-1', changes: [{ label: 'Марка', was: 'Acme', now: 'Beta' }] },
      { title: 'FAN-2', changes: [{ label: 'Тег', was: 'есть', now: 'удалён' }] },
    ]);
    same('текст — тот, что прислал сервер', r.message, 'Часть записей изменили. Ничего не записано.');
    ok('тело без перечней не роняет разбор', bulkRefusalOf({}, shown, {}).groups?.length === 0);
  }

  console.log('3. Запись: версия, отказ, подмена после снимка');
  {
    const f = stubFetch({ status: 200, body: { tag: { id: 't1', updatedAt: '2026-01-02T00:00:00.000Z' } } });
    const { d, log } = deps();
    const saved = await saveTagMetadataPatch(tag(), meta({ x: 10, y: 20, mainName: 'Новое', connections: [], descriptions: [] }), d, { brand: 'Z' });
    f.restore();
    ok('принятая запись — true', saved === true);
    same('в теле — поля, только изменившиеся ключи и версия, которую читал экран', bodyOf(f.calls[0]), { brand: 'Z', metadata: { mainName: 'Новое' }, version: '2026-01-01T10:00:00.000Z' });
    same('отказов и тостов нет', [log.refusals.length, log.toasts.length], [0, 0]);
  }
  {
    const shown = tag({ brand: 'Acme' });
    const current = tag({ version: 4, brand: 'Beta', updatedAt: '2026-01-03T00:00:00.000Z' }, { mainName: 'Приточная установка', descriptions: [{ id: 'd1', text: 'Течь', status: 'critical', comment: '' }] });
    const f = stubFetch({ status: 409, body: { error: 'Тег «AHU-1» изменили, пока вы его правили.', code: VERSION_CONFLICT, current } });
    const { d, log } = deps();
    const saved = await saveTagMetadataPatch(shown, meta({ x: 10, y: 20, mainName: 'Моё имя', connections: [], descriptions: [] }), d);
    f.restore();
    ok('отказ — false', saved === false);
    ok('набранное осталось нужным: экран узнаёт об отказе по версии', lastWriteKeptInput() === true);
    same('перечень сравнивает с копией ДО подмены', log.refusals[0].r.changes, [{ label: 'Марка', was: 'Acme', now: 'Beta' }, { label: 'Замечание «Течь»', was: '—', now: 'критично' }]);
    ok('в окно уходит показанная копия, а не свежая', log.refusals[0].shown === shown);
    ok('список получил свежую копию', log.tags[0].brand === 'Beta');
    ok('карточка получила свежую копию', log.fresh.length === 1 && log.fresh[0].brand === 'Beta');
    same('теги перечитаны', log.reloads, 1);
    same('тоста вместо перечня нет', log.toasts, []);
  }
  {
    // Следующая запись после отказа идёт с версией из ответа, а не с протухшей
    const f = stubFetch({ status: 200, body: {} });
    const { d } = deps();
    await saveTagMetadataPatch(tag({ updatedAt: '2026-01-01T10:00:00.000Z' }), meta({ x: 1, y: 2, mainName: 'Ещё' }), d);
    f.restore();
    ok('версия уходит строкой updatedAt', typeof bodyOf(f.calls[0]).version === 'string');
  }
  {
    const f = stubFetch({ status: 409, body: { error: 'Такой код тега уже есть', duplicate: true } });
    const { d, log } = deps();
    const saved = await saveTagMetadataPatch(tag({ id: 't9' }), meta({ x: 10, y: 20, mainName: 'a' }), d, { identifier: 'AHU-2' });
    f.restore();
    ok('занятый код — тост с текстом сервера, без перечня и без подмены', !saved && log.toasts[0] === 'Такой код тега уже есть' && log.refusals.length === 0 && log.fresh.length === 0);
    ok('при занятом коде набранное можно сбросить', lastWriteKeptInput() === false);
  }
  {
    const f = stubFetch({ status: 404, body: { error: 'Тег уже удалили. Ваша правка не записана.', code: RECORD_GONE } });
    const { d, log } = deps();
    const saved = await saveProcurement(tag({ id: 't8' }), { stage: 'ordered' }, d);
    f.restore();
    ok('закупка: тег удалён — отказ gone, теги перечитаны', !saved && log.refusals[0].r.kind === 'gone' && log.reloads === 1 && f.calls[0].url === '/api/tags/t8/procurement');
  }
  {
    const f = stubFetch({ status: 500, body: {} });
    const { d, log } = deps();
    const saved = await saveTagMetadataPatch(tag({ id: 't7' }), meta({ mainName: 'z' }), d);
    f.restore();
    ok('сбой сервера — тост с запасным текстом, а не тишина', !saved && log.toasts[0] === 'Не удалось сохранить изменения');
  }
  {
    const f = stubFetch({ status: 0, throws: true });
    const { d, log } = deps();
    const saved = await saveTagMetadataPatch(tag({ id: 't6' }), meta({ mainName: 'z' }), d);
    f.restore();
    ok('сеть не ответила — тост «Сервер не ответил»', !saved && log.toasts[0] === 'Сервер не ответил');
  }
  {
    const f = stubFetch({ status: 409, body: { error: 'Тег изменили', code: VERSION_CONFLICT, current: tag({ brand: 'B' }) } });
    const { d, log } = deps();
    delete (d as any).onRefusal;
    await saveTagMetadataPatch(tag({ id: 't5' }), meta({ mainName: 'z' }), d);
    f.restore();
    same('без окна для отказа текст сервера всё равно доходит тостом', log.toasts, ['Тег изменили']);
  }

  console.log('3б. Удаление и массовая запись');
  {
    same('адрес удаления с целой версией', deleteUrl('t1', 5), '/api/tags/t1?expectedVersion=5');
    same('версия строкой читается', deleteUrl('t1', '7'), '/api/tags/t1?expectedVersion=7');
    same('нет версии — адрес прежний', [deleteUrl('t1', undefined), deleteUrl('t1', 0), deleteUrl('t1', 1.5)], ['/api/tags/t1', '/api/tags/t1', '/api/tags/t1']);
    const f = stubFetch({ status: 200, body: { success: true } });
    const o = await deleteTagRequest(tag({ version: 6 }));
    f.restore();
    same('DELETE: версия в строке запроса, тела нет', [f.calls[0].url, f.calls[0].init?.method, f.calls[0].init?.body], ['/api/tags/t1?expectedVersion=6', 'DELETE', undefined]);
    ok('ответ возвращается разобранным', o.kind === 'ok');
    const g = stubFetch({ status: 409, body: { error: 'открыт', code: RECORD_OPEN, holders: [{ userId: 'u', name: 'Пётр' }] } });
    const o2 = await deleteTagRequest(tag({ version: 6 }));
    g.restore();
    ok('отказ удаления не бросает и не теряется', o2.kind === 'open');
  }
  {
    const shown = new Map([['a', tag({ id: 'a' })], ['b', tag({ id: 'b', updatedAt: '2026-02-02T00:00:00.000Z' })]]);
    const f = stubFetch({ status: 200, body: { versions: [] } });
    await bulkMetadataRequest([{ id: 'a', metadata: { procurement: { stage: 's' } } }, { id: 'b', metadata: { procurement: {} } }], shown, { source: 'Закупки' });
    same('каждая запись несёт версию, что видел экран; source доезжает', bodyOf(f.calls[0]), {
      updates: [{ id: 'a', metadata: { procurement: { stage: 's' } }, version: '2026-01-01T10:00:00.000Z' }, { id: 'b', metadata: { procurement: {} }, version: '2026-02-02T00:00:00.000Z' }], source: 'Закупки' });
    const g = stubFetch({ status: 200, body: {} });
    await bulkMetadataRequest([{ id: 'a', metadata: { x: 1, y: 2 } }], new Map());
    f.restore(); g.restore();
    same('раскладка (без показанных тегов) версий не шлёт', bodyOf(g.calls[0]).updates, [{ id: 'a', metadata: { x: 1, y: 2 } }]);
  }

  {
    const shown = new Map([['a', tag({ id: 'a', identifier: 'A-1' })]]);
    const mk = () => { const l = { toasts: [] as string[], shown: [] as any[], reloads: 0 }; return { l, d: { setTags: () => {}, addToast: (m: string) => { l.toasts.push(m); }, showRefusal: (t: string, r: any) => { l.shown.push({ t, r }); }, names: {}, reload: () => { l.reloads++; } } }; };
    const f = stubFetch({ status: 409, body: { error: 'Часть записей изменили. Ничего не записано.', code: VERSION_CONFLICT, changed: [{ id: 'a', current: tag({ id: 'a', identifier: 'A-1', brand: 'Beta' }) }], gone: [] } });
    const c = mk();
    const done = await runBulkWrite([{ id: 'a', metadata: { procurement: {} } }], shown, { source: 'Закупки' }, c.d as any, 'сбой');
    f.restore();
    ok('массовый отказ: не записано, окно с перечнем по записям, данные перечитаны, тоста об успехе нет', !done && c.l.shown.length === 1 && c.l.shown[0].r.groups[0].title === 'A-1' && c.l.reloads === 1 && c.l.toasts.length === 0);
    const g = stubFetch({ status: 500, body: {} });
    const c2 = mk();
    const done2 = await runBulkWrite([{ id: 'a', metadata: {} }], shown, {}, c2.d as any, 'сбой');
    g.restore();
    ok('сбой сервера: тост с текстом, данные перечитаны', !done2 && c2.l.toasts[0] === 'сбой' && c2.l.reloads === 1 && c2.l.shown.length === 0);
    const h = stubFetch({ status: 200, body: { versions: [] } });
    const c3 = mk();
    ok('принятая запись — true, без отказов', await runBulkWrite([{ id: 'a', metadata: {} }], shown, {}, c3.d as any, 'x') && c3.l.reloads === 0);
    h.restore();
  }

  console.log('4. Исходники: запись тега только через общее место');
  const SRC = walk(path.join(root, 'src'));
  const raw: string[] = [];
  const bulkCalls: Array<{ file: string; line: number; second: string; name: string }> = [];
  let tagWriteCalls = 0;
  for (const file of SRC) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/fetch|bulkMetadataRequest|runBulkWrite|deleteTagRequest|saveTagMetadataPatch|saveProcurement|putTagLinks/.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const rel = path.relative(root, file);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(source);
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (callee === 'fetch' && node.arguments[0] && !rel.endsWith('registry/tagWrite.ts')) {
          const url = node.arguments[0].getText(source);
          const options = node.arguments[1]?.getText(source) || '';
          if (/\/api\/tags\b/.test(url) && /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/.test(options) && !/\/projects\/|\/generate|bulk-import/.test(url)) raw.push(`${rel}:${line} ${url.slice(0, 60)}`);
        }
        if (callee === 'bulkMetadataRequest' || callee === 'runBulkWrite') bulkCalls.push({ file: rel, line, second: node.arguments[1]?.getText(source) || '', name: callee });
        if (/^(deleteTagRequest|saveTagMetadataPatch|saveProcurement|putTagLinks)$/.test(callee)) tagWriteCalls++;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  same('запись тега мимо tagWrite.ts не идёт нигде в src/', raw, []);
  ok('экраны зовут общее место', tagWriteCalls >= 6);
  const procurementBulk = bulkCalls.filter((c) => c.file.endsWith('ProcurementManagement.tsx') && c.name === 'runBulkWrite');
  ok('«Закупки»: массовый этап и шаблон идут через runBulkWrite с картой показанных тегов', procurementBulk.length === 2 && procurementBulk.every((c) => c.second === 'shown'));
  ok('runBulkWrite шлёт версии сквозь bulkMetadataRequest', /bulkMetadataRequest\(updates, shown/.test(fs.readFileSync(path.join(root, 'src/components/registry/bulkWrite.ts'), 'utf8')));
  const registryBulk = bulkCalls.filter((c) => c.file.endsWith('Registry.tsx') && c.name === 'bulkMetadataRequest');
  ok('«Реестр»: раскладка идёт тем же общим местом, без версий', registryBulk.length === 1 && /new Map\(\)/.test(registryBulk[0].second));
  {
    const guard = fs.readFileSync(path.join(root, 'src/components/registry/tagWrite.ts'), 'utf8');
    ok('отказ узнаётся по коду, а не по тексту сервера', !/includes\(['"`]изменил|\.error\s*===|startsWith\(['"`]Тег/.test(guard));
  }

  console.log('5. Сам разбор не пустой');
  {
    const probe = ts.createSourceFile('p.ts', "fetch('/api/tags/x', { method: 'DELETE' }); bulkMetadataRequest(u, m);", ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const walkNode = (n: ts.Node) => { if (ts.isCallExpression(n)) found.push(n.expression.getText(probe)); ts.forEachChild(n, walkNode); };
    walkNode(probe);
    same('разбор видит вызовы', found, ['fetch', 'bulkMetadataRequest']);
  }

  console.log(`\nПройдено проверок: ${passed}`);
})().catch((e) => { console.error(e); process.exitCode = 1; });

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'generated') walk(full, out); }
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}
