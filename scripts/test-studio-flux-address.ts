/**
 * Адрес общей базы у лежащего рядом Flux (studio/shared/fluxAddress.ts).
 *
 * Что доказывается: Studio находит папку данных Flux на Windows, macOS и Linux по тем же правилам, что сам Flux;
 * берёт адрес только из общей (REMOTE) базы и только такой, какой умеет подключать; в описании для окна
 * и в причинах отказа пароля нет; локальная база, пустой адрес, битый файл и чужая СУБД дают причину словами;
 * чтение идёт с настоящего диска и ничего не пишет.
 *
 * Запуск: npx tsx scripts/test-studio-flux-address.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeDatabase, findFluxAddress, fluxDataDirs, parseFluxConfig } from '../studio/shared/fluxAddress';
import { parseDatabaseUri } from '../studio/shared/database-runtime.cjs';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const accept = (uri: string) => parseDatabaseUri(uri).uri;
const SECRET = 'Пар0ль-секрет';
const URI = `mysql://flux:${encodeURIComponent(SECRET)}@db.local:3307/Flux`;
const config = (extra: Record<string, unknown>) => JSON.stringify({ current_db_type: 'REMOTE', database_url: URI, ...extra });

console.log('Где лежат настройки Flux');
ok('Windows: APPDATA\\pdm-app', fluxDataDirs({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a')[0] === 'C:\\Users\\a\\AppData\\Roaming\\pdm-app');
ok('Linux: ~/.config/pdm-app', fluxDataDirs({}, 'linux', '/home/a')[0] === '/home/a/.config/pdm-app');
ok('macOS: Application Support/pdm-app', fluxDataDirs({}, 'darwin', '/Users/a')[0] === '/Users/a/Library/Application Support/pdm-app');
ok('запасная папка ~/pdm-app — как у Flux', fluxDataDirs({}, 'linux', '/home/a').includes('/home/a/pdm-app'));

console.log('Разбор настроек');
const good = parseFluxConfig(config({}), accept, 'x');
ok('общая база MariaDB найдена', good.found && good.uri.startsWith('mysql://') && good.source === 'x');
ok('описание без пароля: сервер, порт и база', good.display === 'MariaDB / MySQL · db.local:3307/Flux' && !good.display.includes(SECRET));
ok('описание не падает на мусоре', describeDatabase('не адрес') === '');
const refusals: Array<[string, string, RegExp]> = [
  ['локальная база', JSON.stringify({ current_db_type: 'LOCAL', database_url: '' }), /локальной базой/],
  ['пустой адрес', JSON.stringify({ current_db_type: 'REMOTE', database_url: '' }), /не указан/],
  ['чужая СУБД', JSON.stringify({ current_db_type: 'REMOTE', database_url: `postgresql://u:${SECRET}@h:5432/d` }), /mysql:\/\/|mariadb:\/\//],
  ['без пароля', JSON.stringify({ current_db_type: 'REMOTE', database_url: 'mysql://u@h/d' }), /пользователь|пароль/],
  ['битый JSON', '{не json', /не читается/],
  ['не объект', '[1]', /не читается/],
];
for (const [name, text, reason] of refusals) {
  const r = parseFluxConfig(text, accept);
  ok(`${name}: причина словами, пароля нет`, !r.found && r.uri === '' && reason.test(r.reason) && !r.reason.includes(SECRET) && !r.display);
}

console.log('Поиск по папкам');
const files: Record<string, string> = {};
const search = (env: Record<string, string>, platform = 'linux', home = '/home/a') => findFluxAddress({ env, platform, home, read: f => (f in files ? files[f] : null), accept });
ok('файла нет нигде — причина «введите вручную»', (() => { const r = search({}); return !r.found && /введите адрес/.test(r.reason); })());
files['/home/a/pdm-app/config.json'] = config({});
ok('запасная папка находится', search({}).found);
files['/home/a/.config/pdm-app/config.json'] = JSON.stringify({ current_db_type: 'LOCAL' });
ok('основная папка главнее: есть файл без адреса — дальше не ищем', (() => { const r = search({}); return !r.found && /локальной/.test(r.reason) && r.source === '/home/a/.config/pdm-app/config.json'; })());
ok('ошибка чтения не роняет поиск', !findFluxAddress({ env: {}, platform: 'linux', home: '/h', read: () => { throw new Error('нет прав'); }, accept }).found);

console.log('Настоящий диск');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-address-'));
const dir = path.join(home, '.config', 'pdm-app');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'config.json'), config({}));
const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
const real = findFluxAddress({ env: {}, platform: 'linux', home, read: f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }, accept });
ok('адрес прочитан с диска', real.found && real.display.includes('db.local:3307/Flux'));
ok('файл настроек Flux не изменён', fs.readFileSync(path.join(dir, 'config.json'), 'utf8') === before && fs.readdirSync(dir).join() === 'config.json');
fs.rmSync(home, { recursive: true, force: true });

console.log(`\nПройдено: ${passed}`);
