/**
 * Обход разделов живым браузером.
 *
 * Зачем это в наборе проверок. Внешний аудит 18.09.2026 составил 125 сценариев
 * приёмки и НЕ ВЫПОЛНИЛ ни одного: браузер аудитора отвечал
 * `ERR_BLOCKED_BY_CLIENT`, и весь раздел «интерфейс» остался со статусом
 * «не запускалось». Отчёт при этом прямо требует, чем считается доказательство
 * визуальной проверки: кадр «до» и «после», ширина и высота именно
 * `[data-window-body]`, тема, активный `windowId`, шаги и фактический
 * результат.
 *
 * Здесь ровно это и делается: программа поднимается по-настоящему, разделы
 * открываются из Пуска, как их открывает человек, и на каждый сценарий
 * записывается либо наблюдение, либо честное «в этом контейнере не
 * проверяется» с причиной. Придумывать пройденные сценарии нельзя: смысл
 * набора в том, что статус соответствует тому, что было на экране.
 *
 * Запуск: npx tsx scripts/walkthrough.ts [Раздел ...]
 * Нужен поднятый стенд (`npm run dev`) и Chromium из PLAYWRIGHT_BROWSERS_PATH.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SECTIONS } from './walkthroughSections';

const BASE = process.env.FLUX_BASE || 'http://localhost:3000';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = process.env.FLUX_FRAMES || resolve('.walkthrough');
const USER = process.env.FLUX_USER || 'RaupovKhKh';
const PASS = process.env.FLUX_PASS || '1122';

/** Чем кончился сценарий. «Не проверено» обязано назвать причину. */
export type Verdict = 'ПРОЙДЕН' | 'НЕ ПРОЙДЕН' | 'НЕ ПРОВЕРЕНО';

export interface Step {
  id: string;
  verdict: Verdict;
  /** Что именно делали и что вышло — словами, а не «ок» */
  note: string;
  frames?: string[];
}

export interface Obstacle {
  /** Что мешает: нет Windows, нет принтера, нет второго человека */
  what: string;
  scenarios: string[];
}

let page: any = null;
let browser: any = null;
const results: Step[] = [];

const say = (s: string) => console.log(s);

/** Кадр в папку обхода; имя возвращается для отчёта. */
async function frame(name: string): Promise<string> {
  const file = `${name}.png`;
  await page.screenshot({ path: `${OUT}/${file}` });
  return file;
}

/** Обстановка, которую требует §6 отчёта. */
async function scene(): Promise<{ w: number; h: number; theme: string; win: string; title: string }> {
  // Активное окно — верхнее из видимых: их бывает несколько, и мерить надо то,
  // в котором человек сейчас работает
  return await page.evaluate(`(() => {
    let top = null, z = -1;
    for (const w of document.querySelectorAll('[data-win]')) {
      if (getComputedStyle(w).display === 'none') continue;
      const n = Number(getComputedStyle(w).zIndex) || 0;
      if (n >= z) { z = n; top = w; }
    }
    const body = top ? top.querySelector('[data-window-body]') : null;
    const r = body ? body.getBoundingClientRect() : null;
    return {
      w: r ? Math.round(r.width) : 0,
      h: r ? Math.round(r.height) : 0,
      theme: document.documentElement.classList.contains('dark') ? 'тёмная' : 'светлая',
      win: top ? (top.getAttribute('data-win') || '') : '',
      title: top ? (top.getAttribute('aria-label') || '') : '',
    };
  })()`);
}

function step(id: string, verdict: Verdict, note: string, frames?: string[]) {
  results.push({ id, verdict, note, frames });
  const mark = verdict === 'ПРОЙДЕН' ? '✓' : verdict === 'НЕ ПРОЙДЕН' ? '✗' : '·';
  say(`  ${mark} ${id} ${note}`);
}

