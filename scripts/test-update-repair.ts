import { testSignature } from './fixtures/updateTestSign';
import { ownerTestLogin } from './fixtures/ownerTestLogin';
/**
 * Таблица кусков, созданная НЕПОЛНОЙ, чинится сама — и файл доезжает до базы.
 *
 * Проверка написана по поломке, из-за которой обновления не работали вовсе.
 * Автомиграция общей базы не знала двоичного типа Prisma и молча пропускала
 * колонку с файлом: в MariaDB таблица `AppUpdateChunk` создавалась из трёх
 * колонок вместо четырёх. Дальше всё выглядело исправным — таблица есть, значит
 * подстраховка с созданием не срабатывает, — а вставка куска падала на «нет
 * такой колонки». Ошибка ловилась, превращалась в предупреждение, и получалось
 * худшее из возможного: запись о релизе у всех есть, файла в общей базе нет ни
 * у кого.
 *
 * Здесь это состояние воспроизводится буквально: таблица пересоздаётся без
 * колонки с данными, после чего администратор публикует релиз обычным путём.
 *
 * Запуск (нужен поднятый сервер на локальной базе):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-update-repair.ts
 */
import Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const DB = process.env.FLUX_DB || 'database/database.sqlite';
const VERSION = '999.9.5';

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

const updatesDir = (): string => {
  if (process.env.VENT_APP_DATA) return join(process.env.VENT_APP_DATA, 'updates');
  const base = process.env.APPDATA || join(homedir(), '.config');
  return join(base, 'pdm-app', 'updates');
};

(async () => {
  if (!existsSync(DB)) { console.error(`Базы ${DB} нет — проверка рассчитана на локальную базу.`); process.exit(2); }
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`);
    process.exit(2);
  }

  const token = (await ownerTestLogin(BASE)).token;
  if (!token) { console.error('Не удалось войти.'); process.exit(2); }

  console.log('1. Общая база в том самом состоянии: таблица есть, колонки с файлом нет');
  const db = new Database(DB);
  db.exec('DROP TABLE IF EXISTS "AppUpdateChunk"');
  db.exec('CREATE TABLE "AppUpdateChunk" ("id" TEXT NOT NULL, "version" TEXT NOT NULL, "idx" INTEGER NOT NULL, PRIMARY KEY ("id"))');
  const before = db.prepare('PRAGMA table_info("AppUpdateChunk")').all() as any[];
  ok('колонки с данными действительно нет', !before.some((c) => c.name === 'data'), before.map((c) => c.name));
  db.close();

  const size = 5 * 1024 * 1024;
  const fake = Buffer.alloc(size, 3);
  fake[0] = 0x4d; fake[1] = 0x5a;

  try {
    console.log('2. Владелец публикует релиз обычным путём');
    const up = await api(token, 'POST', `/api/updates/upload?version=${VERSION}`, undefined, fake);
    ok('загрузка не отказала', up.status === 200, up.json || up.status);
    // Главное: сервер не сделал вид, что всё хорошо, оставив файл на своём диске
    ok('файл дошёл до общей базы, а не остался на диске', up.json?.shared === true, up.json);

    const db2 = new Database(DB);
    const after = db2.prepare('PRAGMA table_info("AppUpdateChunk")').all() as any[];
    db2.close();
    ok('недостающая колонка добавлена самой программой',
      after.some((c) => c.name === 'data'), after.map((c) => c.name));

    console.log('3. Файл берётся из базы, как у любого сотрудника');
    const local = join(updatesDir(), `Flux-${VERSION}.exe`);
    if (existsSync(local)) unlinkSync(local);
    const published = await api(token, 'POST', '/api/updates', { version: VERSION, changelog: 'Проверка исправления таблицы', signature: testSignature(fake, VERSION) });
    ok('подписанный файл опубликован владельцем', published.status === 200, published.json);
    const check = await api(token, 'GET', `/api/updates/check/${VERSION}`);
    ok('сервер подтверждает: файл есть', check.json?.ok === true, check.json);
    ok('и размер совпадает с загруженным', Number(check.json?.size) === size, check.json?.size);

    const dl = await fetch(`${BASE}/api/updates/download/${VERSION}`, { headers: { Authorization: `Bearer ${token}` } });
    ok('файл отдан', dl.ok, dl.status);
    const got = Buffer.from(await dl.arrayBuffer());
    ok('байты совпали до единого', got.equals(fake), { ждали: size, получили: got.length });
  } finally {
    await api(token, 'DELETE', `/api/updates/${VERSION}`);
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nПроверка починки таблицы обновлений пройдена');
  process.exit(f ? 1 : 0);
})();
