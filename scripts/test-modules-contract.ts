import { createModuleBridge } from '../modules/bridge';
import { bundledModules } from '../modules/bundled';
import { themeKeys, type Resource, type ReadData, type ThemeTokens } from '../modules/contract';
import { validManifest, validMessage } from '../modules/schemas';
import { moduleAssetPath } from '../modules/protocol';

let failed = 0;
let passed = 0;
const ok = (name: string, condition: boolean) => {
  if (condition) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name); }
};
const tag = { id: 't', identifier: 'T1', name: 'Тег', parentId: null };
const data: ReadData = {
  project: { id: 'p', name: 'Проект', code: 'P' },
  equipment: { id: 'e', name: 'Позиция', itemCode: 'E', equipType: 'type', version: 1,
    params: [{ group: 'Общие', key: 'Мощность', value: '5', unit: 'кВт' }], tags: [tag],
    composition: [{ id: 'child', name: 'Деталь', itemCode: 'C', parentId: 'e' }] },
  tag,
  specification: { rows: [tag] },
  catalog: { families: [{ id: 'f', name: 'Семейство', code: 'F', classId: 'c' }] },
};
const base = { flux: 'module', v: 1, session: 'session' };
const request = (id: string, resource: Resource = 'equipment') => ({ ...base, type: 'read', id, resource, entityId: 'e' });
const theme = Object.fromEntries(themeKeys.map(key => [key, '#123456'])) as ThemeTokens;

