/**
 * Экран «Оборудование» шлёт версию записи и узнаёт отказ по коду (этап 0, 0.5, часть 1).
 *
 * Без браузера и без службы. Две половины:
 *   1. Общее место клиента (src/components/equipment/versionedWrite.ts) с подставным fetch:
 *      версия уходит в теле или в строке запроса (DELETE); 409 узнаётся по полю `code`,
 *      а не по тексту и не по одному статусу; `current` доезжает до экрана; сеть и разбор
 *      тела не бросают.
 *   2. Разбор исходников настоящим TypeScript: каждое действие над позицией, блоком и
 *      установкой идёт через writeVersioned с версией четвёртым аргументом; прямого
 *      fetch записи по этим маршрутам нет нигде в src/. Без этого набор первой половины
 *      был бы зелёным и при экране, который версию забыл послать.
 *
 * Запуск: npx tsx scripts/test-equipment-version-client.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  RECORD_GONE, RECORD_OPEN, VERSION_CONFLICT, conflictOf, goneOf, openOf, failureText, versionIn, versionToSend, withVersion, withVersionQuery, writeVersioned,
} from '../src/components/equipment/versionedWrite';

const root = path.resolve(__dirname, '..');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const same = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); passed++; console.log(`  ✓ ${name}`); };

/** Подставной fetch: помнит запросы, отвечает заданным статусом и телом. */
function fakeFetch(status: number, body: unknown, opts: { raw?: string; throws?: boolean } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (opts.throws) throw new TypeError('fetch failed');
    return new Response(opts.raw ?? JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetcher };
}
const bodyOf = (c: { init?: RequestInit }) => JSON.parse(String(c.init?.body ?? '{}'));

