/**
 * Значок Flux Store в одном наборе со значками остальных программ.
 *
 * Значок рисуется в том же стиле: сетка 32×32, обводка #475569 толщиной 1–1,4, цвета только из тех, что уже есть у других
 * значков набора (см. AppIcons.tsx), размер по лестнице ICON_SIZE (панель задач, Пуск, стол). Проверка падает, если в
 * значок попал чужой цвет, нетипичная обводка или система цветов по теме.
 *
 * Снимки до/после для артефакта CI: STORE_ICON_SHOTS=<каталог> FLUX_CHROME=<chrome> [STORE_ICON_BEFORE=<файл AppIcons.tsx до правки>].
 *
 * Запуск: npx tsx scripts/test-store-icon.tsx
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppIcon, APP_ICON_BY_PATH } from '../src/components/icons/FluxIcons';
import { StoreAppIcon } from '../src/components/icons/AppIcons';
import { ICON_SIZE } from '../src/lib/metrics';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const colorsOf = (markup: string) => new Set((markup.match(/#[0-9a-fA-F]{6}\b/g) || []).map(c => c.toLowerCase()));
const widthsOf = (markup: string) => [...markup.matchAll(/stroke-width="([\d.]+)"/g)].map(m => Number(m[1]));

/** Что не так со значком; пустой список — значок в стиле набора */
function problems(markup: string, setColors: Set<string>): string[] {
  const out: string[] = [];
  if (!/viewBox="0 0 32 32"/.test(markup)) out.push('сетка не 32×32');
  for (const color of colorsOf(markup)) if (!setColors.has(color)) out.push(`цвет ${color} не из набора`);
  if (/currentColor|var\(--|class="[^"]*dark:/.test(markup)) out.push('цвет зависит от темы: значки набора одинаковы в обеих темах');
  for (const width of widthsOf(markup)) if (width < 0.9 || width > 1.5) out.push(`обводка ${width} вне 0,9–1,5`);
  if (!/stroke="#475569"/.test(markup)) out.push('нет основной обводки #475569');
  return out;
}

const others = Object.entries(APP_ICON_BY_PATH).filter(([p]) => p !== '/store');
const setColors = new Set<string>();
for (const [, Icon] of others) for (const color of colorsOf(renderToStaticMarkup(<Icon />))) setColors.add(color);