async function main() {
  console.log('1. Строгий договор сообщений и манифеста');
  for (const resource of ['project', 'equipment', 'tag', 'specification', 'catalog'] as const) {
    const result = { ...base, type: 'result', id: 'r', resource, data: data[resource] };
    ok(`${resource}: корректные данные принимаются`, validMessage('result', result));
    ok(`${resource}: лишнее поле данных запрещено`, !validMessage('result', { ...result, data: { ...data[resource], secret: 'x' } }));
    ok(`${resource}: неверная форма данных отклоняется`, !validMessage('result', { ...result, data: { unexpected: true } }));
  }
  ok('вложенный лишний параметр не проходит схему', !validMessage('result', {
    ...base, type: 'result', id: 'r', resource: 'equipment', data: { ...data.equipment!, params: [{ ...data.equipment!.params[0], extra: true }] },
  }));
  ok('манифест примера корректен', !!validManifest(bundledModules[0]));
  ok('лишнее поле манифеста запрещено', !validManifest({ ...bundledModules[0], extra: true }));
  ok('неизвестная версия договора запрещена', !validManifest({ ...bundledModules[0], contractVersion: 2 }));
  ok('неизвестный ресурс в манифесте запрещён', !validManifest({ ...bundledModules[0], reads: ['secret'] }));

  console.log('\n2. Проверка границы моста');
  const messages: any[] = [];
  const calls: Array<[Resource, string | undefined]> = [];
  const frame = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
  const bridge = createModuleBridge({ frame: () => frame, session: 'session', manifest: bundledModules[0],
    context: () => ({ projectId: 'p', entry: 'equipment', entityId: 'e' }), theme: () => theme,
    read: async <R extends Resource>(resource: R, id?: string): Promise<ReadData[R]> => { calls.push([resource, id]); return data[resource]; },
  });
  const send = (value: unknown, source: unknown = frame, origin = 'null') => bridge.handle({ source: source as MessageEventSource, origin, data: value });
  await send({ ...base, type: 'ready' });
  ok('готовый модуль получает контекст открытия', messages[0]?.event === 'opened' && messages[0]?.context.entityId === 'e');
  messages.length = 0;
  const before = JSON.stringify(data);
  await send({ ...base, type: 'write', id: 'w', resource: 'equipment', entityId: 'e', data: { name: 'Изменено' } });
  ok('запись получает READ_ONLY', messages.length === 1 && messages[0].code === 'READ_ONLY' && messages[0].id === 'w');
  ok('запись не вызывает чтение и не меняет данные', calls.length === 0 && JSON.stringify(data) === before);
  messages.length = 0;
  for (const invalid of [
    { ...request('bad-extra'), extra: true }, { ...request('bad-version'), v: 2 },
    { ...request('bad-method'), type: 'delete' }, { ...request('bad-resource'), resource: 'secret' },
    { ...request('bad-session'), session: 'other' },
  ]) await send(invalid);
  await send(request('bad-source'), {});
  await send(request('bad-origin'), frame, 'https://host.example');
  ok('чужие и изменённые сообщения не доходят до чтения', calls.length === 0 && messages.length === 0);
  await send(request('good'));
  ok('разрешённое чтение возвращает позицию', calls.length === 1 && calls[0][0] === 'equipment' && messages[0]?.data.name === 'Позиция');
  bridge.notify('changed');
  ok('изменение данных доставляется открытому модулю', messages.at(-1)?.event === 'changed');

  const deniedMessages: any[] = [];
  const deniedFrame = { postMessage: (message: unknown) => deniedMessages.push(message) } as unknown as Window;
  let deniedCalls = 0;
  const denied = createModuleBridge({ frame: () => deniedFrame, session: 'session', manifest: { ...bundledModules[0], reads: [] },
    context: () => ({ projectId: 'p', entry: 'equipment', entityId: 'e' }), theme: () => theme,
    read: async <R extends Resource>(resource: R): Promise<ReadData[R]> => { deniedCalls++; return data[resource]; },
  });
  await denied.handle({ source: deniedFrame, origin: 'null', data: { ...base, type: 'ready' } });
  await denied.handle({ source: deniedFrame, origin: 'null', data: request('denied') });
  ok('ресурс без разрешения получает DENIED без чтения', deniedMessages.at(-1)?.code === 'DENIED' && deniedCalls === 0);

  console.log('\n3. Асинхронные границы');
  const pendingMessages: any[] = [];
  const pendingFrame = { postMessage: (message: unknown) => pendingMessages.push(message) } as unknown as Window;
  const resolvers: Array<(value: any) => void> = [];
  const pendingBridge = createModuleBridge({ frame: () => pendingFrame, session: 'session', manifest: bundledModules[0],
    context: () => ({ projectId: 'p', entry: 'equipment', entityId: 'e' }), theme: () => theme,
    read: <R extends Resource>() => new Promise<ReadData[R]>(resolve => resolvers.push(resolve)),
  });
  const pendSend = (value: unknown) => pendingBridge.handle({ source: pendingFrame, origin: 'null', data: value });
  await pendSend({ ...base, type: 'ready' });
  pendingMessages.length = 0;
  const first = pendSend(request('old'));
  pendingBridge.notify('project-changed');
  resolvers.shift()!(data.equipment);
  await first;
  ok('ответ старого проекта не доставляется после смены', pendingMessages.length === 1 && pendingMessages[0].event === 'project-changed');
  pendingMessages.length = 0;
  const waiting = Array.from({ length: 16 }, (_, index) => pendSend(request(`pending-${index}`)));
  await pendSend(request('overflow'));
  ok('семнадцатый одновременный запрос отклоняется', resolvers.length === 16 && pendingMessages.at(-1)?.id === 'overflow' && pendingMessages.at(-1)?.code === 'LIMIT');
  pendingBridge.dispose();
  const beforeDispose = pendingMessages.length;
  resolvers.splice(0).forEach(resolve => resolve(data.equipment));
  await Promise.all(waiting);
  ok('после dispose ожидающие ответы не доставляются', pendingMessages.length === beforeDispose);

  const invalidMessages: any[] = [];
  const invalidFrame = { postMessage: (message: unknown) => invalidMessages.push(message) } as unknown as Window;
  const invalidBridge = createModuleBridge({ frame: () => invalidFrame, session: 'session', manifest: bundledModules[0],
    context: () => ({ projectId: 'p', entry: 'equipment', entityId: 'e' }), theme: () => theme,
    read: async <R extends Resource>() => ({ id: 'e', secret: 'private' } as unknown as ReadData[R]),
  });
  await invalidBridge.handle({ source: invalidFrame, origin: 'null', data: { ...base, type: 'ready' } });
  await invalidBridge.handle({ source: invalidFrame, origin: 'null', data: request('invalid-result') });
  ok('данные вне схемы не передаются модулю', invalidMessages.at(-1)?.code === 'LIMIT' && !invalidMessages.some(message => message.type === 'result'));

  console.log('\n4. Пути ресурсов модуля');
  const id = bundledModules[0].id;
  ok('разрешённый index открывается', moduleAssetPath(`flux-module://${id}/index.html`, [id])?.file === 'index.html');
  for (const url of [`flux-module://other/index.html`, `https://${id}/index.html`, `flux-module://${id}/../secret`,
    `flux-module://${id}/%2e%2e%2fsecret`, `flux-module://${id}/nested/runtime.js`, `flux-module://user@${id}/index.html`,
    `flux-module://${id}:123/index.html`, `flux-module://${id}/manifest.json`]) {
    ok(`путь ${url} запрещён`, moduleAssetPath(url, [id]) === null);
  }
  console.log(`\n${passed} проверок пройдено, ${failed} провалено`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
