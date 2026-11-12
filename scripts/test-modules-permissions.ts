/**
 * Реестр разрешений программ (modules/permissions/registry.ts): строки для человека, повторное
 * согласие при обновлении, отпечаток, проверка объявления и «заметные» разрешения сети.
 *
 * Главное, что здесь держится: отпечатки разрешений старых манифестов (без `permissions`)
 * совпадают с теми, что считал код до реестра, — иначе у уже установленных программ окно и главный
 * процесс разошлись бы. Эталоны ниже сняты со старой реализации до переноса.
 *
 * Запуск: npx tsx scripts/test-modules-permissions.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PERMISSION_KINDS, addedPermissions, grantItems, permissionLines, permissionsDigest, permissionsValid, parsePermissions, hasProgramPermission } from '../modules/permissions/registry';
import { validManifest } from '../modules/schemas';
import { exportsOf } from '../modules/programs/model';
import { diffPermissions } from '../modules/trust/diff';
import { unmetRequirements, permissionLines as storeLines } from '../modules/store/model';
import type { ModuleManifest } from '../modules/contract';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };

const base = { id: 'x', name: 'X', version: '1.0.0', author: 'A', contractVersion: 1, entries: ['start', 'equipment'], reads: ['project', 'tag'], logic: 'logic/main.ts' };
const NET = 'Показывает курсы валют и погоду из открытых сервисов';
const LAN = 'Находит принтеры и контроллеры в сети предприятия';
const withNet = (...permissions: any[]) => ({ ...base, contractVersion: 3, permissions }) as unknown as ModuleManifest;
const m = (extra: object = {}) => ({ ...base, ...extra }) as unknown as ModuleManifest;

// Эталоны сняты с permissionsDigest до реестра
const GOLDEN: Record<string, string> = {
  "plain": "open:Открывается из карточки тега|read:Не читает данные Flux|run:Не запускает программы на компьютере|write:Ничего не записывает во Flux",
  "reads": "open:Открывается из «Пуска» и панели задач, из карточки оборудования|read:Читает во Flux: данные текущего проекта|read:Читает во Flux: теги|run:Не запускает программы на компьютере|write:Ничего не записывает во Flux",
  "com": "connect:Подключается к «E3.series»: читать. Читает схему проекта для сверки (COM-объект CT.Application)|open:Открывается из «Пуска» и панели задач, из карточки оборудования|read:Читает во Flux: данные текущего проекта|read:Читает во Flux: теги|run:Не запускает программы на компьютере|write:Ничего не записывает во Flux",
  "http": "connect:Подключается к «Сервер расчётов»: отправлять данные. Отправляет данные на расчёт (HTTP http://127.0.0.1:8123/api (внутренняя сеть))|open:Открывается из «Пуска» и панели задач, из карточки оборудования|read:Читает во Flux: справочник каталога|run:Не запускает программы на компьютере|write:Ничего не записывает во Flux"
};
const OLD: Record<string, object> = {
  plain: { reads: [], entries: ['tag'] },
  reads: {},
  com: { connections: [{ id: 'e3', kind: 'com', app: 'E3.series', does: 'Читает схему проекта для сверки', access: 'read', progId: 'CT.Application' }] },
  http: { reads: ['catalog'], connections: [{ id: 'srv', kind: 'http', app: 'Сервер расчётов', does: 'Отправляет данные на расчёт', access: 'send', url: 'http://127.0.0.1:8123', pathPrefix: '/api' }] },
};

console.log('Прежние манифесты: отпечатки не изменились');
for (const [name, extra] of Object.entries(OLD)) ok(`отпечаток «${name}» совпадает с прежним`, permissionsDigest(m(extra)) === GOLDEN[name]);
ok('окно Store берёт строки из реестра', storeLines(m()) .map(l => l.text).join() === permissionLines(m()).map(l => l.text).join());
ok('у старого манифеста нет заметных строк', OLD && Object.values(OLD).every(extra => permissionLines(m(extra)).every(l => !l.notable)));

console.log('Таблица видов');
ok('в таблице чтение, подключения, интернет и локальная сеть', ['reads', 'connections', 'internet', 'lan'].every(id => PERMISSION_KINDS.some(k => k.id === id)));
ok('подтверждают человек: чтение, подключения, интернет, сеть, программы; справочные строки — нет', PERMISSION_KINDS.filter(k => k.consent).map(k => k.id).join() === 'reads,connections,internet,lan,program');
ok('без объявлений: только чтение попадает в «подтвердить»', grantItems(m({ reads: [] })).length === 0 && grantItems(m()).length === 2);

console.log('Интернет и локальная сеть');
const lines = permissionLines(withNet({ kind: 'internet', does: NET }, { kind: 'lan', does: LAN }));
ok('обе строки есть и заметны', lines.filter(l => l.kind === 'internet' && l.notable).length === 1 && lines.filter(l => l.kind === 'lan' && l.notable).length === 1);
ok('строки идут до «ничего не записывает» и после подключений', lines.findIndex(l => l.kind === 'internet') < lines.findIndex(l => l.kind === 'write') && lines.findIndex(l => l.kind === 'internet') > lines.findIndex(l => l.kind === 'open'));
ok('текст — слова человека, а не вид из манифеста', lines.some(l => l.text === `Обращается к любому адресу в интернете: ${NET}`) && lines.some(l => l.text.startsWith('Обращается к устройствам в локальной сети')));
ok('отпечаток зависит от разрешения сети', permissionsDigest(withNet({ kind: 'internet', does: NET })) !== permissionsDigest(m({ contractVersion: 3 })) && permissionsDigest(withNet({ kind: 'internet', does: NET })) !== permissionsDigest(withNet({ kind: 'lan', does: NET })));

console.log('Повторное согласие');
const had = m(), plus = withNet({ kind: 'internet', does: NET });
ok('добавленный интернет — новое разрешение', addedPermissions(had, plus).join() === `Обращается к любому адресу в интернете: ${NET}`);
ok('локальная сеть к интернету — тоже новое', addedPermissions(plus, withNet({ kind: 'internet', does: NET }, { kind: 'lan', does: LAN })).length === 1);
ok('то же самое — подтверждать нечего', addedPermissions(plus, plus).length === 0);
ok('убрали разрешение — подтверждать нечего', addedPermissions(plus, had).length === 0);
ok('смена смысла (текст «что делает») спрашивает заново', addedPermissions(plus, withNet({ kind: 'internet', does: 'Отправляет данные расчёта на сервер разработчика' })).length === 1);
ok('первая установка: всё прочитанное и заявленное — к подтверждению', addedPermissions(null, plus).length === 3);

// Автообновление берёт только версии без новых разрешений: условие — в цикле moduleStoreActions, а сравнение даёт реестр
const auto = fs.readFileSync('src/services/moduleStoreActions.ts', 'utf8');
ok('автообновление пропускает версию с новым разрешением и оставляет её окну согласия', /autoOn\(x, store\.autoUpdate\)\)\) \{\s*if \(newPermissions\(l\)\.length/.test(auto) && addedPermissions(had, plus).length > 0);

console.log('Проверка объявления');
const bad = (...p: any[]) => !permissionsValid({ ...base, contractVersion: 3, permissions: p });
ok('допустимое принимается', permissionsValid(withNet({ kind: 'internet', does: NET }, { kind: 'lan', does: LAN })));
ok('неизвестный вид, лишнее поле, чужой тип — отказ', bad({ kind: 'files', does: NET }) && bad({ kind: 'lan', does: LAN, hosts: ['a'] }) && bad('internet') && bad(null));
ok('текст для человека обязателен и без адресов и разметки', bad({ kind: 'internet' }) && bad({ kind: 'internet', does: '' }) && bad({ kind: 'internet', does: 'Ходит' })
  && bad({ kind: 'internet', does: 'Читает https://example.com каждые пять минут' }) && bad({ kind: 'lan', does: 'Опрашивает 192.168.1.10 по списку устройств' }) && bad({ kind: 'internet', does: '<b>Читает</b> данные из сети' }));
ok('повтор того же и больше шестнадцати — отказ', bad({ kind: 'internet', does: NET }, { kind: 'internet', does: NET }) && !permissionsValid({ ...base, contractVersion: 3, permissions: Array.from({ length: 17 }, (_, i) => ({ kind: 'internet', does: `Читает источник номер ${'а'.repeat(i + 1)} для отчёта` })) }));
ok('два разных текста одного вида допустимы', parsePermissions([{ kind: 'internet', does: NET }, { kind: 'internet', does: 'Скачивает обновления справочника цен' }])?.length === 2);

console.log('Манифест и договор');
ok('схема принимает permissions в договоре v3', validManifest({ ...base, contractVersion: 3, permissions: [{ kind: 'internet', does: NET }] }));
ok('permissions в v1 и v2 — отказ: старый Flux должен сказать «обновите»', !validManifest({ ...base, permissions: [{ kind: 'internet', does: NET }] }) && !validManifest({ ...base, contractVersion: 2, permissions: [{ kind: 'internet', does: NET }] }));
ok('страница (ui) возможна и в v2, и в v3', validManifest({ ...base, contractVersion: 2, ui: 'page' }) && validManifest({ ...base, contractVersion: 3, ui: 'page', permissions: [{ kind: 'lan', does: LAN }] }));
ok('v1 и v2 без permissions не изменились', validManifest(base) && validManifest({ ...base, contractVersion: 2 }) && !validManifest({ ...base, contractVersion: 4 }));
ok('v3 без permissions допустим', validManifest({ ...base, contractVersion: 3 }));
ok('пустой permissions тоже только v3', validManifest({ ...base, contractVersion: 3, permissions: [] }) && !validManifest({ ...base, permissions: [] }));
ok('плохое разрешение отвергает весь манифест', !validManifest({ ...base, contractVersion: 3, permissions: [{ kind: 'internet', does: 'x' }] }));
ok('Flux старше v3 просит обновиться', unmetRequirements(withNet({ kind: 'internet', does: NET }), { fluxVersion: '1.0.0', windows: true }).length === 0 && unmetRequirements(m({ contractVersion: 4 }), { fluxVersion: '1.0.0', windows: true }).length === 1);

console.log('Разница запроса владельца');
const diff = diffPermissions(m() as any, plus as any);
ok('новое: любой адрес в интернете', diff.widened && diff.added.permissions?.length === 1 && diff.added.permissions[0].startsWith('любой адрес в интернете'));
ok('локальная сеть названа отдельно', diffPermissions(plus as any, withNet({ kind: 'internet', does: NET }, { kind: 'lan', does: LAN }) as any).added.permissions?.[0].startsWith('локальная сеть'));
ok('без изменений разница пуста', !diffPermissions(plus as any, plus as any).widened && diffPermissions(plus as any, m() as any).removed.permissions?.length === 1);

console.log('Обращение к другой программе (kind program)');
const RATE = 'Берёт у калькулятора курсов пересчёт сумм для отчёта';
const withProgram = (...permissions: any[]) => ({ ...base, id: 'caller', contractVersion: 3, permissions }) as unknown as ModuleManifest;
const callRates = { kind: 'program', program: 'rates', does: RATE };
const programLines = permissionLines(withProgram(callRates));
ok('строка называет программу по имени из каталога и заметна', permissionLines(withProgram(callRates), id => id === 'rates' ? 'Курсы валют' : undefined)
  .some(l => l.kind === 'program' && l.notable && l.text === `Обращается к программе «Курсы валют»: ${RATE}`));
ok('без названия показывается идентификатор', programLines.some(l => l.text === `Обращается к программе «rates»: ${RATE}`));
ok('строка идёт после локальной сети и до «ничего не записывает»', programLines.findIndex(l => l.kind === 'program') > programLines.findIndex(l => l.kind === 'open')
  && programLines.findIndex(l => l.kind === 'program') < programLines.findIndex(l => l.kind === 'write'));
ok('отпечаток не зависит от названия из каталога', permissionsDigest(withProgram(callRates)) === permissionsDigest(withProgram(callRates)) && permissionLines(withProgram(callRates), () => 'Другое имя').map(l => l.stable ?? l.text).join() === programLines.map(l => l.stable ?? l.text).join());
ok('отпечаток меняется вместе с программой и текстом', permissionsDigest(withProgram(callRates)) !== permissionsDigest(withProgram({ ...callRates, program: 'prices' })) && permissionsDigest(withProgram(callRates)) !== permissionsDigest(withProgram({ ...callRates, does: 'Берёт у калькулятора курсов пересчёт цен для сметы' })) && permissionsDigest(withProgram(callRates)) !== permissionsDigest(m({ contractVersion: 3 })));
ok('добавленное обращение спрашивается заново, под названием из каталога', addedPermissions(m(), withProgram(callRates), id => 'Курсы валют').join() === `Обращается к программе «Курсы валют»: ${RATE}`);
ok('другая программа или смысл — снова новое; то же — нет', addedPermissions(withProgram(callRates), withProgram(callRates, { ...callRates, program: 'prices' })).length === 1
  && addedPermissions(withProgram(callRates), withProgram({ ...callRates, does: 'Берёт у калькулятора курсов пересчёт цен для сметы' })).length === 1
  && addedPermissions(withProgram(callRates), withProgram(callRates)).length === 0);
ok('названия не мешают сравнению версий', addedPermissions(withProgram(callRates), withProgram(callRates), () => 'Новое имя').length === 0);
ok('разрешение подтверждает человек (в «Программа получит»)', grantItems(withProgram(callRates)).some(i => i.line.kind === 'program'));
const pbad = (...p: any[]) => !permissionsValid({ ...base, id: 'caller', contractVersion: 3, permissions: p });
ok('принимается с идентификатором и текстом', permissionsValid(withProgram(callRates)) && hasProgramPermission(withProgram(callRates), 'rates') && !hasProgramPermission(withProgram(callRates), 'prices'));
ok('без program, с чужим идентификатором, с лишним полем — отказ', pbad({ kind: 'program', does: RATE }) && pbad({ kind: 'program', program: 'Rates', does: RATE }) && pbad({ kind: 'program', program: '1x', does: RATE })
  && pbad({ ...callRates, hosts: ['a'] }) && pbad({ kind: 'internet', program: 'rates', does: RATE }) && pbad({ kind: 'program', program: 5, does: RATE }));
ok('текст для человека обязателен и без адресов', pbad({ kind: 'program', program: 'rates' }) && pbad({ kind: 'program', program: 'rates', does: 'Берёт' }) && pbad({ kind: 'program', program: 'rates', does: 'Читает https://example.com каждые пять минут' }));
ok('обращение к самой себе объявить нельзя', pbad({ kind: 'program', program: 'caller', does: RATE }));
ok('повтор того же — отказ, два текста или две программы — можно', pbad(callRates, callRates) && permissionsValid(withProgram(callRates, { ...callRates, does: 'Берёт у калькулятора курсов пересчёт цен для сметы' }, { ...callRates, program: 'prices' })));
ok('вместе с сетью — общий предел шестнадцати', !permissionsValid({ ...base, id: 'caller', contractVersion: 3, permissions: Array.from({ length: 17 }, (_, i) => ({ kind: 'program', program: `p${i}`, does: RATE })) })
  && permissionsValid({ ...base, id: 'caller', contractVersion: 3, permissions: [{ kind: 'internet', does: NET }, ...Array.from({ length: 15 }, (_, i) => ({ kind: 'program', program: `p${i}`, does: RATE }))] }));
ok('схема: program только в договоре v3', validManifest({ ...base, id: 'caller', contractVersion: 3, permissions: [callRates] }) && !validManifest({ ...base, id: 'caller', permissions: [callRates] }) && !validManifest({ ...base, id: 'caller', contractVersion: 3, permissions: [{ ...callRates, program: 'caller' }] }));
const diffProgram = diffPermissions(m() as any, withProgram(callRates) as any);
ok('разница владельца: новое обращение названо по идентификатору', diffProgram.widened && diffProgram.added.permissions?.length === 1 && diffProgram.added.permissions[0].startsWith('программа «rates»'));
ok('сменили программу — новое и убранное; то же — пусто', diffPermissions(withProgram(callRates) as any, withProgram({ ...callRates, program: 'prices' }) as any).added.permissions?.length === 1 && !diffPermissions(withProgram(callRates) as any, withProgram(callRates) as any).widened);
ok('Flux старше v3 просит обновиться', unmetRequirements(withProgram(callRates), { fluxVersion: '1.0.0', windows: true }).length === 0);

console.log('Методы для других программ (exports)');
const EXP = 'Пересчитывает сумму из одной валюты в другую по курсу';
const withExports = (...list: any[]) => ({ ...base, id: 'rates', contractVersion: 3, language: 'python', logic: 'logic/main.py', exports: list }) as any;
ok('допустимое принимается', validManifest(withExports({ method: 'convert', does: EXP }, { method: 'rateOn', does: 'Отдаёт курс на указанную дату' })));
ok('exports только в договоре v3', !validManifest({ ...withExports({ method: 'convert', does: EXP }), contractVersion: 2 }) && !validManifest({ ...withExports({ method: 'convert', does: EXP }), contractVersion: 1 }));
const ebad = (...list: any[]) => !validManifest(withExports(...list));
ok('имя метода: латиница с маленькой буквы, без знаков, до 40', ebad({ method: 'Convert', does: EXP }) && ebad({ method: 'rate-on', does: EXP }) && ebad({ method: 'курс', does: EXP }) && ebad({ method: '', does: EXP }) && ebad({ method: 'a'.repeat(41), does: EXP })
  && validManifest(withExports({ method: 'a'.repeat(40), does: EXP })));
ok('текст обязателен, без адресов и разметки', ebad({ method: 'convert' }) && ebad({ method: 'convert', does: 'Считает' }) && ebad({ method: 'convert', does: 'Берёт данные с https://example.com каждый день' }) && ebad({ method: 'convert', does: '<b>Считает</b> сумму по курсу' }));
ok('лишнее поле, повтор метода, не массив, больше шестнадцати — отказ', ebad({ method: 'convert', does: EXP, extra: 1 }) && ebad({ method: 'convert', does: EXP }, { method: 'convert', does: 'Отдаёт курс на указанную дату' })
  && !validManifest({ ...withExports(), exports: 'convert' }) && ebad(...Array.from({ length: 17 }, (_, i) => ({ method: `m${i}`, does: EXP }))) && validManifest(withExports(...Array.from({ length: 16 }, (_, i) => ({ method: `m${i}`, does: EXP })))));
ok('пустой exports допустим в v3; без exports ничего не меняется', validManifest(withExports()) && validManifest(base));
ok('exports не разрешение: отпечаток и «новое» от него не меняются', permissionsDigest(withExports({ method: 'convert', does: EXP })) === permissionsDigest(withExports()) && addedPermissions(withExports(), withExports({ method: 'convert', does: EXP })).length === 0);
ok('exportsOf читает объявленное', exportsOf(withExports({ method: 'convert', does: EXP })).map(e => e.method).join() === 'convert' && exportsOf(base as any).length === 0);

console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${passed})`);