/** Текст окна без разметки — по нему и судим, что человек видит. */
async function windowText(): Promise<string> {
  return await page.evaluate(`(() => {
    let top = null, z = -1;
    for (const w of document.querySelectorAll('[data-win]')) {
      if (getComputedStyle(w).display === 'none') continue;
      const n = Number(getComputedStyle(w).zIndex) || 0;
      if (n >= z) { z = n; top = w; }
    }
    const b = top ? top.querySelector('[data-window-body]') : null;
    return (b ? b.innerText : document.body.innerText).replace(/\\s+/g, ' ').trim();
  })()`);
}

async function login() {
  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'walkthrough', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input', { timeout: 40000 });
  await page.waitForTimeout(1500);
  const inputs = await page.$$('input');
  await inputs[0].fill(USER);
  await inputs[1].fill(PASS);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(8000);
}

/** Закрыть всё лишнее: каждый раздел начинается с чистого стола. */
async function closeAll() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.evaluate(`(() => {
    for (const b of document.querySelectorAll('[data-win] button[aria-label="Закрыть"]')) b.click();
  })()`);
  await page.waitForTimeout(1200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/**
 * Открыть раздел так, как открывает человек: Пуском, а не адресом. Адрес в
 * этой оболочке раздел не открывает вовсе — окна заводит сама оболочка.
 */
async function openSection(title: string): Promise<boolean> {
  const start = await page.$('button[aria-label="Пуск"]');
  if (!start) return false;
  await start.click();
  await page.waitForTimeout(1200);

  // Главная и Настройки живут в подвале меню, а не плитками: они не про выбор
  // области данных, а про саму программу
  const FOOT: Record<string, string> = {
    'Главная': 'Главная — сводка по проекту',
    'Настройки': 'Параметры программы',
  };
  if (FOOT[title]) {
    const b = await page.$(`[role="dialog"][aria-label="Пуск"] button[title="${FOOT[title]}"]`);
    if (!b) { await page.keyboard.press('Escape'); return false; }
    await b.click();
    await page.waitForTimeout(6000);
    return true;
  }

  const items = await page.$$(`button:has-text("${title}")`);
  for (const it of items) {
    const t = (await it.innerText()).trim();
    if (t === title || t.startsWith(title)) {
      await it.click();
      await page.waitForTimeout(6000);
      return true;
    }
  }
  await page.keyboard.press('Escape');
  return false;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const pw: any = await import(resolve('node_modules/playwright-core/index.js'));
  const chromium = pw.chromium || pw.default?.chromium;
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const crashes: string[] = [];
  page.on('pageerror', (e: any) => crashes.push(String(e.message).slice(0, 200)));

  await login();
  say('вошли');

  // Проект выбираем один раз на весь обход: разделы проектной области без него
  // честно показывают «Сначала выберите проект», и проверять в них нечего
  await openSection('Теги');
  await page.waitForTimeout(2500);
  const pick = await page.$$('[data-win] button');
  for (const b of pick) {
    const t = (await b.innerText().catch(() => '')).trim();
    if (/^Технологический проект/.test(t)) { await b.click(); await page.waitForTimeout(4000); break; }
  }
  say('проект выбран: ' + (await page.evaluate(`(() => {
    const el = [...document.querySelectorAll('footer *, [data-win] *')]
      .find((e) => e.children.length === 0 && /Технологический проект/.test(e.textContent || ''));
    return el ? el.textContent.trim() : 'не видно';
  })()`)));

  const only = process.argv.slice(2);
  for (const s of SECTIONS) {
    if (only.length && !only.includes(s.title)) continue;
    say(`\n${s.title}`);
    await closeAll();
    crashes.length = 0;
    try {
      await s.run({ page, frame, scene, step, windowText, openSection, closeAll, crashes });
    } catch (e: any) {
      step(`${s.title}: обход`, 'НЕ ПРОЙДЕН', `обход прерван: ${String(e?.message || e).slice(0, 160)}`);
    }
  }

  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  const bad = results.filter((r) => r.verdict === 'НЕ ПРОЙДЕН').length;
  const skip = results.filter((r) => r.verdict === 'НЕ ПРОВЕРЕНО').length;
  say(`\nИтог: ${results.length - bad - skip} пройдено, ${bad} не пройдено, ${skip} не проверялось`);
  say(`Кадры и results.json — ${OUT}`);
  await browser.close();
}

main();
