/**
 * Экран «Справочник» шлёт версию пункта и узнаёт отказ по коду (проекты и справочники, B2).
 *
 * Без браузера и без службы. Четыре половины:
 *   1. Правила полей (src/components/dictionary/changeRules.ts): код, название, родитель — то,
 *      что человек видит; у категорий со служебным кодом — «Порядок» вместо кода.
 *   2. Разбор отказов (dictWrite.ts) с подставным fetch: узнаётся по `code`, а не по тексту;
 *      правка и удаление несут версию (удаление — в строке запроса), создание — нет; своя
 *      запись обгоняет устаревшую копию экрана; записи одного пункта идут по очереди.
 *   3. Итог для экрана (`settleWrite`): перечень сравнивает с пунктом ДО подмены свежим, свежий
 *      пункт подменяет старый, справочники перечитываются, показ отказа вызван, а принятая
 *      запись подменяет пункт ответом.
 *   4. Исходники настоящим TypeScript: PUT/DELETE/POST пунктов — только через dictWrite (прямых
 *      fetch к пунктам нет); каждая правка и удаление называют показанный пункт; набранное
 *      сбрасывается только после принятой записи; `saveTagTemplate` шлёт PUT с expectedVersion.
 *
 * Запуск: npx tsx scripts/test-dict-version-client.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { dictChanges, dictNamesOf, orderOf } from '../src/components/dictionary/changeRules';
import { putItem, deleteItem, createItem, refusalOf, needsReread, settleWrite, versionOf, withItem, findItem } from '../src/components/dictionary/dictWrite';
import { writeVersioned } from '../src/components/equipment/versionedWrite';
import { dataService } from '../src/services/dataService';
import { RECORD_GONE, RECORD_OPEN, VERSION_CONFLICT } from '../src/lib/refusalTexts';

const root = path.resolve(__dirname, '..');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const same = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); passed++; console.log(`  ✓ ${name}`); };

const item = (over: Record<string, unknown> = {}) => ({ id: 'i1', version: 3, dictionaryId: 'd1', code: 'KIP', nameRu: 'КИП', parentId: null, ...over });

/** Подставной fetch: помнит запросы, отвечает по очереди заданными статусом и телом. */
function stubFetch(...replies: Array<{ status: number; body?: unknown; throws?: boolean; delay?: number }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const real = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r.delay) await new Promise((res) => setTimeout(res, r.delay));
    if (r.throws) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const bodyOf = (c: { init?: RequestInit }) => JSON.parse(String(c.init?.body ?? '{}'));

/** Контекст экрана с записью того, что с ним сделали */
function screen(initial: any[]) {
  const log = { dictionaries: initial, refusals: [] as Array<{ refusal: any; mode: string; title: string }>, rereads: 0 };
  return {
    log,
    ctx: {
      dictionaries: initial,
      setDictionaries: (fn: any) => { log.dictionaries = typeof fn === 'function' ? fn(log.dictionaries) : fn; },
      fetchDictionaries: async () => { log.rereads++; },
      showRefusal: (refusal: any, mode: any, title: string) => { log.refusals.push({ refusal, mode, title }); },
      clearRefusal: () => {},
    },
  };
}

