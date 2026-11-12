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
import { PERMISSION_KINDS, addedPermissions, grantItems, permissionLines, permissionsDigest, permissionsValid, parseNetPermissions } from '../modules/permissions/registry';
import { validManifest } from '../modules/schemas';
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
ok('подтверждают человек: чтение, подключения, интернет, сеть; справочные строки — нет', PERMISSION_KINDS.filter(k => k.consent).map(k => k.id).join() === 'reads,connections,internet,lan');
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
ok('два разных текста одного вида допустимы', parseNetPermissions([{ kind: 'internet', does: NET }, { kind: 'internet', does: 'Скачивает обновления справочника цен' }])?.length === 2);

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

console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${passed})`);
