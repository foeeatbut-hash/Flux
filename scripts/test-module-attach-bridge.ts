/**
 * flux.attach: прикрепление результата программы к проекту — мост, разрешение, имитация Studio, тексты для человека.
 *
 * Что доказывается (запись в базу — отдельный набор test-module-attach-server):
 * - схема сообщения и код NO_PROJECT как допустимый ответ страницы;
 * - мост: без разрешения `attach` в подписанном манифесте — FORBIDDEN, и хост НЕ вызывается (ни байта не передано); с разрешением
 *   хост получает имя, тип и байты, а программа — `{ name, folder }`; исполняемое имя, частота, хост без поддержки, отказы хоста — свои коды;
 * - строки для человека: «Прикрепляет результаты к проектам» и честная строка «Записывает во Flux только файлы-результаты» вместо «Ничего не записывает»;
 * - имя файла при занятом получает номер, прежний не перезаписывается;
 * - клиент flux.attach в настоящем кадре отдаёт `{ name, folder }`, а отказ — ошибкой с кодом (нужен FLUX_CHROME);
 * - «Обновите программу»: манифест более нового договора или с неизвестным видом разрешения не «не соответствует формату», а просит обновить Flux.
 *
 * Запуск: npx tsx scripts/test-module-attach-bridge.ts   (часть с кадром — FLUX_CHROME)
 */
import { createModuleBridge } from '../modules/bridge';
import { themeKeys, CONTRACT_VERSION } from '../modules/contract';
import { validMessage } from '../modules/schemas';
import { PAGE_ERROR_CODES, PAGE_MIN_FLUX } from '../modules/page/model';
import { ATTACH_ROOT_FOLDER, attachFolderName, attachFolderPath, freeAttachName } from '../modules/page/attach';
import { permissionLines, grantItems } from '../modules/permissions/registry';
import { fluxPageTypes } from '../modules/page/types';
import { bundleManifest } from '../modules/trust/verify';
import { unmetRequirements } from '../modules/store/model';
import { packBundle, unpackBundle } from '../modules/trust/bundle';

let failed = 0, passed = 0;
const ok = (name: string, condition: unknown) => { if (condition) { passed++; console.log('  ✓', name); } else { failed++; console.error('  ✗', name); } };
const DOES = 'Прикрепляет таблицу расчёта к открытому проекту';
const base = { id: 'attach-page', name: 'Расчёт воздуха', version: '1.0.0', author: 'Flux', contractVersion: 3, entries: ['start'], reads: ['project'], logic: 'logic/main.ts', ui: 'page', store: { category: 'calc', summary: 'x', requires: { flux: PAGE_MIN_FLUX } } } as any;
const withAttach = { ...base, permissions: [{ kind: 'attach', does: DOES }] };

