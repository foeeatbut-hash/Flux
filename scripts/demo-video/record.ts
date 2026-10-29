/**
 * Презентационное видео Flux: настоящая программа в Chromium, видимый курсор,
 * подписи шагов. Только основной путь: база -> теги -> документы и выгрузки.
 *
 * Запуск одной командой: scripts/demo-video/run.sh (или npx tsx этого файла).
 * Сервер поднимается на свежей папке данных, пользователь заводится напрямую
 * в базе, лицензия подменяется только ответом проверки — код программы не
 * трогается. После записи сервер гасится, webm переводится в H.264 mp4.
 *
 * Переменные: DEMO_OUT_DIR (куда класть mp4, лог и кадры),
 *             DEMO_PORT (по умолчанию 3187; 3000 занят рабочими серверами),
 *             DEMO_FAST=1 (черновой прогон: короткие паузы, без видео).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { VALVE_SHEET } from '../fixtures/blanks';
import { OVERLAY_SCRIPT } from './overlay';

const require = createRequire(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.DEMO_PORT || 3187);
const BASE = `http://127.0.0.1:${PORT}`;
const FAST = process.env.DEMO_FAST === '1';
const F = FAST ? 0.12 : 1; // масштаб всех пауз
const OUT_DIR = process.env.DEMO_OUT_DIR || path.join(os.tmpdir(), 'flux-demo-out');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-demo-'));
const LOGIN = 'ivanov';
const PASSWORD = 'Flux2026!';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log('[demo]', ...a);

// ───────────────────────── сервер ─────────────────────────

let server: ChildProcess | null = null;

async function startServer(dataDir: string) {
  const env = {
    ...process.env,
    VENT_APP_DATA: dataDir, PORT: String(PORT), FLUX_LISTEN_HOST: '127.0.0.1',
    FLUX_TEST_LICENSE: '1', FLUX_TEST_LICENSE_AUTO: '1', NODE_ENV: 'test', DISABLE_HMR: 'true',
  };
  const out = fs.openSync(path.join(WORK, 'server.log'), 'w');
  server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: ROOT, env, stdio: ['ignore', out, out] });
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* сервер ещё поднимается */ }
    if (server.exitCode !== null) throw new Error('Сервер завершился при запуске, см. ' + path.join(WORK, 'server.log'));
    await sleep(2000);
  }
  throw new Error('Сервер не ответил за 180 с');
}

async function stopServer() {
  const s = server; server = null;
  if (!s || s.exitCode !== null) return;
  s.kill('SIGTERM');
  await Promise.race([new Promise<void>((r) => s.once('exit', () => r())), sleep(8000)]);
  if (s.exitCode === null) s.kill('SIGKILL');
  // Порт освобождается не мгновенно: следующий запуск не должен упереться в него
  for (let i = 0; i < 20; i++) {
    try { await fetch(`${BASE}/api/health`); await sleep(500); } catch { return; }
  }
}

