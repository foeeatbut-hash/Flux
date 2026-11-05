import assert from 'node:assert/strict';
import { createModuleBridge } from '../modules/bridge';
import { bundledModules } from '../modules/bundled';
import { themeKeys, type ThemeTokens } from '../modules/contract';
import { MODULE_CSP } from '../modules/protocol';

let completed = false;
let passed = 0;
process.on('exit', () => {
  if (!completed) {
    console.error('ПРОВАЛ: проверка лимитов не дошла до окончания main');
    process.exitCode = 1;
  }
});
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  passed++;
  console.log(`✓ ${name}`);
};
const base = { flux: 'module', v: 1, session: 'session' };
const theme = Object.fromEntries(themeKeys.map(key => [key, '#ffffff'])) as ThemeTokens;
function fixture(read: () => Promise<any> = async () => null) {
  const messages: any[] = [];
  const frame = { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
  const bridge = createModuleBridge({
    frame: () => frame, session: 'session', manifest: bundledModules[0],
    context: () => ({ projectId: 'p', entry: 'equipment', entityId: 'e' }),
    theme: () => theme, read: read as any,
  });
  const send = (message: object) => bridge.handle({ source: frame, origin: 'null', data: { ...base, ...message } });
  return { messages, bridge, send };
}

async function main() {
  const originalNow = Date.now;
  let clock = 0;
  Date.now = () => clock;
  try {
    let reads = 0;
    const burst = fixture(async () => { reads++; return null; });
    await burst.send({ type: 'ready' });
    for (let index = 0; index < 105; index++) {
      await burst.send({ type: 'read', id: `read-${index}`, resource: 'project' });
    }
    check('за секунду исполняются 99 чтений после одного ready', reads === 99);
    clock = 1000;
    await burst.send({ type: 'read', id: 'next-second', resource: 'project' });
    check('новая секунда восстанавливает бюджет', reads === 100);
    burst.bridge.dispose();
  } finally { Date.now = originalNow; }

  let reads = 0;
  const write = fixture(async () => { reads++; return null; });
  await write.send({ type: 'ready' });
  write.messages.length = 0;
  for (const [index, command] of [
    { type: 'write', extra: true },
    { type: 'equipment:update', payload: { name: 'чужая запись' } },
    { type: 'read', method: 'POST', resource: 'project' },
    { type: 'request', op: 'delete', payload: {} },
    ...['writeEquipment', 'updateEquipment', 'put', 'upsert', 'rename', 'mutate', 'setValue', 'setvalue'].map(type => ({ type })),
  ].entries()) {
    await write.send({ id: `write-${index}`, ...command });
  }
  check('запись вне схемы получает READ_ONLY', write.messages.length === 12
    && write.messages.every(message => message.code === 'READ_ONLY'));
  check('запись-подобные сообщения не достигают чтения', reads === 0);
  write.messages.length = 0;
  await write.send({ type: 'write', id: 'huge-input', data: 'я'.repeat(600_000) });
  check('вход больше 1 МиБ в UTF-8 отбрасывается до обработки', write.messages.length === 0);
  write.bridge.dispose();

  const huge = fixture(async () => ({
    id: 'e', name: 'Вентилятор', itemCode: 'E', equipType: 'FAN', version: 1,
    params: Array.from({ length: 1000 }, () => ({ group: 'G', key: 'K', unit: '', value: 'я'.repeat(600) })),
    tags: [], composition: [],
  }));
  await huge.send({ type: 'ready' });
  huge.messages.length = 0;
  await huge.send({ type: 'read', id: 'huge-output', resource: 'equipment' });
  check('ответ больше 1 МиБ в UTF-8 заменяется LIMIT', huge.messages.length === 1
    && huge.messages[0].code === 'LIMIT');
  huge.bridge.dispose();
  check('CSP даёт самостоятельную sandbox-защиту', MODULE_CSP.split('; ').includes('sandbox allow-scripts'));
  completed = true;
  console.log(`\n${passed} проверок пройдено`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
