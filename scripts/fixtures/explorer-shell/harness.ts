/**
 * Общее для браузерных проверок каркаса Проводника: запуск Chromium, страница
 * стенда с перехватом ошибок консоли, счётчик проверок, замер цвета и размеров.
 */
import type { Browser, Page } from 'playwright-core';

export const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
export const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';
export const SHOTS = process.env.EXPLORER_SHOTS || '';

export function checks() {
  let passed = 0, failed = 0;
  const ok = (name: string, value: boolean, detail?: unknown) => {
    if (value) { passed++; console.log('✓', name); }
    else { failed++; console.error('✗', name, detail === undefined ? '' : `— ${JSON.stringify(detail)}`); }
  };
  return { ok, done: () => { console.log(`\n${passed} проверок пройдено, ${failed} провалено`); return failed ? 1 : 0; } };
}

export async function launch(): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  return chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
}

/** Страница стенда: ошибки консоли и страницы копятся в `errors`, проверка в конце требует тишины */
export async function openStand(browser: Browser, file: string, query = '', size = { width: 1251, height: 1183 }): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: size });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`); });
  await page.goto(`${BASE}/scripts/fixtures/explorer-shell/${file}${query}`);
  return { page, errors };
}

export const shell = (theme: 'dark' | 'light', extra = '') => `?theme=${theme}${extra}`;

/** Прямоугольник и вычисленные стили элемента одним вызовом: числа, а не «похоже» */
export async function measure(page: Page, selector: string, nth = 0) {
  return page.locator(selector).nth(nth).evaluate((el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return { x: r.x, y: r.y, w: r.width, h: r.height, bg: cs.backgroundColor, color: cs.color, font: cs.fontSize, family: cs.fontFamily, weight: cs.fontWeight, borderRight: cs.borderRightColor };
  });
}

export const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;
export const near = (value: number, want: number, eps = 1) => Math.abs(value - want) <= eps;

/** Нажатие сочетания из таблицы клавиш: «Ctrl+Shift+Tab» → «Control+Shift+Tab», «Alt+←» → «Alt+ArrowLeft» */
export function chord(label: string): string {
  const names: Record<string, string> = { Ctrl: 'Control', '←': 'ArrowLeft', '→': 'ArrowRight', '↑': 'ArrowUp', '↓': 'ArrowDown' };
  return label.split('+').map((part) => names[part] ?? (part.length === 1 ? part.toLowerCase() : part)).join('+');
}
