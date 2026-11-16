/**
 * Экран «Проекты» шлёт версию записи и разбирает отказ по коду (строка 3: проекты и справочники, часть B1).
 *
 * Без браузера и без службы. Четыре половины:
 *   1. Правила «что изменилось» (src/components/projects/changeRules.ts): только поля карточки, подписи как
 *      над полями, состояние словами; номер версии, даты и служебное в перечень не попадают.
 *   2. Разбор отказа (projectWrite.ts): 409 с кодом — conflict с `current`, 404 с кодом — gone, 409 с кодом
 *      открытой записи — open с `holders`; по тексту и одному статусу отказ не узнаётся; сбой не бросает.
 *   3. Запрос `dataService` с подставным fetch: `updateProject` кладёт `expectedVersion` в тело, `deleteProject` —
 *      в строку запроса; отказ сервера доходит до экрана с кодом, `current` и `holders` (прежний `request`
 *      подменял его данными автономной базы и терял всё это).
 *   4. Исходники экрана, настоящим TypeScript: правка и удаление идут с версией показанной записи; после отказа
 *      по версии список перечитывается без сброса набранного; открытая запись `Project` отмечается.
 *
 * Запуск: npx tsx scripts/test-project-version-client.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { PROJECT_RULES, projectChanges, statusTitle } from '../src/components/projects/changeRules';
import { resultOfRefusal, runWrite, projectRefusalOf, needsReread } from '../src/components/projects/projectWrite';
import { VERSION_CONFLICT, RECORD_GONE, RECORD_OPEN } from '../src/components/equipment/versionedWrite';

const root = path.resolve(__dirname, '..');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const same = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); passed++; console.log(`  ✓ ${name}`); };

const project = (over: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'Школа №5', code: 'SCH-5', customer: 'Управление образования', contractor: 'СтройМонтаж',
  description: 'Новая школа', info: 'Адрес площадки', status: 'ACTIVE', createdAt: '2026-01-01T00:00:00.000Z', version: 3, ...over,
});

(async () => {
  console.log('1. Что изменилось: поля карточки');
  {
    const shown = project();
    same('ничего не менялось — перечня нет', projectChanges(shown, project()), []);
    same('название и заказчик: «было → стало», в порядке карточки', projectChanges(shown, project({ name: 'Школа №7', customer: 'Мэрия' })), [
      { label: 'Наименование', was: 'Школа №5', now: 'Школа №7' },
      { label: 'Заказчик', was: 'Управление образования', now: 'Мэрия' },
    ]);
    same('подписи — как над полями карточки', PROJECT_RULES.map((r) => r.label), ['Наименование', 'Код проекта', 'Заказчик', 'Подрядчик', 'Краткое описание', 'Подробное описание', 'Статус проекта']);
    same('состояние — словами из списка карточки', projectChanges(shown, project({ status: 'ARCHIVED' })), [{ label: 'Статус проекта', was: 'В работе', now: 'Архив' }]);
    same('очищенное поле — прочерк', projectChanges(shown, project({ code: '' })), [{ label: 'Код проекта', was: 'SCH-5', now: '—' }]);
    same('номер версии, даты и служебное не шумят', projectChanges(shown, project({ version: 9, createdAt: '2027-01-01', updatedAt: 'x', system: true })), []);
    same('нет одной из записей — перечень пуст', [projectChanges(null, project()), projectChanges(shown, null)], [[], []]);
    same('состояние: незнакомое — как есть, пустое — пусто', [statusTitle('ACTIVE'), statusTitle('ARCHIVED'), statusTitle('PLANNING'), statusTitle(undefined)], ['В работе', 'Архив', 'PLANNING', '']);
  }

  console.log('2. Отказ узнаётся по коду');
  {
    const current = project({ name: 'Школа №7', version: 4 });
    const r = resultOfRefusal(409, { error: 'Проект «Школа №7» изменили, пока вы его правили.', code: VERSION_CONFLICT, current }, 'x');
    ok('409 с кодом — conflict', r.kind === 'conflict');
    if (r.kind === 'conflict') {
      same('текст — тот, что прислал сервер', r.message, 'Проект «Школа №7» изменили, пока вы его правили.');
      same('текущая запись доезжает до экрана', r.current, current);
    }
    const shownRefusal = projectRefusalOf(r, project(), 'x');
    same('отказ по версии — с перечнем «было → стало»', [shownRefusal?.kind, shownRefusal?.changes], ['conflict', [{ label: 'Наименование', was: 'Школа №5', now: 'Школа №7' }]]);
    ok('после отказа по версии список перечитывается', needsReread(r));
  }
  {
    const r = resultOfRefusal(409, { error: 'Проект изменили, пока вы его правили' }, 'x');
    ok('409 без кода, даже со словами про изменение, — не conflict', r.kind === 'refused');
    const r2 = resultOfRefusal(500, { error: 'Сбой', code: VERSION_CONFLICT }, 'x');
    ok('код при чужом статусе — не conflict', r2.kind === 'refused');
  }
  {
    const r = resultOfRefusal(404, { error: 'Проект «Школа №5» уже удалили. Ваша правка не записана.', code: RECORD_GONE }, 'x');
    ok('404 с кодом — gone с текстом сервера', r.kind === 'gone' && r.message.startsWith('Проект «Школа №5» уже удалили'));
    ok('удалённый проект: список перечитывается', needsReread(r));
    same('отказ gone — без перечня', [projectRefusalOf(r, project(), 'x')?.kind, projectRefusalOf(r, project(), 'x')?.changes], ['gone', undefined]);
    ok('404 без кода — не gone', resultOfRefusal(404, { error: 'Не найдено' }, 'x').kind === 'refused');
  }
  {
    const body = {
      error: 'Проект «Школа №5» сейчас открыт у сотрудника: Иванов И. И. Удалить его нельзя, пока запись открыта.', code: RECORD_OPEN,
      holders: [{ userId: 'u2', name: 'Иванов И. И.' }], record: { model: 'Project', id: 'p1', name: 'Школа №5' },
    };
    const r = resultOfRefusal(409, body, 'x');
    ok('409 с кодом открытой записи — open', r.kind === 'open');
    if (r.kind === 'open') {
      same('кто держит', r.holders, [{ userId: 'u2', name: 'Иванов И. И.' }]);
      same('какая запись', r.record, { model: 'Project', id: 'p1', name: 'Школа №5' });
    }
    ok('открытая запись — перечитывать нечего', !needsReread(r));
    same('открытая запись — текст сервера без перечня', [projectRefusalOf(r, project(), 'x')?.message, projectRefusalOf(r, project(), 'x')?.changes], [body.error, undefined]);
    ok('409 с holders, но без кода — не open', resultOfRefusal(409, { error: 'Занято', holders: [{ userId: 'u2', name: 'Иванов' }] }, 'x').kind === 'refused');
  }
  {
    const r = resultOfRefusal(403, { error: 'Нет права' }, 'запасной');
    same('прочий отказ — строка текста, перечитывать нечего', [projectRefusalOf(r, project(), 'запасной')?.kind, projectRefusalOf(r, project(), 'запасной')?.message, needsReread(r)], ['plain', 'Нет права', false]);
    same('отказ без текста — запасной текст', projectRefusalOf(resultOfRefusal(502, {}, 'Ошибка сохранения проекта'), project(), 'x')?.message, 'Ошибка сохранения проекта');
    same('принятая запись — не отказ', projectRefusalOf({ kind: 'ok', data: {} }, project(), 'x'), null);
  }
  {
    const refusalError = Object.assign(new Error('x'), { name: 'WriteRefusal', status: 409, body: { error: 'Изменили', code: VERSION_CONFLICT, current: project({ version: 5 }) } });
    const r = await runWrite(async () => { throw refusalError; }, 'x');
    ok('runWrite: отказ сервера приходит результатом, а не исключением', r.kind === 'conflict');
    const net = await runWrite(async () => { throw new Error('Сбой сети'); }, 'запасной');
    ok('runWrite: прочий сбой — отказ с его текстом', net.kind === 'refused' && net.message === 'Сбой сети');
    const done = await runWrite(async () => ({ id: 'p1' }), 'x');
    ok('runWrite: принятая запись несёт ответ', done.kind === 'ok' && (done.data as any).id === 'p1');
  }

  console.log('3. Запрос dataService с подставным fetch');
  {
    // Хранилище браузера и окно подставляются до загрузки службы: она читает их при импорте
    (globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let reply: { status: number; body: unknown } = { status: 200, body: {} };
    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
    };
    const { dataService, WriteRefusal } = await import('../src/services/dataService');
    const bodyOf = (c: { init?: RequestInit }) => JSON.parse(String(c.init?.body ?? '{}'));

    reply = { status: 200, body: { project: project({ version: 4 }) } };
    const updated = await dataService.updateProject('p1', { name: 'Школа №7' }, 'u1', 3);
    same('правка: версия в теле рядом с тем, что правил человек', [calls[0].init?.method, bodyOf(calls[0]).name, bodyOf(calls[0]).expectedVersion], ['PUT', 'Школа №7', 3]);
    ok('правка возвращает проект с новой версией', updated.version === 4);
    await dataService.updateProject('p1', { name: 'Школа №7' }, 'u1');
    ok('нет версии — поле не уходит', !('expectedVersion' in bodyOf(calls[1])));
    await dataService.updateProject('p1', { name: 'Школа №7' }, 'u1', 0);
    ok('ноль — не версия', !('expectedVersion' in bodyOf(calls[2])));

    reply = { status: 200, body: { success: true } };
    await dataService.deleteProject('p1', 'u1', 5);
    same('удаление: версия в строке запроса', [calls[3].init?.method, calls[3].url.endsWith('/projects/p1?expectedVersion=5')], ['DELETE', true]);
    await dataService.deleteProject('p1', 'u1');
    ok('удаление без версии: адрес прежний', calls[4].url.endsWith('/projects/p1'));

    const current = project({ name: 'Школа №7', version: 4 });
    reply = { status: 409, body: { error: 'Проект изменили', code: VERSION_CONFLICT, current } };
    let caught: any;
    try { await dataService.updateProject('p1', { name: 'А' }, 'u1', 3); } catch (e) { caught = e; }
    ok('отказ по версии доходит до экрана как WriteRefusal', caught instanceof WriteRefusal && caught.status === 409);
    same('отказ не теряет код и текущую запись', [caught?.body?.code, caught?.body?.current], [VERSION_CONFLICT, current]);
    same('и через разбор экрана это conflict с перечнем', (await runWrite(() => dataService.updateProject('p1', { name: 'А' }, 'u1', 3), 'x')).kind, 'conflict');

    const holders = [{ userId: 'u2', name: 'Иванов И. И.' }];
    reply = { status: 409, body: { error: 'Проект открыт у сотрудника: Иванов И. И.', code: RECORD_OPEN, holders, record: { model: 'Project', id: 'p1', name: 'Школа №5' } } };
    const open = await runWrite(() => dataService.deleteProject('p1', 'u1', 3), 'x');
    ok('удаление: открытая запись доходит с holders', open.kind === 'open' && JSON.stringify(open.holders) === JSON.stringify(holders));
    reply = { status: 404, body: { error: 'Проект уже удалили', code: RECORD_GONE } };
    ok('удаление: удалённый проект — gone', (await runWrite(() => dataService.deleteProject('p1', 'u1', 3), 'x')).kind === 'gone');
  }

  console.log('4. Исходники экрана');
  {
    const file = path.join(root, 'src/screens/ProjectsManagement.tsx');
    const text = fs.readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const calls: Array<{ callee: string; args: string[] }> = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) calls.push({ callee: node.expression.getText(source), args: node.arguments.map((a) => a.getText(source)) });
      ts.forEachChild(node, visit);
    };
    visit(source);
    const dataCalls = (name: string) => calls.filter((c) => c.callee === `dataService.${name}`);
    const update = dataCalls('updateProject');
    ok('правка проекта вызывается', update.length === 1);
    ok('правка идёт с версией показанного проекта четвёртым аргументом', update.every((c) => c.args.length === 4 && /\.version$/.test(c.args[3])));
    const del = dataCalls('deleteProject');
    ok('удаление проекта вызывается', del.length === 1);
    ok('удаление идёт с версией показанного проекта третьим аргументом', del.every((c) => c.args.length === 3 && /\.version$/.test(c.args[2])));
    ok('запись идёт через общий разбор отказа (runWrite)', calls.filter((c) => c.callee === 'runWrite').length === 2);
    ok('после отказа по версии список перечитывается, не сбрасывая набранное', calls.some((c) => c.callee === 'loadProjects' && c.args[0] === 'undefined' && /conflict/.test(c.args[1] || '')));
    ok('открытая запись: карточка отмечается через useProjectOpenRecords', calls.some((c) => c.callee === 'useProjectOpenRecords'));
    ok('отказ показан на месте ошибки формы (RefusalView)', /<RefusalView\b/.test(text));
    ok('отказ удаления — окном', /refusals\.show\('Проект не удалён'/.test(text));
    const hook = fs.readFileSync(path.join(root, 'src/components/projects/useProjectOpenRecords.ts'), 'utf8');
    ok('отметка — модель Project (имя из схемы базы)', /PROJECT_MODEL = 'Project'/.test(hook) && /useOpenRecords\(/.test(hook));
    const svc = fs.readFileSync(path.join(root, 'src/services/dataService.ts'), 'utf8');
    ok('в dataService проекты пишутся не через request (он теряет код отказа)', !/request<[^>]*>\(`\/projects\/\$\{id\}`,\s*\{\s*method: '(PUT|DELETE)'/.test(svc));
  }

  console.log(`\nПройдено проверок: ${passed}`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