console.log('Значок Store в стиле набора');
const store = renderToStaticMarkup(<StoreAppIcon />);
ok('значок найден по адресу /store и это не заглушка «Программа»', renderToStaticMarkup(<AppIcon path="/store" />) === store && APP_ICON_BY_PATH['/store'] === StoreAppIcon);
ok('значок проходит стиль набора', problems(store, setColors).length === 0);
ok('все цвета значка уже есть у других значков набора', [...colorsOf(store)].every(c => setColors.has(c)));
ok('рисунок не из одной линии: заливок не меньше шести', (store.match(/fill="#/g) || []).length >= 6);
for (const [role, size] of [['панель задач', ICON_SIZE.taskbar], ['Пуск', ICON_SIZE.start], ['рабочий стол', ICON_SIZE.desktop]] as const) {
  ok(`размер ${role}: ${size} px`, new RegExp(`width="${size}" height="${size}"`).test(renderToStaticMarkup(<StoreAppIcon size={size} />)));
}
ok('в Пуске, на столе и панели задач значок тот же компонент по адресу раздела', [ICON_SIZE.taskbar, ICON_SIZE.start, ICON_SIZE.desktop].every(size => renderToStaticMarkup(<AppIcon path="/store" size={size} />).includes('viewBox="0 0 32 32"')));

console.log('Мутации: проверка стиля должна падать');
ok('чужой цвет', problems(store.replace('#10b981', '#ff00ff'), setColors).some(p => /не из набора/.test(p)));
ok('цвет по теме', problems(store.replace('#e9f1f7', 'currentColor'), setColors).some(p => /от темы/.test(p)));
ok('толстая обводка', problems(store.replace('stroke-width="1.25"', 'stroke-width="3"'), setColors).some(p => /вне/.test(p)));
ok('другая сетка', problems(store.replace('0 0 32 32', '0 0 24 24'), setColors).some(p => /сетка/.test(p)));
ok('нет основной обводки', problems(store.replaceAll('#475569', '#334155'), setColors).length > 0);

/** Снимки до и после для артефакта CI: оба значка рядом с соседями в размерах панели задач, Пуска и стола, обе темы */
async function shots() {
  const dir = process.env.STORE_ICON_SHOTS;
  if (!dir) return;
  const { chromium } = await import('playwright-core');
  fs.mkdirSync(dir, { recursive: true });
  const before = process.env.STORE_ICON_BEFORE;
  let BeforeIcon: React.ComponentType<{ size?: number }> | null = null;
  if (before) {
    // Прежний AppIcons.tsx кладётся рядом с настоящим, чтобы его относительные подключения сработали
    const copy = path.join(path.dirname(require.resolve('../src/components/icons/AppIcons')), '__AppIconsBefore.tsx');
    fs.copyFileSync(before, copy);
    try { BeforeIcon = (await import(copy)).StoreAppIcon; } finally { fs.rmSync(copy, { force: true }); }
  }
  const themes = { light: { bg: '#f8fafc', fg: '#0f172a', tile: '#ffffff', line: '#e2e8f0' }, dark: { bg: '#0f1412', fg: '#f1f5f9', tile: '#171d1a', line: '#2a322f' } };
  const neighbours = ['/catalog', '/explorer', '/settings', '/users'];
  const row = (title: string, size: number, which: 'before' | 'after') => `<div class="row"><span>${title}</span>${neighbours.slice(0, 2).map(p => `<div class="cell">${renderToStaticMarkup(<AppIcon path={p} size={size} />)}</div>`).join('')}<div class="cell me">${renderToStaticMarkup(which === 'before' && BeforeIcon ? <BeforeIcon size={size} /> : <StoreAppIcon size={size} />)}</div>${neighbours.slice(2).map(p => `<div class="cell">${renderToStaticMarkup(<AppIcon path={p} size={size} />)}</div>`).join('')}</div>`;
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME });
  for (const which of (BeforeIcon ? ['before', 'after'] : ['after']) as Array<'before' | 'after'>) {
    for (const [name, t] of Object.entries(themes)) {
      const page = await browser.newPage({ viewport: { width: 600, height: 380 }, deviceScaleFactor: 2 });
      const big = renderToStaticMarkup(which === 'before' && BeforeIcon ? <BeforeIcon size={128} /> : <StoreAppIcon size={128} />);
      await page.setContent(`<!doctype html><html><body style="margin:0;padding:16px;background:${t.bg};color:${t.fg};font:12px system-ui,sans-serif"><style>.row{display:flex;align-items:center;gap:12px;margin:0 0 12px}.row span{width:130px;color:#64748b}.cell{display:flex;align-items:center;justify-content:center;padding:8px;border-radius:8px;background:${t.tile};border:1px solid ${t.line}}.cell.me{outline:2px solid #10b981;outline-offset:1px}</style>
        <div class="row"><span>Store, 128</span>${big}</div>${row('Панель задач, 24', ICON_SIZE.taskbar, which)}${row('Пуск, 32', ICON_SIZE.start, which)}${row('Рабочий стол, 48', ICON_SIZE.desktop, which)}</body></html>`);
      await page.screenshot({ path: path.join(dir, `store-icon-${which}-${name}.png`) });
      await page.close();
    }
  }
  await browser.close();
  console.log(`  снимки значка: ${dir}`);
}

shots().then(() => console.log(`\nЗначок Store: ${passed} проверок пройдено`)).catch((error) => { console.error(error); process.exit(1); });
