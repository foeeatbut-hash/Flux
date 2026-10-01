import { testCredentials } from './testCredentials';
import { ownerTestLogin } from './fixtures/ownerTestLogin';
/**
 * Файл обновления доходит до сотрудника, а не только до того, кто публиковал.
 *
 * Проверка написана по поломке из отдела. Сервера приложения у них нет: общая
 * только база, а программа каждого сотрудника поднимает свой встроенный
 * сервер. Запись о релизе ложилась в общую базу — и все видели «доступна новая
 * версия»; а сам exe оставался на диске того, кто публиковал. Остальные
 * получали «файла этой версии нет» и не могли обновиться вовсе.
 *
 * Поэтому здесь проверяется ровно то, что было сломано: файл, загруженный
 * администратором, отдаётся ПОСЛЕ ТОГО, как его убрали с диска, — то есть
 * берётся из общей базы, как у любого другого сотрудника.
 *
 * Запуск (нужен поднятый сервер):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-update-share.ts
 */
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { testSignature } from './fixtures/updateTestSign';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = testCredentials();
const VERSION = '999.9.9';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 240) : ''));

const api = async (token: string, method: string, url: string, body?: any, raw?: Buffer) => {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null as any, text }; }
};

/** Папка данных сервера — там же, где он держит файлы обновлений */
const updatesDir = (): string => {
  if (process.env.VENT_APP_DATA) return join(process.env.VENT_APP_DATA, 'updates');
  const base = process.env.APPDATA || join(homedir(), '.config');
  return join(base, 'pdm-app', 'updates');
};

(async () => {
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`);
    process.exit(2);
  }

  const token = (await ownerTestLogin(BASE)).token;
  if (!token) { console.error('Не удалось войти.'); process.exit(2); }

  // Похожий на exe файл: с подписью MZ и достаточного размера — программа
  // проверяет и то и другое, прежде чем ставить обновление
  const size = 6 * 1024 * 1024;
  const fake = Buffer.alloc(size, 7);
  fake[0] = 0x4d; fake[1] = 0x5a;
  fake.write('ФАЙЛ-ИЗ-ОБЩЕЙ-БАЗЫ', size - 64, 'utf-8');

  try {
    console.log('1. Владелец публикует релиз');
    const up = await api(token, 'POST', `/api/updates/upload?version=${VERSION}`, undefined, fake);
    ok('файл загружен', up.status === 200, up.json || up.status);
    ok('файл ушёл в общую базу, а не только на диск', up.json?.shared === true, up.json);
    const pub = await api(token, 'POST', '/api/updates', {
      version: VERSION, changelog: 'Проверочный релиз', fileUrl: '',
      signature: testSignature(fake, VERSION),
    });
    ok('релиз записан', pub.status === 200, pub.json || pub.status);
    ok('ссылка ведёт на сервер, а не наружу',
      String(pub.json?.update?.fileUrl || '').startsWith('/api/updates/download/'), pub.json?.update?.fileUrl);

    console.log('2. У сотрудника файла на диске нет — и он всё равно скачивается');
    // Ровно положение обычного сотрудника: запись о релизе в общей базе есть,
    // файла на его машине нет
    const local = join(updatesDir(), `Flux-${VERSION}.exe`);
    if (existsSync(local)) unlinkSync(local);
    ok('файл с диска убран', !existsSync(local), local);

    const dl = await fetch(`${BASE}/api/updates/download/${VERSION}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ok('сервер отдал файл', dl.ok, dl.status);
    const got = Buffer.from(await dl.arrayBuffer());
    ok('размер совпал', got.length === size, { ждали: size, получили: got.length });
    ok('подпись программы на месте', got[0] === 0x4d && got[1] === 0x5a);
    ok('содержимое не перепутано кусками', got.includes('ФАЙЛ-ИЗ-ОБЩЕЙ-БАЗЫ'));
    ok('байты совпали до единого', got.equals(fake));
    ok('размер файла известен заранее — полосе загрузки есть от чего идти',
      Number(dl.headers.get('content-length') || 0) === size, dl.headers.get('content-length'));

    // Публикация без файла — то, из-за чего отдел просидел два выпуска без
    // обновлений: запись о релизе разошлась всем, файла не было ни у кого, и
    // убрать её было нечем
    console.log('3. Публикация без файла не выдаётся за обновление');
    const ghost = '999.9.8';
    const pubGhost = await api(token, 'POST', '/api/updates', {
      version: ghost, changelog: 'Релиз без файла', fileUrl: '',
    });
    ok('без файла и без ссылки релиз не записывается', pubGhost.status === 400, pubGhost.json || pubGhost.status);

    console.log('4. Номер версии проверяется до рассылки оповещения');
    const bad = await api(token, 'POST', '/api/updates', { version: '90', changelog: '', fileUrl: 'http://x/y.exe' });
    ok('«90» сервер не принимает', bad.status === 400, bad.json || bad.status);
    ok('и объясняет, как пишется версия', String(bad.json?.error || '').includes('0.90.0'), bad.json);

    console.log('4а. Без подписи владельца релиз не публикуется');
    const unsigned = await api(token, 'POST', '/api/updates', { version: VERSION, changelog: '', fileUrl: '' });
    ok('без подписи — отказ', unsigned.status === 400 && /подпись/i.test(String(unsigned.json?.error || '')), unsigned.json);
    const wrongFile = await api(token, 'POST', '/api/updates', {
      version: VERSION, changelog: '', fileUrl: '', signature: testSignature(Buffer.concat([fake, Buffer.from('x')]), VERSION),
    });
    ok('подпись другого файла — отказ', wrongFile.status === 400, wrongFile.json);

    console.log('5. Сервер отвечает, дошёл ли файл, не отдавая его целиком');
    const check = await api(token, 'GET', `/api/updates/check/${VERSION}`);
    ok('про загруженную версию сказано «есть»', check.json?.ok === true, check.json);
    ok('и назван размер', Number(check.json?.size) === size, check.json?.size);
    const missing = await api(token, 'GET', '/api/updates/check/999.9.7');
    ok('про незагруженную — «нет», с причиной',
      missing.json?.ok === false && String(missing.json?.why || '').length > 0, missing.json);
  } finally {
    await api(token, 'DELETE', `/api/updates/${VERSION}`);
    await api(token, 'DELETE', '/api/updates/999.9.8');
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nПроверка раздачи обновления пройдена');
  process.exit(f ? 1 : 0);
})();