async function main() {
  console.log('1. Схема и коды');
  const env = { flux: 'module', v: 1, session: 's', id: 'p-1', type: 'page' };
  ok('attach допустим', validMessage('page', { ...env, op: 'attach', name: 'расчёт.csv', data: 'YQ==', encoding: 'base64' }));
  ok('attach с лишним полем (проект) недопустим: проект называет окно Flux, а не программа', !validMessage('page', { ...env, op: 'attach', name: 'a.csv', data: 'x', encoding: 'utf8', projectId: 'чужой' }));
  ok('ответ страницы NO_PROJECT допустим', validMessage('page-error', { flux: 'module', v: 1, session: 's', type: 'page-error', id: 'p-1', code: 'NO_PROJECT' }) && (PAGE_ERROR_CODES as readonly string[]).includes('NO_PROJECT'));
  ok('типы flux.d.ts: attach возвращает { name, folder }, а не never', /attach\([^)]*\): Promise<\{ name: string; folder: string \}>/.test(fluxPageTypes()));

  console.log('\n2. Мост');
  const sent: any[] = [];
  const frame = { postMessage: (m: unknown) => sent.push(m) } as unknown as Window;
  const theme = Object.fromEntries(themeKeys.map(k => [k, '#000'])) as never;
  const log: any[] = [];
  const calls: any[] = [];
  const hostAnswer: { value: any } = { value: { name: 'расчёт.csv', folder: attachFolderPath('Расчёт воздуха') } };
  const pageOptions = (extra: Record<string, unknown> = {}) => ({
    loadState: () => ({}), keepState: () => undefined, offerFile: async () => 'saved' as const, onBeat: () => undefined, openWindow: () => true, params: () => ({}), broadcast: () => undefined,
    attach: async (file: any) => { calls.push(file); if (hostAnswer.value instanceof Error) throw hostAnswer.value; return hostAnswer.value; },
    onAttach: (a: any) => log.push(a), ...extra,
  });
  const make = (manifest: any, page: any) => createModuleBridge({ frame: () => frame, session: 's', manifest, context: () => ({ projectId: 'p', entry: 'start', entityId: null }), theme: () => theme, read: (async () => null) as never, page });
  let n = 0;
  const attach = async (bridge: ReturnType<typeof make>, extra: Record<string, unknown> = {}) => {
    sent.length = 0;
    await bridge.handle({ source: frame as never, origin: 'null', data: { ...env, id: `p-${++n}`, op: 'attach', name: 'расчёт.csv', mime: 'text/csv', data: 'a;b\n1;2\n', encoding: 'utf8', ...extra } });
    return sent[0];
  };
  const ready = async (bridge: ReturnType<typeof make>) => { await bridge.handle({ source: frame as never, origin: 'null', data: { flux: 'module', v: 1, session: 's', type: 'ready' } }); };
  const pause = () => new Promise(r => setTimeout(r, 1050));

  const denied = make(base, pageOptions());
  await ready(denied);
  let reply = await attach(denied);
  ok('без разрешения — FORBIDDEN', reply.type === 'page-error' && reply.code === 'FORBIDDEN');
  ok('без разрешения хост не вызван: ни одного байта наружу', calls.length === 0);
  ok('без разрешения отказ виден хосту для журнала', log.length === 1 && log[0].code === 'FORBIDDEN');

  const bridge = make(withAttach, pageOptions());
  await ready(bridge);
  log.length = 0;
  reply = await attach(bridge);
  ok('с разрешением программа получает { name, folder }', reply.type === 'page-result' && reply.data.name === 'расчёт.csv' && reply.data.folder === `${ATTACH_ROOT_FOLDER} / Расчёт воздуха`);
  ok('хост получил имя, тип и байты', calls.length === 1 && calls[0].name === 'расчёт.csv' && calls[0].mime === 'text/csv' && new TextDecoder().decode(calls[0].bytes) === 'a;b\n1;2\n');
  ok('исход ОК записан для журнала', log.length === 1 && log[0].code === 'OK' && log[0].bytes === 8);
  reply = await attach(bridge);
  ok('второй вызов сразу — LIMIT, хост не вызван', reply.code === 'LIMIT' && calls.length === 1);
  await pause();
  reply = await attach(bridge, { data: Buffer.from([0, 1, 2, 250, 251]).toString('base64'), encoding: 'base64', name: 'схема.bin' });
  ok('base64 доходит байт в байт', reply.type === 'page-result' && calls.length === 2 && Array.from(calls[1].bytes).join() === '0,1,2,250,251');
  await pause();
  hostAnswer.value = { name: 'расчёт (2).csv', folder: 'x' };
  reply = await attach(bridge);
  ok('имя, под которым файл лёг (с номером), доходит до программы', reply.data.name === 'расчёт (2).csv');
  await pause();
  for (const code of ['NO_PROJECT', 'DENIED', 'LIMIT', 'FAILED']) {
    hostAnswer.value = { code };
    reply = await attach(bridge);
    ok(`отказ хоста ${code} доходит до программы как есть`, reply.type === 'page-error' && reply.code === code);
    await pause();
  }
  hostAnswer.value = new Error('сервер упал');
  reply = await attach(bridge);
  ok('исключение хоста — FAILED, а не молчание', reply.code === 'FAILED');
  await pause();
  const before = calls.length;
  for (const name of ['вирус.exe', 'run.bat', 'con.txt', 'x.js.cmd', 'файл.']) {
    reply = await attach(bridge, { name });
    ok(`исполняемое или служебное имя «${name}» — DENIED, хост не вызван`, reply.code === 'DENIED' && calls.length === before);
    await pause();
  }
  const noHost = make(withAttach, pageOptions({ attach: undefined }));
  await ready(noHost);
  reply = await attach(noHost);
  ok('хост без поддержки (старое окно, Studio владельца) — UNAVAILABLE, не успех', reply.code === 'UNAVAILABLE');
  const form = make({ ...withAttach, ui: undefined, contractVersion: 3 }, pageOptions());
  await ready(form);
  const beforeForm = calls.length;
  reply = await attach(form);
  ok('программа с формой (не страница) — DENIED, хост не вызван', reply.code === 'DENIED' && calls.length === beforeForm);

  console.log('\n3. Имя и папка');
  ok('папка по названию программы', attachFolderPath('Расчёт воздуха') === 'Результаты программ / Расчёт воздуха');
  ok('разделители пути и управляющие знаки в названии программы не создают вложенных папок', !/[\\/\u0000]/.test(attachFolderName('../../Секрет\\x/y\u0000z')));
  ok('пустое название — «Программа»', attachFolderName('  ') === 'Программа');
  ok('свободное имя не меняется', freeAttachName('a.csv', ['b.csv']) === 'a.csv');
  ok('занятое получает номер перед расширением', freeAttachName('a.csv', ['a.csv']) === 'a (2).csv');
  ok('номер подбирается дальше занятых', freeAttachName('a.csv', ['a.csv', 'a (2).csv', 'A (3).CSV']) === 'a (4).csv');
  ok('без расширения номер в конце', freeAttachName('отчёт', ['отчёт']) === 'отчёт (2)');
  ok('длинное имя с номером не длиннее предела', freeAttachName(`${'я'.repeat(98)}.x`, [`${'я'.repeat(98)}.x`]).length <= 100);

  console.log('\n4. Строки для человека');
  const lines = permissionLines(withAttach).map(l => l.text);
  ok('есть заметная строка «Прикрепляет результаты к проектам»', lines.some(t => t.startsWith('Прикрепляет результаты к проектам: ')) && permissionLines(withAttach).find(l => l.kind === 'attach')?.notable === true);
  ok('«Ничего не записывает во Flux» рядом с прикреплением — неправда и не показывается', !lines.includes('Ничего не записывает во Flux') && lines.some(t => t.startsWith('Записывает во Flux только файлы-результаты')));
  ok('программа без прикрепления по-прежнему «Ничего не записывает»', permissionLines(base).some(l => l.text === 'Ничего не записывает во Flux'));
  ok('прикрепление входит в то, с чем человек соглашается', grantItems(withAttach).some(i => i.line.kind === 'attach') && !grantItems(base).some(i => i.line.kind === 'attach'));

  console.log('\n5. «Обновите программу»');
  const check = (manifest: unknown) => bundleManifest(unpackBundle(packBundle({ 'manifest.json': JSON.stringify(manifest) })), 'attach-page', '1.0.0');
  const newer = check({ ...base, contractVersion: CONTRACT_VERSION + 1 });
  ok('договор новее этого Flux — «Обновите программу», а не «не соответствует»', typeof newer === 'string' && /^Обновите программу/.test(newer) && !/не соответствует/.test(newer));
  ok('и называет нужную версию договора', typeof newer === 'string' && newer.includes(`v${CONTRACT_VERSION + 1}`));
  const unknownKind = check({ ...withAttach, permissions: [{ kind: 'camera', does: 'Снимает документы на камеру компьютера' }] });
  ok('неизвестный вид разрешения (новее этого Flux) — тоже «Обновите программу»', typeof unknownKind === 'string' && /^Обновите программу/.test(unknownKind));
  const broken = check({ ...base, id: 12 });
  ok('поломанный манифест остаётся «не соответствует»: «обновите» было бы ложью', typeof broken === 'string' && /не соответствует/.test(broken) && !/Обновите/.test(broken));
  const okManifest = check(withAttach);
  ok('манифест этого Flux читается', typeof okManifest !== 'string' && okManifest.id === 'attach-page');
  const unmet = unmetRequirements({ ...base, contractVersion: CONTRACT_VERSION + 1 }, { fluxVersion: '9.9.9', windows: true });
  ok('Store при более новом формате говорит «Обновите программу Flux» и не прячет причину', unmet.length === 1 && /^Обновите программу Flux/.test(unmet[0]));
  const noFooter = check({ ...base, contractVersion: CONTRACT_VERSION + 1, permissions: [{ kind: 'camera' }] });
  ok('у более нового договора причина не зависит от остального содержимого', typeof noFooter === 'string' && /^Обновите программу/.test(noFooter));

  console.log(`\nattach-bridge: ${passed} проверок прошли, ${failed} не прошли`);
  if (failed) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
