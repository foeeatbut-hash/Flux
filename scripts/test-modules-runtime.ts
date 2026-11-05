import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { readFormBindings } from '../modules/runtime/bindings';
import type { ModuleForm } from '../modules/runtime/form';
import { createModuleReadCycle } from '../src/services/moduleDataService';
import { setAuthToken } from '../src/config/env';

let completed = false;
let passed = 0;
process.on('exit', () => {
  if (!completed) {
    console.error('ПРОВАЛ: runtime-проверка не дошла до окончания main');
    process.exitCode = 1;
  }
});
const check = (name: string, value: unknown) => {
  assert.ok(value, name); passed++; console.log(`✓ ${name}`);
};
const form: ModuleForm = {
  version: 1,
  groups: [{ title: 'Позиция', fields: [
    { label: 'Имя', bind: 'flux.equipment.name' },
    { label: 'Проект', bind: 'flux.project.name' },
    { label: 'Свое', bind: 'state.counter' },
    { label: 'Результат', bind: 'calc.out.count' },
  ] }],
  tables: [{ title: 'Параметры', bind: 'flux.equipment.params', columns: [{ label: 'Имя', key: 'key' }] }],
};

async function main() {
  const calls: string[] = [];
  let currentName = 'Позиция 1';
  const readBindings = () => readFormBindings(form, async resource => {
    calls.push(resource);
    return resource === 'project' ? { id: 'p', name: 'Проект', code: 'P' }
      : { id: 'e', name: currentName, itemCode: 'E', equipType: 'FAN', version: 1,
        params: [{ group: 'G', key: 'Расход', value: '1200', unit: 'м³/ч' }], tags: [], composition: [] };
  });
  const bound = await readBindings();
  check('flux-привязки заполняются без обработчика logic', !form.onDataChanged && bound.equipment?.name === 'Позиция 1');
  check('оболочка запрашивает один раз каждый ресурс формы', calls.join() === 'equipment,project');
  currentName = 'Позиция 2';
  const refreshed = await readBindings();
  check('новое событие перечитывает привязку без кода модуля', refreshed.equipment?.name === 'Позиция 2');

  await setAuthToken('fixture');
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let airflow = '1200';
  let deny = false;
  globalThis.fetch = (async (url: string) => {
    requests.push(String(url));
    if (deny) return new Response('{}', { status: 403 });
    const bodies: Record<string, unknown> = {
      '/api/projects': { projects: [{ id: 'p', name: 'Проект' }] },
      '/api/projects/p/systems': { systems: [{ monoblocks: [{ components: [{
        id: 'e', name: 'Вентилятор', itemCode: 'E', version: 1, tags: [{ id: 't', identifier: 'T' }],
        specs: JSON.stringify({ Расход: airflow }),
      }] }] }] },
      '/api/projects/p/tags': { tags: [{ id: 't', identifier: 'T' }] },
    };
    assert.ok(String(url) in bodies);
    return new Response(JSON.stringify(bodies[String(url)]));
  }) as typeof fetch;
  try {
    const context = { projectId: 'p', entry: 'equipment' as const, entityId: 'e' };
    const cycle = createModuleReadCycle(context);
    await Promise.all([cycle('project'), cycle('equipment'), cycle('tag'), cycle('equipment')]);
    check('один цикл разделяет параллельные GET projects/systems/tags', requests.length === 3
      && new Set(requests).size === 3);
    airflow = '2400';
    check('снимок цикла не меняется посреди расчёта', (await cycle('equipment'))?.params[0].value === '1200');
    const next = createModuleReadCycle(context);
    check('следующий пересчёт получает свежие параметры', (await next('equipment'))?.params[0].value === '2400');
    deny = true;
    const denied = createModuleReadCycle(context);
    const before = requests.length;
    await assert.rejects(() => denied('equipment'));
    await assert.rejects(() => denied('tag'));
    check('ошибка запроса кэшируется только в текущем цикле', requests.length === before + 1);
    deny = false;
    check('новый цикл повторяет запрос после восстановления', !!await createModuleReadCycle(context)('project'));
  } finally { globalThis.fetch = originalFetch; }

  const source = await build({
    entryPoints: ['modules/runtime/worker.ts'], bundle: true, platform: 'browser', format: 'iife', write: false,
    plugins: [{ name: 'logic-probe', setup(plugin) {
      plugin.onResolve({ filter: /^module-logic$/ }, () => ({ path: 'logic-probe', namespace: 'probe' }));
      plugin.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({ contents: `
        export function setup({flux,state,calc}) {
          state.count ??= 0;
          const off = flux.on('changed', () => { state.unwanted = true; });
          off();
          flux.on('changed', async () => {
            state.count += 1;
            const data = await flux.read('equipment');
            calc.out = { parameterCount: data.params.length, count: state.count };
          });
          return { flux: { equipment: {name:'подмена'} } };
        }
      `, loader: 'js' }));
    } }],
  });
  const worker = new Worker(`
    const {parentPort} = require('node:worker_threads');
    globalThis.postMessage = value => parentPort.postMessage(value);
    parentPort.on('message', data => globalThis.onmessage({data}));
    ${source.outputFiles[0].text}
  `, { eval: true });
  let parameterCount = 2;
  async function run() {
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker не ответил')), 5000);
      const listener = (message: any) => {
        if (message.type === 'read') worker.postMessage({
          type: 'read-result', id: message.id, data: { params: Array(parameterCount).fill({}) },
        });
        else {
          clearTimeout(timer); worker.off('message', listener);
          if (message.type === 'done') resolve(message.data); else reject(new Error('Worker failed'));
        }
      };
      worker.on('message', listener);
      worker.postMessage({ type: 'run' });
    });
  }
  try {
    const first = await run();
    parameterCount = 3;
    const second = await run();
    check('flux.on вызывает расчёт на каждом changed', first.calc.out.parameterCount === 2
      && second.calc.out.parameterCount === 3);
    check('state сохраняется между событиями окна', second.state.count === 2 && second.calc.out.count === 2);
    check('отписанный обработчик не исполняется', !('unwanted' in second.state));
    check('результат logic не может стать flux-привязкой', !('flux' in first));
  } finally { await worker.terminate(); }
  completed = true;
  console.log(`\n${passed} проверок пройдено`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