function seedUser(dataDir: string) {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(dataDir, 'database.sqlite'));
  const salt = crypto.randomBytes(16);
  const hash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync(PASSWORD, salt, 64).toString('hex')}`;
  db.prepare('INSERT INTO User (id, symbol, password, name, lastName, firstName, middleName, role, isActive, createdAt) VALUES (?,?,?,?,?,?,?,?,1,?)')
    .run('demo_user', LOGIN, hash, 'Иванов Иван Иванович', 'Иванов', 'Иван', 'Иванович', 'ADMIN', new Date().toISOString());
  db.close();
}

// ───────────────────────── исходные файлы ─────────────────────────

/** Лист технических данных на клапаны: тот же бланк, что в корпусе проверок, с данными объекта */
async function makeValveXlsx(file: string) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Бланк');
  const subst: Record<string, string> = {
    'Объект': 'ЖК «Северный», корпус 2', 'Заказчик': 'ООО «Северный квартал»', 'Исполнитель': 'ООО «ВентМонтаж»',
  };
  for (const b of VALVE_SHEET.blocks as any[]) {
    if (b.kind === 'para') ws.addRow([b.text]);
    else for (const row of b.rows as string[][]) {
      const r = [...row];
      for (const [k, v] of Object.entries(subst)) {
        const i = r.indexOf(k);
        if (i >= 0 && i + 1 < r.length && r[i + 1] && !/[:：]/.test(r[i + 1])) r[i + 1] = v;
      }
      ws.addRow(r);
    }
    ws.addRow([]);
  }
  ws.columns.forEach((c) => { c.width = 26; });
  await wb.xlsx.writeFile(file);
}

// ───────────────────────── браузер и оверлей ─────────────────────────

let page: any;
const marks: { n: string; title: string; t: number }[] = [];
let videoT0 = 0;
let capStarted = 0;
let capNeed = 0;
const consoleLog: string[] = [];

const ev = (fn: string, ...args: unknown[]) => page.evaluate(`(a => window.__demo.${fn}(...a))(${JSON.stringify(args)})`);

/** Черновой прогон: снимок экрана перед каждой сменой подписи, чтобы смотреть глазами */
async function snap(tag = '') {
  if (!FAST) return;
  const d = path.join(OUT_DIR, 'dbg'); fs.mkdirSync(d, { recursive: true });
  await page.screenshot({ path: path.join(d, `${String(marks.length).padStart(2, '0')}${tag}.png`) }).catch(() => {});
}

/** Пауза на чтение подписи: ~55 мс на символ, не меньше 3 с */
async function readPause() {
  const left = capNeed * F - (Date.now() - capStarted);
  if (left > 0) await sleep(left);
  capNeed = 0;
}

async function caption(n: string, title: string, text: string, pos: 'bot' | 'top' = 'bot') {
  await readPause();
  await snap();
  await ev('caption', n, title, text, pos);
  capStarted = Date.now();
  capNeed = Math.max(3000, 55 * (title.length + text.length));
  marks.push({ n, title, t: (Date.now() - videoT0) / 1000 });
  log(`${n}. ${title}`);
}

const MOVE = Math.max(120, Math.round(650 * F));

async function pointAt(loc: any, hl = true) {
  await loc.waitFor({ state: 'visible', timeout: 20000 });
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const b = await loc.boundingBox();
  if (!b) throw new Error('нет рамки у элемента');
  const x = Math.round(b.x + Math.min(b.width / 2, 260)), y = Math.round(b.y + b.height / 2);
  await ev('avoid', b);
  if (hl) await ev('highlight', b);
  await ev('move', x, y, MOVE);
  await sleep(MOVE + 120 * F);
  await page.mouse.move(x, y);
  return { x, y, b };
}

async function clickOn(loc: any, opts: { hl?: boolean; after?: number } = {}) {
  const { x, y } = await pointAt(loc, opts.hl !== false);
  await sleep(250 * F);
  await ev('click', x, y);
  await page.mouse.click(x, y);
  await sleep(300 * F);
  await ev('highlight', null);
  await sleep((opts.after ?? 500) * F);
}

/** Показать на элемент, не нажимая: курсор подъезжает, рамка горит */
async function showEl(loc: any, hold = 1800) {
  await pointAt(loc, true);
  await sleep(hold * F);
  await ev('highlight', null);
}

async function typeIn(loc: any, text: string, delay = 60) {
  await clickOn(loc, { after: 150 });
  await page.keyboard.type(text, { delay: Math.max(4, delay * F) });
  await sleep(350 * F);
}

const closeWindows = async () => {
  await page.evaluate(`(() => { for (const b of document.querySelectorAll('[data-win] button[aria-label="Закрыть"]')) b.click(); })()`);
  await sleep(700 * F);
};

const maximize = async () => {
  await sleep(500 * F);
  await page.evaluate(`(() => { const b = document.querySelector('[data-win] button[aria-label="Развернуть"]'); if (b) b.click(); })()`);
  await sleep(700 * F);
};

const startBtn = () => page.locator('button[aria-label="Пуск"]');
const startMenu = () => page.locator('[role="dialog"][aria-label="Пуск"]');
const tile = (name: string) => startMenu().locator('button').filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) }).last();

/** Раздел открывается так, как открывает человек: Пуск, плитка */
async function openSection(name: string) {
  await closeWindows();
  await clickOn(startBtn(), { after: 600 });
  await clickOn(tile(name), { after: 300 });
  await page.waitForSelector('[data-win]', { timeout: 20000 });
  await maximize();
  await windowReady();
}

/** Раздел подгружается лениво: ждём, пока в окне появится содержимое, а не крутилка */
async function windowReady() {
  await page.waitForFunction(`(() => { const w = [...document.querySelectorAll('[data-win]')].pop(); return !!w && w.innerText.length > 120; })()`, null, { timeout: 15000 }).catch(() => {});
  await sleep(500 * F);
}

const win = () => page.locator('[data-win]').last();
const btn = (text: string | RegExp, root: any = page) =>
  root.locator('button').filter({ hasText: typeof text === 'string' ? new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) : text });

function convert(webm: string, mp4: string, startSec: number) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', startSec.toFixed(2), '-i', webm,
    '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', '-an', mp4], { stdio: 'inherit' });
}

const slideHtml = (title: string, sub: string, bullets: string[] = []) =>
  `<div class="logo"><div class="mark">F</div></div><h1>${title}</h1><h2>${sub}</h2>` +
  (bullets.length ? `<ul>${bullets.map((b) => `<li><span>${b}</span></li>`).join('')}</ul>` : '');

// ───────────────────────── сценарий ─────────────────────────

async function scenario(files: { valves: string }) {
  // 0. Заставка
  await ev('showSlide', slideHtml('Flux — единая база проекта', 'От исходных данных до готовых документов — в одном месте'));
  marks.push({ n: '0', title: 'Заставка', t: (Date.now() - videoT0) / 1000 });
  await sleep(7000 * F);
  await ev('hideSlide');
  await sleep(900 * F);

  // 1. Вход
  await caption('1', 'Вход в программу', 'Каждый сотрудник работает под своей учётной записью: права и история действий привязаны к человеку');
  await typeIn(page.locator('input[placeholder="Введите логин"]'), LOGIN);
  await typeIn(page.locator('input[placeholder="Введите пароль"]'), PASSWORD);
  await page.keyboard.press('Enter');
  await page.waitForSelector('button[aria-label="Пуск"]', { timeout: 40000 });
  await sleep(2500 * F);

  // 2. Пуск
  await caption('2', 'Все инструменты в одной программе', 'Проекты, справочник, каталог, оборудование, теги, спецификации, закупки — разделы одного меню');
  await clickOn(startBtn(), { after: 700 });
  for (const name of ['Проекты', 'Справочник', 'Каталог', 'Оборудование', 'Теги', 'Конструктор', 'Менеджмент']) {
    await showEl(tile(name), 700);
  }

  // 3. Проекты
  await caption('3', 'Проект — общее пространство работы', 'Данные и документы привязаны к проекту, а доступ задаётся его участниками');
  await clickOn(tile('Проекты'), { after: 300 });
  await page.waitForSelector('[data-win]');
  await maximize();
  await windowReady();
  await clickOn(btn('Создать проект').first());
  await typeIn(page.locator('input[placeholder="Название проекта"]').last(), 'ЖК «Северный». Корпус 2 — вентиляция');
  const dash = page.locator('input[placeholder="—"]');
  const n = await dash.count();
  await typeIn(dash.nth(n - 3), 'SEV-K2');
  await typeIn(dash.nth(n - 2), 'ООО «Северный квартал»');
  await typeIn(dash.nth(n - 1), 'ООО «ВентМонтаж»');
  await clickOn(page.locator('[role="dialog"] button:text-is("Создать")'), { after: 1200 });
  await clickOn(btn('Потом'), { after: 800 });
  await clickOn(btn('Взять в работу'), { after: 1200 });
  await showEl(page.locator('text=Снять с работы').first(), 1500);

  // 4. Справочник
  await caption('4', 'Справочник правил', 'Общие правила создания тегов и маркировки хранятся в справочнике; базу можно загрузить из Excel');
  await openSection('Справочник');
  for (const tab of ['Маркировка', 'Пресеты подбора', 'Обозначения', 'Доп. параметры']) {
    await clickOn(win().locator('button').filter({ hasText: tab }).first(), { after: 900 });
  }
  await showEl(btn('Загрузить базу из Excel'), 2200);

  // 5. Каталог
  await caption('5', 'Каталог оборудования', 'Один каталог для всех проектов: модели, характеристики, исполнения, документация');
  await openSection('Каталог');
  await typeIn(page.locator('input[placeholder^="Код, модель"]'), 'КПУ');
  await clickOn(win().locator('text=КПУ-1Н').first(), { after: 1800 });
  for (const tab of ['Характеристики', 'Исполнения']) {
    const t = win().locator('button, [role="tab"]').filter({ hasText: new RegExp(`^\\s*${tab}`) }).first();
    if (await t.count()) await clickOn(t, { after: 1800 });
  }

  // 6. Оборудование: документы -> предпросмотр -> запись
  await caption('6', 'Исходные данные — из документов', 'Бланки, расчёты и таблицы загружаются в базу. Перед записью — предпросмотр: в базу попадает только проверенное');
  await openSection('Оборудование');
  await clickOn(btn('Загрузить документы'), { after: 900 });
  await clickOn(page.locator('button[aria-haspopup="listbox"]').filter({ hasText: 'Центральные' }), { after: 500 });
  await clickOn(page.locator('[role="option"]').filter({ hasText: 'Клапаны' }), { after: 600 });
  await showEl(page.locator('text=Выбрать файлы').first(), 1500);
  // Скрытое поле выбора файла у мастера — единственное с перечнем форматов документов
  await page.locator('input[type="file"][accept*=".xlsx"]').last().setInputFiles(files.valves);
  await page.waitForSelector('text=Проверить и импортировать', { timeout: 30000 });
  await sleep(1500 * F);
  await caption('6', 'Распознанный документ', 'Зелёное — уверенно, жёлтое — проверьте, серое — подпись не распознана; значения можно поправить вручную');
  await showEl(page.locator('text=температура эксплуатации').first(), 2500);
  await clickOn(page.locator('button:has-text("Проверить и импортировать")'), { after: 1500 });
  await caption('6', 'Предпросмотр импорта', 'База ещё не изменена: видно, что появится нового, что изменится, и какие теги будут заведены');
  await clickOn(page.locator('text=/КПУ-1Н-З-В-1000/').first(), { after: 1500 });
  await clickOn(btn(/Теги бланка/), { after: 2200 });
  await clickOn(btn(/к параметрам/), { after: 700 });
  await clickOn(btn(/^Импортировать \d+/), { after: 3500 });
  await page.keyboard.press('Escape');
  await sleep(900 * F);
  await clickOn(win().locator('button').filter({ hasText: /^Клапаны/ }).first(), { after: 1000 });
  await clickOn(win().locator('svg').first().locator('xpath=ancestor::button[1]').first().or(win().locator('[aria-expanded="false"]').first()), { after: 900 }).catch(() => {});
  await clickOn(win().locator('text=/КПУ-1Н-З-В-1000/').first(), { after: 2500 }).catch(() => {});

  // 7. Теги
  await caption('7', 'Теги проекта', 'Теги создаются по коду и марке, заводятся вручную, из документов или пачкой из таблицы');
  await openSection('Теги');
  const tagsToType: [string, string, string][] = [
    ['1000-A01-HU-001', 'ПРИТОК-500', 'Приточная установка П1'],
    ['1000-A01-HU-002', 'ПРИТОК-500', 'Приточная установка П2'],
    ['1000-B02-BL-001', 'ВЕНТ-630', 'Вытяжной вентилятор В1'],
  ];
  for (const [code, mark, name] of tagsToType) {
    await typeIn(page.locator('input[placeholder^="Код тега"]'), code);
    await typeIn(page.locator('input[placeholder^="Марка"]'), mark);
    await typeIn(page.locator('input[placeholder^="Наименование"]').first(), name);
    await clickOn(win().locator('button:text-is("Создать")'), { after: 1100 });
  }
  await clickOn(win().locator('button').filter({ hasText: 'Экспорт и импорт' }), { after: 800 });
  await caption('7', 'Пачкой из таблицы', 'Диапазон из Excel вставляется целиком; перед импортом видно, какая колонка чем станет');
  await clickOn(page.locator('text=Открыть мастер').first(), { after: 900 });
  await clickOn(btn(/Вставить из буфера/), { after: 700 });
  const tsv = ['Код тега\tМарка\tНаименование',
    '1000-A01-HU-003\tПРИТОК-300\tПриточная установка П3',
    '1000-B02-BL-002\tВЕНТ-630\tВытяжной вентилятор В2',
    '1000-B02-BL-003\tВЕНТ-800\tВытяжной вентилятор В3',
    '1000-B02-BL-004\tВЕНТ-800\tВытяжной вентилятор В4'].join('\n');
  await clickOn(page.locator('textarea'), { after: 300 });
  await page.fill('textarea', tsv); // вставка из буфера: одним действием, как Ctrl+V
  await sleep(1000 * F);
  await clickOn(btn('Разобрать'), { after: 1200 });
  await showEl(page.locator('select').first(), 2200);
  await clickOn(btn(/^Импортировать \(/), { after: 2500 });
  await page.keyboard.press('Escape');
  await sleep(600 * F);
  await clickOn(win().locator('button').filter({ hasText: 'Дерево связей' }), { after: 2500 });
  await caption('7', 'Подбор и выгрузка', 'Любую подборку тегов можно выгрузить в Excel: отбор по частям кода и марки, выбор колонок');
  await clickOn(win().locator('button').filter({ hasText: /^\s*Подбор/ }), { after: 1200 });
  await typeIn(page.locator('input[placeholder="Значение..."]').nth(1), 'B02');
  const dl1 = page.waitForEvent('download', { timeout: 20000 });
  await clickOn(btn('Экспортировать подборку в Excel'), { after: 300 });
  await dl1.catch(() => {});
  await sleep(2500 * F);

  // 8. Конструктор
  await caption('8', 'Спецификация из данных базы', 'Позиции привязываются к тегам и изделиям каталога — без копирования файлов между таблицами');
  await openSection('Конструктор');
  await clickOn(btn('Создать спецификацию').first(), { after: 700 });
  const nameInput = page.locator('[role="dialog"] input').first();
  await clickOn(nameInput, { after: 100 });
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Клапаны противопожарные, корпус 2', { delay: Math.max(4, 60 * F) });
  await clickOn(btn('Сохранить'), { after: 1500 });
  const addPos = async (tag: string, product: string, w: string, h: string) => {
    await clickOn(btn('Добавить позицию'), { after: 700 });
    await typeIn(page.locator('textarea').first(), tag);
    await clickOn(win().locator('button').filter({ hasText: product }).first(), { after: 900 });
    await clickOn(win().locator('button').filter({ hasText: /нормально закрытый/ }).first(), { after: 400 });
    const nums = page.locator('input[type="number"][min="0"]');
    await typeIn(nums.nth(0), w);
    await typeIn(nums.nth(1), h);
    await clickOn(btn('Сохранить'), { after: 1300 });
  };
  await addPos('1000-D01-DS-002', 'КПУ-1Н', '1000', '800');
  await addPos('1000-D01-DS-004', 'КПУ-2Н', '600', '400');
  await caption('8', 'Выпуск документов', 'Выпуск фиксирует ревизию, история выпусков хранится вместе со спецификацией');
  await clickOn(btn('Выпустить документы'), { after: 1500 });
  await typeIn(page.locator('label:has-text("Номер документа") + input, label:has-text("Номер документа") input').first(), 'ВК-СП-001');
  await typeIn(page.locator('label:has-text("Наименование документа") + input, label:has-text("Наименование документа") input').first(), 'Спецификация клапанов');
  const dlx = page.waitForEvent('download', { timeout: 20000 });
  await clickOn(btn('Excel'), { after: 300 });
  await dlx.catch(() => {});
  await sleep(2500 * F);
  const dlp = page.waitForEvent('download', { timeout: 30000 });
  await clickOn(btn('PDF'), { after: 300 });
  await dlp.catch(() => {});
  await sleep(2500 * F);
  await clickOn(btn(/^Выпустить ревизию/), { after: 2500 });
  await showEl(page.locator('text=Выпуски').first(), 2500);

  // 9. Менеджмент
  await caption('9', 'Закупки', 'Закупки работают с теми же позициями проекта — без пересылки таблиц между отделами');
  await openSection('Менеджмент');
  await clickOn(win().locator('button').filter({ hasText: /^\s*Закупки/ }).first(), { after: 1800 });
  const dlm = page.waitForEvent('download', { timeout: 20000 });
  await clickOn(btn('В Excel'), { after: 300 });
  await dlm.catch(() => {});
  await sleep(3000 * F);

  // 10. Главная
  await closeWindows();
  await caption('10', 'Главная: сводка по проекту', 'Проект, разделы и последние изменения — в одном окне; видно, кто, что и когда изменил');
  await clickOn(startBtn(), { after: 600 });
  await clickOn(startMenu().locator('button[title="Главная — сводка по проекту"]'), { after: 300 });
  await page.waitForSelector('[data-win]');
  await maximize();
  await windowReady();
  await sleep(2000 * F);
  await showEl(page.locator('text=Последние изменения').first(), 2500);

  // 11. Итог
  await readPause();
  await ev('hideCaption');
  await ev('showSlide', slideHtml('Flux', 'Что это даёт команде', [
    'Одна база вместо разрозненных файлов',
    'Данные всегда актуальны: все работают с одним источником',
    'Проверка перед записью',
    'Документы и выгрузки — в один клик',
    'Кто, что и когда изменил — видно',
  ]));
  marks.push({ n: '11', title: 'Итог', t: (Date.now() - videoT0) / 1000 });
  await sleep(8000 * F);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dataDir = path.join(WORK, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const valves = path.join(WORK, 'Klapany_korpus2.xlsx');
  await makeValveXlsx(valves);

  log('сервер на', BASE, 'данные', dataDir);
  await startServer(dataDir);
  seedUser(dataDir);

  const pw = require('playwright-core');
  const chromePath = [process.env.FLUX_CHROME, '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => p && fs.existsSync(p));
  const browser = await pw.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox', '--force-device-scale-factor=1'] });
  const videoDir = path.join(WORK, 'video');
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }, locale: 'ru-RU', acceptDownloads: true,
    ...(FAST ? {} : { recordVideo: { dir: videoDir, size: { width: 1920, height: 1080 } } }),
  });
  await context.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'DEMO', expiresAt: Date.now() + 9e8, daysLeft: 300, reason: '' }),
  }));
  await context.addInitScript(OVERLAY_SCRIPT);
  videoT0 = Date.now();
  page = await context.newPage();
  page.on('pageerror', (e: any) => consoleLog.push('PAGEERROR ' + String(e.message).slice(0, 400)));
  page.on('console', (m: any) => { if (m.type() === 'error') consoleLog.push('console.error ' + m.text().slice(0, 400)); });
  page.on('download', async (d: any) => {
    const name = d.suggestedFilename();
    log('выгрузка', name);
    await d.saveAs(path.join(WORK, 'downloads', name)).catch(() => {});
    await ev('toast', `Файл выгружен: ${name}`, 5000).catch(() => {});
  });
  fs.mkdirSync(path.join(WORK, 'downloads'), { recursive: true });

  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[placeholder="Введите логин"]', { timeout: 60000 });
    await sleep(1200);
    // Всё до этой секунды — загрузка страницы; в видео её нет
    const cutStart = (Date.now() - videoT0) / 1000;
    await scenario({ valves });
    await readPause();
    marks.push({ n: 'end', title: 'Конец', t: (Date.now() - videoT0) / 1000 });
    const video = FAST ? null : page.video();
    await context.close();
    if (video) {
      const webm = await video.path();
      const mp4 = path.join(OUT_DIR, 'flux-demo.mp4');
      convert(webm, mp4, cutStart - 0.1);
      const timeline = marks.map((m) => ({ ...m, t: Math.max(0, +(m.t - (cutStart - 0.1)).toFixed(1)) }));
      fs.writeFileSync(path.join(OUT_DIR, 'flux-demo-timeline.json'), JSON.stringify(timeline, null, 2));
      log('готово:', mp4);
    }
  } catch (e) {
    await snap('-fail');
    throw e;
  } finally {
    fs.writeFileSync(path.join(OUT_DIR, 'flux-demo-console.log'), consoleLog.join('\n') + '\n');
    await browser.close().catch(() => {});
    await stopServer();
  }
}

main().then(() => process.exit(0), async (e) => {
  console.error(e);
  try { await stopServer(); } catch { /* уже остановлен */ }
  process.exit(1);
});
