import { invalidateModuleReads } from '../src/services/moduleReadCache';
import assert from 'node:assert/strict';
import { setAuthToken } from '../src/config/env';
import { equipmentData, readModuleResource } from '../src/services/moduleDataService';
import type { LaunchContext } from '../modules/contract';

let passed = 0;
let mainCompleted = false;
process.on('exit', () => {
  if (!mainCompleted) {
    console.error('ПРОВАЛ: проверка завершилась до окончания main');
    process.exitCode = 1;
  }
});
function check(name: string, value: unknown) { assert.ok(value, name); passed++; console.log(`✓ ${name}`); }
const context: LaunchContext = { projectId: 'p', entry: 'equipment', entityId: 'e' };
const item = { id: 'e', name: 'Вентилятор', itemCode: 'бл1', equipType: 'FAN', version: 2,
  specs: JSON.stringify({ groups: [{ title: 'Основные', params: [{ key: 'Расход', value: '1200', unit: 'м³/ч' }] }] }),
  overrides: JSON.stringify({ 'Основные||Расход': '2400' }),
  tags: [{ id: 't', identifier: 'T1', mainName: 'Тег', parentId: null, private: 'не выдавать' }], secret: 'не выдавать' };
const children = [{ id: 'child', name: 'Двигатель', itemCode: 'дв1', parentElementId: 'e' },
  { id: 'grandchild', name: 'Датчик', itemCode: 'дт1', parentElementId: 'child' }];
const originalFetch = globalThis.fetch;
const requests: string[] = [];
let denied = '';
async function main() {
  await setAuthToken('synthetic-test-token');
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    const route = String(url);
    requests.push(route);
    assert.equal(options?.method || 'GET', 'GET');
    assert.deepEqual(options?.headers, { Authorization: 'Bearer synthetic-test-token' });
    if (route === denied) return new Response('{}', { status: 403 });
    const bodies: Record<string, unknown> = {
      '/api/projects': { projects: [{ id: 'p', name: 'Проект', code: 'P', companySecret: true }] },
      '/api/projects/p/systems': { systems: [{ monoblocks: [{ components: [item, ...children] }] }] },
      '/api/projects/p/tags': { tags: item.tags },
      '/api/catalog': { families: [{ id: 'f', name: 'Семейство', code: 'F', classId: 'fan', draft: 'не выдавать' }] },
    };
    assert.ok(route in bodies, `неожиданный адрес ${route}`);
    return new Response(JSON.stringify(bodies[route]));
  }) as typeof fetch;
  const data = await readModuleResource(context, 'equipment');
  check('ручное значение имеет приоритет, единицы остаются исходными', data?.params[0].value === '2400' && data?.params[0].unit === 'м³/ч');
  check('состав содержит потомков, а не соседние позиции', data?.composition.map(row => row.id).join() === 'child,grandchild');
  check('в ответе нет исходных служебных полей и приватных данных', !JSON.stringify(data).includes('не выдавать') && !('specs' in data!) && !('overrides' in data!));
  check('нет циклического обхода состава', equipmentData(item, [...children, { ...item, parentElementId: 'grandchild' }]).composition.length === 2);
  const tagContext: LaunchContext = { projectId: 'p', entry: 'tag', entityId: 't' };
  check('тег разрешает только связанную позицию в текущем проекте', (await readModuleResource(tagContext, 'equipment'))?.id === 'e');
  check('тег читается по постоянному ID', (await readModuleResource(context, 'tag'))?.identifier === 'T1');
  check('чужой ID позиции не отдаётся', await readModuleResource(context, 'equipment', 'foreign') === null);
  check('спецификация проецирует строки Тегов', (await readModuleResource(context, 'specification')).rows[0].identifier === 'T1');
  check('каталог не выдаёт черновики и служебные поля', JSON.stringify(await readModuleResource(context, 'catalog', 'f')) === '{"families":[{"id":"f","name":"Семейство","code":"F","classId":"fan"}]}');
  invalidateModuleReads();
  const before = requests.length;
  await assert.rejects(() => readModuleResource({ ...context, projectId: 'private' }, 'equipment'));
  check('закрытый проект не даёт читать его оборудование', requests.length === before + 1 && requests.at(-1) === '/api/projects');
  denied = '/api/projects/p/systems';
  invalidateModuleReads();
  await assert.rejects(() => readModuleResource(context, 'equipment'));
  check('отказ сервера не заменяется подставными данными', requests.at(-1) === denied);
  const count = requests.length;
  await assert.rejects(() => readModuleResource({ ...context, projectId: null }, 'equipment'));
  check('без проекта запрос не уходит', requests.length === count);
  mainCompleted = true;
  console.log(`\n${passed} проверок пройдено`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { globalThis.fetch = originalFetch; });
