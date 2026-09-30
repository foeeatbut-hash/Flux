/**
 * Защитные правила без поднятого сервера: CORS, раздача файлов сборки,
 * подписанные ссылки, лимит входа, пароль базы в ответах, адрес прослушивания,
 * мост окна и запуск файлов из программы.
 */
import {
  corsOriginAllowed, isPrivateBuildFile, setLinkSecret, signLink, linkValid,
  loginWait, loginFailed, loginSucceeded, resetLoginLimits,
  maskDbUrl, unmaskDbUrl, DB_PASSWORD_MASK, listenHost, accountRefusal,
} from '../server/security';
import { isRunnableFile } from '../electron/runnable';
import { INVOKE_CHANNELS, SEND_CHANNELS } from '../electron/ipcAllow';
import fs from 'fs';
import path from 'path';

let ok = 0, fail = 0;
const eq = (name: string, got: any, want: any) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (pass) ok++; else { fail++; console.log(`✗ ${name}\n   получено: ${JSON.stringify(got)}\n   ожидалось: ${JSON.stringify(want)}`); }
};

// ── CORS ──
eq('запрос не из браузера пропускается', corsOriginAllowed(undefined, 'srv:3000'), true);
eq('окно программы из файла (Origin: null) пропускается', corsOriginAllowed('null', 'srv:3000'), true);
eq('страница с самого сервера пропускается', corsOriginAllowed('http://srv:3000', 'srv:3000'), true);
eq('localhost пропускается', corsOriginAllowed('http://localhost:5173', 'srv:3000'), true);
eq('чужой сайт не пропускается', corsOriginAllowed('https://evil.example', 'srv:3000'), false);
eq('похожий на свой, но другой порт — чужой', corsOriginAllowed('http://srv:4000', 'srv:3000'), false);
eq('странная схема не пропускается', corsOriginAllowed('chrome-extension://abc', 'srv:3000'), false);

// ── Файлы сборки ──
eq('server.cjs не раздаётся', isPrivateBuildFile('/server.cjs'), true);
eq('карта исходников не раздаётся', isPrivateBuildFile('/server.cjs.map'), true);
eq('любые .map не раздаются', isPrivateBuildFile('/assets/index-abc.js.map'), true);
eq('закодированное имя тоже ловится', isPrivateBuildFile('/server%2Ecjs'), true);
eq('скрытые файлы не раздаются', isPrivateBuildFile('/.env'), true);
eq('обычный бандл окна раздаётся', isPrivateBuildFile('/assets/index-abc.js'), false);
eq('index.html раздаётся', isPrivateBuildFile('/index.html'), false);

// ── Подписанные ссылки ──
setLinkSecret('проверочный-секрет');
const now = 1_800_000_000_000;
const link = signLink('/chat_files/abc/file.pdf', now);
const s = new URL('http://x' + link).searchParams.get('s');
eq('свежая ссылка действует', linkValid('/chat_files/abc/file.pdf', s, now + 1000), true);
eq('ссылка не подходит к другому файлу', linkValid('/chat_files/xyz/file.pdf', s, now + 1000), false);
eq('через 11 минут ссылка не действует', linkValid('/chat_files/abc/file.pdf', s, now + 11 * 60 * 1000), false);
eq('подделанная подпись не действует', linkValid('/chat_files/abc/file.pdf', `${now + 60000}.AAAA`, now), false);
eq('ссылка «на год вперёд» не действует', linkValid('/chat_files/abc/file.pdf', `${now + 365 * 864e5}.x`, now), false);
setLinkSecret('другой-секрет');
eq('после смены секрета старая ссылка не действует', linkValid('/chat_files/abc/file.pdf', s, now + 1000), false);

// ── Лимит входа ──
resetLoginLimits();
const t0 = 1_900_000_000_000;
for (let i = 0; i < 4; i++) loginFailed('Ivanov', '10.0.0.5', t0);
eq('четыре промаха — ещё без паузы', loginWait('Ivanov', '10.0.0.5', t0), 0);
loginFailed('Ivanov', '10.0.0.5', t0);
eq('пятый промах — пауза', loginWait('Ivanov', '10.0.0.5', t0) > 0, true);
eq('логин не чувствителен к регистру и в счёте', loginWait('IVANOV', '10.0.0.9', t0) > 0, true);
eq('другой логин с другого адреса не задет', loginWait('Petrov', '10.0.0.9', t0), 0);
loginFailed('Ivanov', '10.0.0.5', t0 + 61_000);
eq('пауза растёт с каждым промахом', loginWait('Ivanov', '10.0.0.5', t0 + 61_000) > 61_000, true);
loginSucceeded('Ivanov');
eq('удачный вход снимает счёт по логину', loginWait('Ivanov', '10.0.0.7', t0 + 61_000), 0);
resetLoginLimits();
for (let i = 0; i < 20; i++) loginFailed(`user${i}`, '10.0.0.66', t0);
eq('перебор разных логинов с одного адреса тоже тормозится', loginWait('someone', '10.0.0.66', t0) > 0, true);
resetLoginLimits();