(async () => {
  console.log('1. Какая версия уходит');
  same('целое число уходит как есть', [versionToSend(1), versionToSend(7)], [1, 7]);
  same('строка с целым читается', versionToSend('4'), 4);
  same('нет версии — ничего не уходит', [versionToSend(undefined), versionToSend(null), versionToSend(''), versionToSend('  ')], [undefined, undefined, undefined, undefined]);
  same('ноль, отрицательное, дробное, не число — не версия', [versionToSend(0), versionToSend(-2), versionToSend(1.5), versionToSend(NaN), versionToSend('abc')], [undefined, undefined, undefined, undefined, undefined]);
  same('тело с версией', withVersion({ group: 'A', key: 'K' }, 3), { group: 'A', key: 'K', expectedVersion: 3 });
  same('тело без версии не получает поля', withVersion({ group: 'A' }, undefined), { group: 'A' });
  same('версия в строке запроса', withVersionQuery('/api/systems/s1', 5), '/api/systems/s1?expectedVersion=5');
  same('версия дописывается к уже заданной строке запроса', withVersionQuery('/api/x?a=1', 5), '/api/x?a=1&expectedVersion=5');
  same('без версии адрес прежний', withVersionQuery('/api/systems/s1', undefined), '/api/systems/s1');

  console.log('2. Запись несёт версию, которую видел экран');
  {
    const f = fakeFetch(200, { ok: true });
    const r = await writeVersioned('/api/equipment/component/c1/override', 'POST', { group: 'G', key: 'K', value: '5' }, 4, f.fetcher);
    same('POST: версия в теле рядом с тем, что правил человек', bodyOf(f.calls[0]), { group: 'G', key: 'K', value: '5', expectedVersion: 4 });
    same('POST: метод и заголовок', [f.calls[0].init?.method, (f.calls[0].init?.headers as any)?.['Content-Type']], ['POST', 'application/json']);
    ok('принятая запись — ok с телом ответа', r.kind === 'ok' && (r.data as any).ok === true);
  }
  {
    const f = fakeFetch(200, { success: true });
    await writeVersioned('/api/equipment/component/c1', 'DELETE', undefined, 9, f.fetcher);
    same('DELETE: версия в строке запроса', f.calls[0].url, '/api/equipment/component/c1?expectedVersion=9');
    ok('DELETE: тела нет', f.calls[0].init?.body === undefined && f.calls[0].init?.method === 'DELETE');
  }
  {
    const f = fakeFetch(200, {});
    await writeVersioned('/api/equipment/component/c1/class', 'PUT', { equipClass: 'ФИЛЬТР', equipKind: '' }, undefined, f.fetcher);
    ok('нет версии — поле не уходит (старый ответ без колонки не ломает запись)', !('expectedVersion' in bodyOf(f.calls[0])));
  }

  console.log('3. Отказ по версии узнаётся по коду');
  {
    const current = { id: 'c1', version: 6, equipClass: 'ВЕНТИЛЯТОР' };
    const f = fakeFetch(409, { error: 'Позицию изменили, пока вы её правили', code: VERSION_CONFLICT, current });
    const r = await writeVersioned('/api/equipment/component/c1/class', 'PUT', {}, 5, f.fetcher);
    ok('409 с кодом — conflict', r.kind === 'conflict');
    if (r.kind === 'conflict') {
      same('текст — тот, что прислал сервер', r.message, 'Позицию изменили, пока вы её правили');
      same('текущая запись доезжает до экрана', r.current, current);
    }
    same('текст отказа для человека', failureText(r, 'запасной'), 'Позицию изменили, пока вы её правили');
  }
  {
    // Текст про «изменили» без кода — не отказ по версии: у 409 в этих маршрутах есть и другие причины
    const f = fakeFetch(409, { error: 'Запись изменили, пока вы её правили' });
    const r = await writeVersioned('/api/components/c1/tags/t1', 'POST', {}, 2, f.fetcher);
    ok('409 без кода, даже со словами про изменение, — не conflict (по тексту не узнаётся)', r.kind === 'refused');
  }
  {
    const f = fakeFetch(409, { error: 'Тег «П1» уже привязан к «Клапан». Один тег — одно изделие.' });
    const r = await writeVersioned('/api/components/c1/tags/t1', 'POST', {}, 2, f.fetcher);
    ok('занятый тег — отказ с его текстом, перечитывать нечего', r.kind === 'refused' && r.status === 409 && failureText(r, 'x').startsWith('Тег «П1»'));
  }
  {
    const f = fakeFetch(500, { error: 'VERSION_CONFLICT' });
    const r = await writeVersioned('/api/systems/s1', 'DELETE', undefined, 2, f.fetcher);
    ok('чужой статус с похожим текстом — не conflict', r.kind === 'refused');
  }
  {
    const f = fakeFetch(500, { error: 'Сбой', code: VERSION_CONFLICT });
    const r = await writeVersioned('/api/systems/s1', 'DELETE', undefined, 2, f.fetcher);
    ok('код при чужом статусе (не 409) — не conflict: версию сверяет только 409', r.kind === 'refused');
  }
  {
    const f = fakeFetch(409, { code: VERSION_CONFLICT });
    const r = await writeVersioned('/api/systems/s1', 'DELETE', undefined, 2, f.fetcher);
    ok('код есть, текста нет — conflict с запасным текстом', r.kind === 'conflict' && r.message.length > 0 && r.current === null);
  }
  same('conflictOf: не объект и пустое тело', [conflictOf(409, null), conflictOf(409, 'x'), conflictOf(409, {})], [null, null, null]);

  console.log('3б. Запись удалена и запись открыта у коллеги — тоже по коду');
  {
    const f = fakeFetch(404, { error: 'Позицию «Клапан Б» уже удалили. Ваша правка не записана.', code: RECORD_GONE });
    const r = await writeVersioned('/api/equipment/component/c1/class', 'PUT', {}, 5, f.fetcher);
    ok('404 с кодом — gone с текстом сервера', r.kind === 'gone' && r.message === 'Позицию «Клапан Б» уже удалили. Ваша правка не записана.');
    same('текст для человека', failureText(r, 'запасной'), 'Позицию «Клапан Б» уже удалили. Ваша правка не записана.');
  }
  {
    const f = fakeFetch(404, { error: 'Не найдено' });
    const r = await writeVersioned('/api/equipment/component/c1/class', 'PUT', {}, 5, f.fetcher);
    ok('404 без кода — не gone (по тексту и статусу не узнаётся)', r.kind === 'refused' && r.status === 404);
  }
  {
    const f = fakeFetch(409, { error: 'Запись удалили', code: RECORD_GONE });
    const r = await writeVersioned('/api/equipment/component/c1/class', 'PUT', {}, 5, f.fetcher);
    ok('код gone при чужом статусе (409) — не gone', r.kind === 'refused');
  }
  {
    const body = {
      error: 'Позиция «Клапан Б» сейчас открыта у сотрудника: Иванов И. И. Удалить её нельзя, пока запись открыта.', code: RECORD_OPEN,
      holders: [{ userId: 'u2', name: 'Иванов И. И.' }], record: { model: 'ComponentElement', id: 'c1', name: 'Клапан Б' },
    };
    const f = fakeFetch(409, body);
    const r = await writeVersioned('/api/equipment/component/c1', 'DELETE', undefined, 3, f.fetcher);
    ok('409 с кодом открытой записи — open', r.kind === 'open');
    if (r.kind === 'open') {
      same('кто держит', r.holders, [{ userId: 'u2', name: 'Иванов И. И.' }]);
      same('какая запись', r.record, { model: 'ComponentElement', id: 'c1', name: 'Клапан Б' });
      same('текст — тот, что прислал сервер', r.message, body.error);
    }
    same('текст для человека', failureText(r, 'x'), body.error);
  }
  {
    const f = fakeFetch(409, { code: RECORD_OPEN });
    const r = await writeVersioned('/api/systems/s1', 'DELETE', undefined, 3, f.fetcher);
    ok('open без перечня и текста — запасной текст, пустые holders и record', r.kind === 'open' && r.message.length > 0 && r.holders.length === 0 && r.record === null);
  }
  {
    const f = fakeFetch(409, { error: 'Запись открыта', holders: [{ userId: 'u2', name: 'Иванов' }] });
    const r = await writeVersioned('/api/systems/s1', 'DELETE', undefined, 3, f.fetcher);
    ok('409 с holders, но без кода — не open', r.kind === 'refused');
  }
  same('goneOf / openOf: мусор не разбирается', [goneOf(404, null), goneOf(404, 'x'), openOf(409, null), openOf(409, {}), openOf(500, { code: RECORD_OPEN })], [null, null, null, null, null]);
  {
    const f = fakeFetch(409, { error: 'Позицию изменили', code: VERSION_CONFLICT, current: { id: 'c1' } });
    const r = await writeVersioned('/api/equipment/component/c1/class', 'PUT', {}, 5, f.fetcher);
    ok('conflict несёт и тело отказа целиком', r.kind === 'conflict' && (r.data as any).code === VERSION_CONFLICT);
  }

  console.log('4. Сбои, которые не должны ронять экран');
  {
    const f = fakeFetch(0, null, { throws: true });
    const r = await writeVersioned('/api/equipment/component/c1/tag', 'POST', { identifier: 'П1' }, 1, f.fetcher);
    ok('сеть не ответила — offline, а не исключение', r.kind === 'offline' && failureText(r, 'x') === 'Сервер не ответил');
  }
  {
    const f = fakeFetch(502, null, { raw: '<html>Bad gateway</html>' });
    const r = await writeVersioned('/api/equipment/component/c1/tag', 'POST', {}, 1, f.fetcher);
    ok('тело не JSON — отказ с запасным текстом', r.kind === 'refused' && failureText(r, 'Не удалось завести тег') === 'Не удалось завести тег');
  }
  same('принятая запись — пустой текст отказа', failureText({ kind: 'ok', data: {} }, 'x'), '');

  console.log('5. Версия записи в дереве, как её показывает экран');
  {
    const tree = [
      { id: 's1', version: 3, monoblocks: [{ id: 'm1', version: 2, components: [{ id: 'c1', version: 7 }, { id: 'c2', version: 1 }] }] },
      { id: 's2', version: 4, monoblocks: [{ id: 'm2', version: 5, components: [{ id: 'c3', version: 9 }] }] },
    ];
    same('установка', versionIn(tree, 'system', 's2'), 4);
    same('блок', versionIn(tree, 'monoblock', 'm1'), 2);
    same('позиция в другой установке', versionIn(tree, 'component', 'c3'), 9);
    same('нет записи — нет версии', [versionIn(tree, 'component', 'нет'), versionIn(tree, 'system', undefined), versionIn([], 'component', 'c1')], [undefined, undefined, undefined]);
    ok('id позиции не путается с id установки', versionIn(tree, 'system', 'c1') === undefined && versionIn(tree, 'component', 's1') === undefined);
  }

  console.log('6. Исходники: каждое действие идёт с версией, прямой записи мимо общего места нет');
  const SRC = walk(path.join(root, 'src'));
  // [метод, часть адреса]: ровно те маршруты, где сервер сверяет версию
  const ROUTES: Array<{ name: string; method: string; url: RegExp }> = [
    { name: 'тип позиции', method: 'PUT', url: /equipment\/component\/[^\s]*\/class/ },
    { name: 'тег позиции', method: 'POST', url: /equipment\/component\/[^\s]*\/tag(?!s)/ },
    { name: 'удаление позиции', method: 'DELETE', url: /equipment\/component\/\$\{[^}]+\}`\)?$/ },
    { name: 'новая позиция', method: 'POST', url: /\/position/ },
    { name: 'принять или вписать значение', method: 'POST', url: /equipment\/component\/[^\s]*\/resolve/ },
    { name: 'правка значения', method: 'POST', url: /equipment\/component\/[^\s]*\/override/ },
    { name: 'привязать тег', method: 'POST', url: /components\/[^\s]*\/tags\// },
    { name: 'отвязать тег', method: 'DELETE', url: /components\/[^\s]*\/tags\// },
    { name: 'удаление установки', method: 'DELETE', url: /\/systems\/\$\{[^}]+\}`\)?$/ },
  ];
  // Маршруты, которых экран не зовёт, но которые тоже сверяют версию: появится вызов — он обязан идти тем же путём
  const GUARDED_ANY = /\/(accept-field|manual-edit-field|resolve-conflict)\b|equipment\/(component|monoblock)\/[^\s]*\/position|equipment\/component\/[^\s]*\/(class|tag|resolve|override)\b|\/systems\/\$\{|components\/\$\{[^}]+\}\/tags\//;

  const seen = new Map<string, number>();
  const rawWrites: string[] = [];
  const noVersion: string[] = [];
  for (const file of SRC) {
    if (file.endsWith('src/components/equipment/versionedWrite.ts')) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!/fetch|writeVersioned/.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const rel = path.relative(root, file);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(source);
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (callee === 'fetch' && node.arguments[0]) {
          const url = node.arguments[0].getText(source);
          const options = node.arguments[1]?.getText(source) || '';
          const writes = /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/.test(options);
          if (writes && GUARDED_ANY.test(url)) rawWrites.push(`${rel}:${line} ${url.slice(0, 70)}`);
        }
        if (callee === 'writeVersioned') {
          const url = node.arguments[0]?.getText(source) || '';
          const method = (node.arguments[1]?.getText(source) || '').replace(/['"]/g, '');
          const version = node.arguments[3];
          if (!version || /^(undefined|null)$/.test(version.getText(source))) noVersion.push(`${rel}:${line} ${method} ${url.slice(0, 60)}`);
          for (const route of ROUTES) if (route.method === method && route.url.test(url)) seen.set(route.name, (seen.get(route.name) || 0) + 1);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  same('мимо общего места по этим маршрутам не пишет никто', rawWrites, []);
  same('у каждого вызова записи есть версия четвёртым аргументом', noVersion, []);
  for (const route of ROUTES) ok(`экран отправляет версию: ${route.name}`, (seen.get(route.name) || 0) >= 1);

  console.log('7. Сам разбор не пустой');
  {
    const probe = ts.createSourceFile('p.ts', "fetch(`/api/equipment/component/${c.id}/override`, { method: 'POST' }); writeVersioned(url, 'POST', {});", ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const walkNode = (n: ts.Node) => { if (ts.isCallExpression(n)) found.push(n.expression.getText(probe)); ts.forEachChild(n, walkNode); };
    walkNode(probe);
    same('разбор видит вызовы', found, ['fetch', 'writeVersioned']);
    ok('адрес записи без версии распознаётся как охраняемый', GUARDED_ANY.test('`/api/equipment/component/${c.id}/override`'));
    ok('чтение (history) охраняемым не считается', !GUARDED_ANY.test('api(`/components/${comp.id}/history`)'));
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