(async () => {
  console.log('1. Правила полей');
  {
    same('нет изменений — перечня нет (версия и служебное не шумят)', dictChanges(item(), item({ version: 4, dictionaryId: 'd2' })), []);
    same('код и название', dictChanges(item(), item({ code: 'KIPIA', nameRu: 'КИПиА' })),
      [{ label: 'Код', was: 'KIP', now: 'KIPIA' }, { label: 'Название', was: 'КИП', now: 'КИПиА' }]);
    same('родитель — именем, нет имени — идентификатором',
      [dictChanges(item({ parentId: 'a' }), item({ parentId: 'b' }), { parent: (id) => ({ a: 'Отдел', b: 'Среда' } as any)[id] }),
        dictChanges(item({ parentId: 'a' }), item({ parentId: null }))],
      [[{ label: 'Родитель', was: 'Отдел', now: 'Среда' }], [{ label: 'Родитель', was: 'a', now: '—' }]]);
    same('родитель из справочников: «код (название)»', dictChanges(item(), item({ parentId: 'p' }), dictNamesOf([{ items: [{ id: 'p', code: 'C1', nameRu: 'Категория' }] }])),
      [{ label: 'Родитель', was: '—', now: 'C1 (Категория)' }]);
    const cat = (code: string, nameRu = 'Класс') => item({ code, nameRu });
    same('служебный код скрыт: вместо него «Порядок»', dictChanges(cat('001_ab12'), cat('003_ab12'), { hideCode: true }), [{ label: 'Порядок', was: '1', now: '3' }]);
    same('служебный код скрыт: смена названия — только «Название»', dictChanges(cat('001_ab12'), cat('001_ab12', 'Класс надёжности'), { hideCode: true }), [{ label: 'Название', was: 'Класс', now: 'Класс надёжности' }]);
    same('порядок читается из кода и только из него', [orderOf('007_x'), orderOf('КИП'), orderOf(null)], ['7', '', '']);
    same('нет одной из записей — перечень пуст', [dictChanges(null, item()), dictChanges(item(), null)], [[], []]);
  }

  console.log('2. Отказ узнаётся по коду');
  {
    const msg = 'Пункт справочника «КИП» изменили, пока вы его правили.';
    const f = stubFetch({ status: 409, body: { error: msg, code: VERSION_CONFLICT, current: item({ version: 4, nameRu: 'КИПиА' }) } });
    const o = await putItem('c-1', item(), { nameRu: 'Моё' });
    f.restore();
    ok('409 с кодом — conflict, current доезжает', o.kind === 'conflict' && (o as any).current.nameRu === 'КИПиА');
    const r = refusalOf(o, item(), {}, 'запасной');
    same('текст — серверный, перечень «было → стало»', [r?.kind, r?.message, r?.changes], ['conflict', msg, [{ label: 'Название', was: 'КИП', now: 'КИПиА' }]]);
    ok('нужно перечитать', needsReread(o));
  }
  ok('409 без кода — не conflict (по тексту не узнаётся)', (await (async () => { const f = stubFetch({ status: 409, body: { error: 'Пункт справочника изменили, пока вы его правили' } }); const o = await putItem('c-2', item(), {}); f.restore(); return o.kind === 'refused'; })()));
  {
    const f = stubFetch({ status: 404, body: { error: 'Пункт справочника «КИП» уже удалили. Ваша правка не записана.', code: RECORD_GONE } });
    const o = await putItem('c-3', item(), {});
    f.restore();
    const r = refusalOf(o, item(), {}, 'x');
    ok('404 с кодом — gone с серверным текстом, перечитать', o.kind === 'gone' && r?.kind === 'gone' && /удалили/.test(r.message) && needsReread(o));
  }
  {
    const body = { error: 'Пункт справочника «Класс» сейчас открыт у сотрудника: Иванов И. И. Удалить его нельзя, пока запись открыта.', code: RECORD_OPEN, holders: [{ userId: 'u2', name: 'Иванов И. И.' }], record: { model: 'DictionaryItem', id: 'i1', name: 'Класс' } };
    const f = stubFetch({ status: 409, body });
    const o = await deleteItem('c-4', item());
    f.restore();
    const r = refusalOf(o, item(), {}, 'x');
    same('открыт у коллеги: текст сервера и кто держит', [o.kind, r?.kind, r?.message, r?.holders], ['open', 'open', body.error, [{ userId: 'u2', name: 'Иванов И. И.' }]]);
    ok('перечитывать при этом нечего', !needsReread(o));
  }
  {
    const f = stubFetch({ status: 200, body: { success: true, alreadyGone: true } });
    const o = await deleteItem('c-5', item());
    f.restore();
    const r = refusalOf(o, item(), {}, 'x');
    ok('повторное удаление (200 alreadyGone) — не тишина: «уже удалён» из словаря, перечитать', r?.kind === 'gone' && /уже удал/.test(r.message) && needsReread(o));
  }
  same('чужая ошибка — запасной текст', refusalOf({ kind: 'refused', status: 500, message: '', data: {} }, item(), {}, 'Ошибка сохранения')?.message, 'Ошибка сохранения');
  same('сервер не ответил — текст «Сервер не ответил», без исключения', await (async () => { const f = stubFetch({ status: 0, throws: true }); const o = await putItem('c-6', item(), {}); f.restore(); return [o.kind, refusalOf(o, item(), {}, 'x')?.kind]; })(), ['offline', 'plain']);
  same('принятая запись — не отказ', refusalOf({ kind: 'ok', data: { item: {} } }, item(), {}, 'x'), null);

  console.log('3. Запись: версия, очередь, свои записи');
  {
    const f = stubFetch({ status: 200, body: { item: item({ id: 'w-1', version: 4 }) } });
    await putItem('w-1', item({ id: 'w-1', version: 3 }), { code: 'A', nameRu: 'Б', parentId: null });
    f.restore();
    same('PUT: адрес, метод, поля и expectedVersion в теле', [f.calls[0].url, f.calls[0].init?.method, bodyOf(f.calls[0])],
      ['/api/dictionaries/items/w-1', 'PUT', { code: 'A', nameRu: 'Б', parentId: null, expectedVersion: 3 }]);
  }
  {
    const f = stubFetch({ status: 200, body: { success: true } });
    await deleteItem('w-2', item({ id: 'w-2', version: 6 }));
    f.restore();
    same('DELETE: версия в строке запроса, тела нет', [f.calls[0].url, f.calls[0].init?.method, f.calls[0].init?.body], ['/api/dictionaries/items/w-2?expectedVersion=6', 'DELETE', undefined]);
  }
  {
    const f = stubFetch({ status: 200, body: { item: {} } });
    await createItem('p-1', 'd-1', { code: 'X', nameRu: 'Икс', parentId: null });
    f.restore();
    same('POST: пункт в справочнике, версии нет', [f.calls[0].url, f.calls[0].init?.method, bodyOf(f.calls[0])], ['/api/projects/p-1/dictionaries/d-1/items', 'POST', { code: 'X', nameRu: 'Икс', parentId: null }]);
  }
  {
    const f = stubFetch({ status: 200, body: {} });
    await putItem('w-3', { id: 'w-3' }, { nameRu: 'Н' });
    await putItem('w-3', { id: 'w-3', version: 0 }, { nameRu: 'Н' });
    f.restore();
    same('нет версии у показанного (старый ответ) — запрос уходит без неё', f.calls.map((c) => 'expectedVersion' in bodyOf(c)), [false, false]);
  }
  {
    // Своя запись обгоняет устаревшую копию экрана: вторая правка идёт с версией из ответа на первую
    const f = stubFetch({ status: 200, body: { item: item({ id: 'w-4', version: 8 }) } }, { status: 200, body: { item: item({ id: 'w-4', version: 9 }) } });
    const shown = item({ id: 'w-4', version: 7 });
    await putItem('w-4', shown, { nameRu: 'Первая' });
    await putItem('w-4', shown, { nameRu: 'Вторая' });
    f.restore();
    same('вторая правка того же пункта — со свежей версией, не со старой копией', f.calls.map((c) => bodyOf(c).expectedVersion), [7, 8]);
    same('версия — большая из двух', [versionOf(item({ version: 12 }), 'w-4'), versionOf(item({ version: 2 }), 'w-4'), versionOf(undefined, 'w-4')], [12, 9, 9]);
  }
  {
    // Две записи подряд без ожидания: вторая ждёт первую и уходит со свежей версией
    const f = stubFetch({ status: 200, body: { item: item({ id: 'w-5', version: 3 }) }, delay: 60 }, { status: 200, body: { item: item({ id: 'w-5', version: 4 }) } });
    const shown = item({ id: 'w-5', version: 2 });
    const a = putItem('w-5', shown, { nameRu: 'А' });
    const b = putItem('w-5', shown, { nameRu: 'Б' });
    await Promise.all([a, b]);
    f.restore();
    same('записи одного пункта идут по очереди, вторая — с версией из ответа на первую', f.calls.map((c) => bodyOf(c).expectedVersion), [2, 3]);
  }
  {
    const f = stubFetch({ status: 409, body: { error: 'x', code: VERSION_CONFLICT, current: item({ id: 'w-6', version: 11 }) } }, { status: 200, body: { item: item({ id: 'w-6', version: 12 }) } });
    await putItem('w-6', item({ id: 'w-6', version: 5 }), { nameRu: 'А' });
    await putItem('w-6', item({ id: 'w-6', version: 5 }), { nameRu: 'А' });
    f.restore();
    same('после отказа повтор идёт с версией коллеги из `current`', f.calls.map((c) => bodyOf(c).expectedVersion), [5, 11]);
  }
  {
    const f = stubFetch({ status: 200, body: { item: item({ id: 'w-7', version: 5 }) } }, { status: 200, body: { success: true } }, { status: 200, body: {} });
    await putItem('w-7', item({ id: 'w-7', version: 4 }), {});
    await deleteItem('w-7', item({ id: 'w-7', version: 4 }));
    await putItem('w-7', item({ id: 'w-7', version: 2 }), {});
    f.restore();
    same('удаление идёт с версией из своей записи; после удаления версия забыта', [f.calls[1].url, f.calls[2].url === '/api/dictionaries/items/w-7' && bodyOf(f.calls[2]).expectedVersion], ['/api/dictionaries/items/w-7?expectedVersion=5', 2]);
  }
  {
    const r = await writeVersioned('/x', 'PUT', {}, 1, async () => { throw new TypeError('x'); });
    ok('writeVersioned не бросает: сеть приходит результатом', r.kind === 'offline');
  }

  console.log('4. Итог для экрана');
  {
    const d = { id: 'd1', name: 'Справочник', items: [item({ id: 'a' }), item({ id: 'b', nameRu: 'Другой' })] };
    const shown = d.items[0];
    const { ctx, log } = screen([d]);
    const current = item({ id: 'a', version: 4, nameRu: 'Правка коллеги' });
    const f = stubFetch({ status: 409, body: { error: 'изменили', code: VERSION_CONFLICT, current } });
    const o = await putItem('a', shown, { nameRu: 'Моё' });
    f.restore();
    const done = settleWrite(o, shown, ctx as any, { mode: 'edit', title: 'Правка не записана', fallback: 'x', names: {} });
    same('отказ: false (набранное экран не сбрасывает)', done, false);
    same('перечень сравнивает с пунктом ДО подмены свежим', log.refusals[0].refusal.changes, [{ label: 'Название', was: 'КИП', now: 'Правка коллеги' }]);
    same('режим и заголовок доезжают', [log.refusals[0].mode, log.refusals[0].title], ['edit', 'Правка не записана']);
    same('пункт подменён записью коллеги, версия обновилась; соседний цел', [findItem(log.dictionaries, 'a').nameRu, findItem(log.dictionaries, 'a').version, findItem(log.dictionaries, 'b').nameRu], ['Правка коллеги', 4, 'Другой']);
    same('справочники перечитаны', log.rereads, 1);
  }
  {
    const d = { id: 'd1', items: [item({ id: 'a' })] };
    const { ctx, log } = screen([d]);
    const f = stubFetch({ status: 200, body: { item: item({ id: 'a', version: 4, nameRu: 'Моё' }) } });
    const o = await putItem('a', d.items[0], { nameRu: 'Моё' });
    f.restore();
    ok('принятая запись: true, пункт подменён ответом (версия 4), отказа и перечитывания нет', settleWrite(o, d.items[0], ctx as any, { mode: 'edit', title: 't', fallback: 'x', names: {} })
      && findItem(log.dictionaries, 'a').version === 4 && log.refusals.length === 0 && log.rereads === 0);
  }
  {
    const d = { id: 'd1', items: [item({ id: 'a' })] };
    const { ctx, log } = screen([d]);
    const f = stubFetch({ status: 409, body: { error: 'открыт', code: RECORD_OPEN, holders: [{ userId: 'u', name: 'Пётр' }], record: { model: 'DictionaryItem', id: 'a', name: 'КИП' } } });
    const o = await deleteItem('a', d.items[0]);
    f.restore();
    const done = settleWrite(o, d.items[0], ctx as any, { mode: 'dialog', title: 'Не удалено', fallback: 'x', names: {} });
    ok('удаление открытого: false, окно, пункт на месте, перечитывать нечего', !done && log.refusals[0].mode === 'dialog' && log.refusals[0].refusal.kind === 'open' && log.rereads === 0 && !!findItem(log.dictionaries, 'a'));
  }
  {
    const d = { id: 'd1', items: [item({ id: 'a' })] };
    const { ctx, log } = screen([d]);
    const f = stubFetch({ status: 404, body: { error: 'Справочник, в который вы добавляете, уже удалили. Новая запись не создана.', code: RECORD_GONE } });
    const o = await createItem('p', 'd1', { code: 'Z', nameRu: 'Z' });
    f.restore();
    const done = settleWrite(o, null, ctx as any, { mode: 'dialog', title: 'Не добавлено', fallback: 'x', names: {} });
    ok('создание в исчезнувшем справочнике: текст сервера окном, справочники перечитаны', !done && /Новая запись не создана/.test(log.refusals[0].refusal.message) && log.rereads === 1);
  }
  {
    const { ctx, log } = screen([{ id: 'd1', items: [] }]);
    const f = stubFetch({ status: 500, body: {} });
    const o = await putItem('a', item(), {});
    f.restore();
    const done = settleWrite(o, item(), ctx as any, { mode: 'edit', title: 't', fallback: 'Ошибка сохранения', names: {}, rereadAlways: true });
    ok('сбой сервера: запасной текст, перечитать (на экране стоит неподтверждённое)', !done && log.refusals[0].refusal.kind === 'plain' && log.refusals[0].refusal.message === 'Ошибка сохранения' && log.rereads === 1);
  }
  same('withItem не трогает чужие справочники', (() => { const other = { id: 'd2', items: [item({ id: 'z' })] }; return withItem([{ id: 'd1', items: [item({ id: 'a' })] }, other], item({ id: 'a', nameRu: 'Н' }))[1] === other; })(), true);

  console.log('5. Шаблон тегов: saveTagTemplate шлёт PUT');
  {
    const f = stubFetch({ status: 200, body: { template: {} } }, { status: 200, body: { template: {} } });
    await dataService.saveTagTemplate('p1', '{"a":1}', 3);
    await dataService.saveTagTemplate('p1', '{}');
    f.restore();
    same('метод PUT, адрес шаблона, версия в теле', [f.calls[0].init?.method, f.calls[0].url.endsWith('/projects/p1/tag-template'), bodyOf(f.calls[0])], ['PUT', true, { schemaJson: '{"a":1}', expectedVersion: 3 }]);
    same('версии нет — тело без неё', bodyOf(f.calls[1]), { schemaJson: '{}' });
  }

  console.log('6. Исходники: запись пунктов только через dictWrite');
  {
    const files = [
      'src/screens/DictionaryEditor.tsx', 'src/components/dictionary/useTagDict.ts', 'src/components/dictionary/useMarkingDict.ts', 'src/components/dictionary/usePresets.ts',
      'src/components/dictionary/TagDictPanel.tsx', 'src/components/dictionary/MarkingDictPanel.tsx', 'src/components/dictionary/PresetsPanel.tsx',
    ];
    const hookFiles = files.filter((f) => /use(Tag|Marking)Dict\.ts$|usePresets\.ts$|DictionaryEditor\.tsx$/.test(f));
    const rawFetch: string[] = [];
    const callsOf = (name: RegExp, source: ts.SourceFile) => {
      const out: ts.CallExpression[] = [];
      const visit = (n: ts.Node) => { if (ts.isCallExpression(n) && name.test(n.expression.getText(source))) out.push(n); ts.forEachChild(n, visit); };
      visit(source);
      return out;
    };
    let versioned = 0;
    const unversioned: string[] = [];
    const eager: string[] = [];
    let settles = 0;
    for (const rel of files) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      for (const c of callsOf(/^fetch$/, source)) {
        const url = c.arguments[0]?.getText(source) || '';
        const options = c.arguments[1]?.getText(source) || '';
        if (/dictionaries\/items|\/dictionaries\/\$\{[^}]+\}\/items/.test(url)) rawFetch.push(`${rel}:${source.getLineAndCharacterOfPosition(c.getStart()).line + 1}`);
        else if (/\/items\b/.test(url) && /method/.test(options)) rawFetch.push(`${rel}:${source.getLineAndCharacterOfPosition(c.getStart()).line + 1}`);
      }
      if (!hookFiles.includes(rel)) continue;
      // Каждая правка и удаление называют показанный пункт (второй аргумент), а не подсовывают пустоту
      for (const c of callsOf(/^(putItem|deleteItem)$/, source)) {
        const shown = (c.expression.getText(source) === 'putItem' ? c.arguments[1] : c.arguments[1])?.getText(source);
        const line = `${rel}:${source.getLineAndCharacterOfPosition(c.getStart()).line + 1}`;
        if (!shown || /^(undefined|null)$/.test(shown)) unversioned.push(line); else versioned++;
      }
      // Набранное и открытые поля сбрасываются только ПОСЛЕ принятой записи: до `if (!settleWrite…) return`
      // в той же функции нет вызовов, которые закрывают строку правки или очищают поле ввода
      const visit = (n: ts.Node) => {
        if ((ts.isArrowFunction(n) || ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.body && ts.isBlock(n.body)) {
          const gates = n.body.statements.filter((st) => ts.isIfStatement(st) && /settleWrite\(/.test(st.expression.getText(source)));
          if (gates.length) {
            settles += gates.length;
            const firstGate = gates[0].getStart();
            for (const st of n.body.statements) {
              if (st.getStart() >= firstGate) break;
              const t = st.getText(source);
              if (/\bset(Editing\w*|New\w*|AddForm|EditForm|IsAdding)\(/.test(t) && !/^\s*if \(!\w+\.trim\(\)/.test(t)) eager.push(`${rel}:${source.getLineAndCharacterOfPosition(st.getStart()).line + 1}`);
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(source);
    }
    same('прямых fetch к пунктам справочников в экране и хуках нет', rawFetch, []);
    ok('каждая правка и удаление называют показанный пункт', unversioned.length === 0 && versioned >= 14);
    same('набранное не сбрасывается до принятой записи', eager, []);
    ok('итог записи разбирается везде (settleWrite)', settles >= 14);
    const dw = fs.readFileSync(path.join(root, 'src/components/dictionary/dictWrite.ts'), 'utf8');
    ok('отказ узнаётся по коду, а не по тексту сервера', !/includes\(['"`]изменил|\.error\s*===|startsWith\(['"`]Пункт/.test(dw));
    const hooksText = hookFiles.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
    ok('пункт, который правят, — открытая запись DictionaryItem (экран и три хука)', (hooksText.match(/useOpenRecords\(/g) || []).length === 4 && (hooksText.match(/model: 'DictionaryItem'/g) || []).length === 4);
  }

  console.log(`\nПройдено проверок: ${passed}`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