// ── Пароль базы ──
const url = 'postgresql://flux:S3cret%21@db.local:5432/flux?schema=public';
const masked = maskDbUrl(url);
eq('пароль базы в ответе скрыт', masked.includes('S3cret'), false);
eq('звёздочки на месте пароля', decodeURIComponent(new URL(masked).password), DB_PASSWORD_MASK);
eq('звёздочки при том же адресе возвращают сохранённый пароль', unmaskDbUrl(masked, url), url);
const moved = masked.replace('db.local', 'evil.example');
eq('звёздочки на другой адрес пароль не уносят', unmaskDbUrl(moved, url).includes('S3cret'), false);
eq('новый пароль, введённый человеком, остаётся его', unmaskDbUrl(url.replace('S3cret%21', 'new'), url).includes(':new@'), true);
eq('адрес без пароля не меняется', maskDbUrl('mysql://u@h/db'), 'mysql://u@h/db');

// ── Адрес прослушивания ──
eq('встроенный сервер слушает только себя', listenHost({ FLUX_EMBEDDED: '1' }), '127.0.0.1');
eq('сервер компании слушает сеть', listenHost({}), '0.0.0.0');
eq('явная настройка сильнее', listenHost({ FLUX_EMBEDDED: '1', FLUX_LISTEN_HOST: '10.0.0.2' }), '10.0.0.2');

// ── Мост окна и запуск файлов ──
eq('exe не запускается из программы', isRunnableFile('счёт.exe'), true);
eq('хвостовая точка не прячет exe', isRunnableFile('счёт.exe. '), true);
eq('регистр не прячет bat', isRunnableFile('run.BAT'), true);
eq('ярлык не запускается', isRunnableFile('документ.lnk'), true);
eq('pdf открывается', isRunnableFile('чертёж.pdf'), false);
eq('xlsx открывается', isRunnableFile('ведомость.xlsx'), false);
eq('запись и запуск файла не в общем мосту', INVOKE_CHANNELS.has('files:open-external'), false);
eq('скачивание обновления не в общем мосту', INVOKE_CHANNELS.has('updater:start-download'), false);
eq('установка игр не в общем мосту', INVOKE_CHANNELS.has('games:install'), false);
eq('лицензия через общий мост есть', INVOKE_CHANNELS.has('license:status'), true);

// Каждый канал, который окно зовёт через общий мост, должен быть в списке —
// иначе функция молча сломается в собранной программе
const root = path.join(__dirname, '..', 'src');
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []);
const used = new Set<string>();
for (const f of walk(root)) {
  const text = fs.readFileSync(f, 'utf-8');
  for (const m of text.matchAll(/ipcRenderer\??\.(invoke|send)\(\s*['"`]([a-z-]+:[a-zA-Z:-]+)['"`]/g)) used.add(`${m[1]} ${m[2]}`);
  for (const m of text.matchAll(/\bask\(\s*['"`](feedback:[a-z-]+)['"`]/g)) used.add(`invoke ${m[1]}`);
}
const missing = [...used].filter((u) => {
  const [kind, ch] = u.split(' ');
  return kind === 'invoke' ? !INVOKE_CHANNELS.has(ch) : !SEND_CHANNELS.has(ch);
});
eq('все каналы, которые зовёт окно, разрешены в мосту', missing, []);

// ── Сокеты и отключённые профили ──
eq('рабочий профиль пропускается', accountRefusal({ isActive: true }), '');
eq('отключённый профиль не пропускается', !!accountRefusal({ isActive: false }), true);
eq('удалённый профиль не пропускается', !!accountRefusal(null), true);
eq('просроченный профиль не пропускается', !!accountRefusal({ validUntil: '2000-01-01' }), true);

// ── Цитата письма ──
const compose = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'mailCompose.ts'), 'utf-8');
eq('имя отправителя в цитате экранируется', /escapeHtml\(src\.fromName\)/.test(compose), true);

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
