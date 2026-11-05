import assert from 'node:assert/strict';
import { sharedModuleReads, invalidateModuleReads } from '../src/services/moduleReadCache';
import { subscribeModuleRefresh, MODULE_FALLBACK_MS } from '../src/services/moduleRefresh';
let complete = false;
process.on('exit', () => { if (!complete) process.exitCode = 1; });
let passed = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`✓ ${name}`); };
async function main() {
  let calls = 0;
  const load = async (path: string) => ({ path, value: ++calls });
  const first = sharedModuleReads('session-a/api', load);
  const second = sharedModuleReads('session-a/api', load);
  const [a, b] = await Promise.all([first('/projects'), second('/projects')]);
  check('два окна разделяют один Promise GET', calls === 1 && a === b);
  invalidateModuleReads();
  await sharedModuleReads('session-a/api', load)('/projects');
  check('после сброса выполняется один свежий GET', calls === 2);
  await sharedModuleReads('session-b/api', load)('/projects');
  check('другой сеанс не получает данные первого', calls === 3);
  await sharedModuleReads('session-b/other-api', load)('/projects');
  check('другой API не использует прежний кэш', calls === 4);
  const oldWindow = globalThis.window;
  const oldInterval = globalThis.setInterval;
  const oldClear = globalThis.clearInterval;
  const timers: Array<{ run: () => void; ms: number }> = [];
  globalThis.window = new EventTarget() as any;
  globalThis.setInterval = ((run: () => void, ms: number) => { timers.push({ run, ms }); return timers.length; }) as any;
  globalThis.clearInterval = (() => {}) as any;
  let connected = true;
  let notifications = 0;
  const offA = subscribeModuleRefresh(() => { notifications++; }, () => connected);
  const offB = subscribeModuleRefresh(() => { notifications++; }, () => connected);
  const wait = () => new Promise(resolve => setTimeout(resolve, 120));
  try {
    check('один запасной таймер на все окна, не чаще двух минут', timers.length === 1 && timers[0].ms === MODULE_FALLBACK_MS
      && MODULE_FALLBACK_MS >= 120000);
    timers[0].run(); await wait();
    check('при работающем сокете опрос отсутствует', notifications === 0);
    connected = false; timers[0].run(); await wait();
    check('отключённый сокет допускает редкое обновление', notifications === 2);
    const before = calls;
    await sharedModuleReads('session-b/other-api', load)('/projects');
    check('запасное событие также сбрасывает общий кэш', calls === before + 1);
    window.dispatchEvent(new Event('socket:entity:changed'));
    window.dispatchEvent(new Event('socket:entity:changed'));
    await wait();
    check('одно изменение уведомляет все окна один раз', notifications === 4);
    const beforeEvent = calls;
    await Promise.all([sharedModuleReads('session-b/other-api', load)('/projects'),
      sharedModuleReads('session-b/other-api', load)('/projects')]);
    check('entity:changed сбрасывает общий кэш до перечитывания', calls === beforeEvent + 1);
    window.dispatchEvent(new Event('focus')); await wait();
    check('возврат фокуса перечитывает все открытые модули', notifications === 6);
  } finally {
    offA(); offB(); globalThis.window = oldWindow;
    globalThis.setInterval = oldInterval; globalThis.clearInterval = oldClear;
  }
  complete = true;
  console.log(`${passed} проверок пройдено`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
