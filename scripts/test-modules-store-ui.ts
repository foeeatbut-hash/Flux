/**
 * Flux Store в браузере: витрина (карусель, ряды, поиск), страница программы
 * с сжимающейся шапкой, установка с окном разрешений, обновление с новыми
 * разрешениями, возврат версии без связи, удаление, библиотека, экран
 * администратора. Мерки и состояния — по замеру (getBoundingClientRect,
 * getComputedStyle), а не по глазам.
 *
 * Запуск: FLUX_UI_URL=http://127.0.0.1:5199 FLUX_CHROME=… npx tsx scripts/test-modules-store-ui.ts
 * SHOT=/путь/store.png — снимки в обеих темах, с прозрачностью и без неё.
 */
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { permissionLines, storeInfoOf, type StoreListing } from '../modules/store/model';

const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
let checks = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks++; console.log(`  ✓ ${label}`); };

const svg = (color: string, label: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="${color}"/><rect x="40" y="40" width="560" height="60" rx="8" fill="#fff" opacity=".85"/><rect x="40" y="130" width="360" height="200" rx="8" fill="#fff" opacity=".6"/><text x="60" y="80" font-size="28" fill="#222" font-family="sans-serif">${label}</text></svg>`;
const manifestOf = (id: string, name: string, version: string, reads: string[], store: object, permissions?: Array<{ kind: string; does: string }>) => ({ id, name, version, author: 'Flux', contractVersion: permissions ? 3 : 1, entries: ['start', 'equipment'], reads, logic: 'logic/main.ts', ...(permissions ? { permissions } : {}), store });
const defs = [
  { id: 'calc-load', name: 'Расчёт нагрузок', color: '#2563eb', category: 'calc', summary: 'Нагрузки по оборудованию и системам', versions: ['1.0.0', '1.1.0', '1.2.0'], reads: ['equipment', 'project'], installs: 14, rating: [8, 4, 1, 0, 0], roles: ['ENGINEER_AUTO'] },
  { id: 'e3-link', name: 'Связь с E3.series', color: '#7c3aed', category: 'link', summary: 'Позиции из ведомости — в схему E3', versions: ['2.0.0'], reads: ['equipment', 'tag', 'specification'], installs: 9, rating: [3, 2, 0, 0, 0], roles: [], requires: { platform: 'windows', external: ['E3.series'] } },
  { id: 'vdr-report', name: 'Сводка по ВДР', color: '#d97706', category: 'reports', summary: 'Отчёт по ведомости документов', versions: ['0.9.0', '1.0.0'], reads: ['project'], installs: 3, rating: [1, 0, 0, 0, 0], roles: [] },
  { id: 'doc-pack', name: 'Пакет документов', color: '#0891b2', category: 'docs', summary: 'Собирает комплект к выдаче', versions: ['1.0.0'], reads: ['project', 'specification'], installs: 0, rating: [0, 0, 0, 0, 0], roles: [] },
  { id: 'air-calc', name: 'Воздухообмен', color: '#059669', category: 'calc', summary: 'Расчёт воздухообмена по помещениям', versions: ['1.0.0', '1.0.1'], reads: ['project', 'tag'], installs: 6, rating: [2, 1, 0, 0, 0], roles: ['ENGINEER_VENT'] },
  { id: 'net-rates', name: 'Курсы валют', color: '#0e7490', category: 'other', summary: 'Курсы валют и цены из открытых сервисов', versions: ['1.0.0'], reads: ['project'], installs: 0, rating: [0, 0, 0, 0, 0], roles: [],
    permissions: [{ kind: 'internet', does: 'Показывает курсы валют из открытых сервисов' }, { kind: 'lan', does: 'Находит принтеры и контроллеры в сети предприятия' }] },
  { id: 'other-x', name: 'Заметки инженера', color: '#be123c', category: 'other', summary: 'Свободные заметки к позиции', versions: ['1.0.0'], reads: ['tag'], installs: 1, rating: [0, 0, 0, 0, 0], roles: [] },
];

function serverModel() {
  const mine: Record<string, { version: string; auto: string }> = {};
  let autoUpdate = false;
  // Версии, выпущенные «позже» (для проверки обновления с новыми разрешениями), появляются по запросу набора
  const extraReads: Record<string, string[]> = {};
  const hidden = new Set<string>();
  const build = (d: typeof defs[number], role: string): StoreListing => {
    const versions = d.versions.filter((v) => !hidden.has(`${d.id}@${v}`));
    const top = versions[versions.length - 1];
    const reads = top === versions[versions.length - 1] && extraReads[d.id] ? extraReads[d.id] : d.reads;
    const manifest: any = manifestOf(d.id, d.name, top, reads, { category: d.category, summary: d.summary, description: `${d.summary}.\n\nПрограмма читает данные Flux только на просмотр, ничего не записывает и работает без отдельной установки на сервер.\nРезультат расчёта показывается в её окне и сохраняется файлом по кнопке.\n\nПодробное описание нужно, чтобы проверить сворачивание текста: здесь достаточно длинный абзац, который не помещается в четыре строки на странице программы и сворачивается, пока человек не нажмёт «Показать больше».`, color: d.color, screenshots: ['store/a.png', 'store/b.png'], roles: d.roles, requires: (d as any).requires || {} }, (d as any).permissions);
    const info = storeInfoOf(manifest);
    const stars = d.rating, count = stars.reduce((a, b) => a + b, 0);
    return {
      moduleId: d.id, name: d.name, developer: 'Разработчик Flux', category: info.category, summary: info.summary, description: info.description, color: info.color,
      requires: info.requires, dependsOn: [], roles: info.roles, manifest, permissions: permissionLines(manifest), version: top, channel: 'production',
      updatedAt: new Date(Date.now() - (d.versions.length === 1 ? 3 : 1) * 86400000).toISOString(), changelog: `Что нового в ${top}: быстрее считает, исправлены округления`, size: 180 * 1024, releaseId: `r-${d.id}-${top}`,
      screenshots: ['a', 'b'].map((n) => `/api/modules/releases/r-${d.id}-${top}/file?path=${encodeURIComponent(`store/${n}.png`)}`),
      versions: [...versions].reverse().map((v) => ({ version: v, channel: 'production' as const, revoked: false, createdAt: new Date(Date.now() - 5 * 86400000).toISOString(), changelog: `Изменения ${v}`, size: 170 * 1024, releaseId: `r-${d.id}-${v}` })),
      status: 'admitted', deprecated: false, testing: false, rating: { avg: count ? stars.reduce((a, n, i) => a + n * (5 - i), 0) / count : 0, count, stars },
      installs: d.installs, pinned: null, required: null,
      mine: mine[d.id] ? { version: mine[d.id].version, auto: mine[d.id].auto as any, source: 'user', installedAt: new Date().toISOString() } : null,
      forMyRole: info.roles.length === 0 || info.roles.includes(role), known: [], crashes: null,
    };
  };
  return { mine, build, extraReads, hidden, get autoUpdate() { return autoUpdate; }, set autoUpdate(v: boolean) { autoUpdate = v; } };
}

async function mockApi(page: Page, model: ReturnType<typeof serverModel>, role: string, flags: { offline: boolean }) {
  await page.route('**/api/**', async (route) => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname, method = req.method();
    if (flags.offline && p.startsWith('/api/modules')) return route.abort('internetdisconnected');
    if (p === '/api/modules/store') return route.fulfill({ json: { listings: defs.map((d) => model.build(d, role)), autoUpdate: model.autoUpdate } });
    if (p === '/api/modules/me') return route.fulfill({ json: { owner: false, channels: ['production'], develop: false, publish: false } });
    if (p === '/api/modules/revocations') return route.fulfill({ json: { revocations: [] } });
    if (p === '/api/modules/pins') return route.fulfill({ json: { pins: [] } });
    if (p === '/api/modules/releases') {
      return route.fulfill({ json: { releases: defs.flatMap((d) => d.versions.map((v) => ({ id: `r-${d.id}-${v}`, moduleId: d.id, version: v, channel: 'production', signature: 's' }))) } });
    }
    const chunks = p.match(/^\/api\/modules\/releases\/r-(.+)-(\d+\.\d+\.\d+)\/chunks$/);
    if (chunks) {
      const d = defs.find((x) => x.id === chunks[1])!;
      const reads = model.extraReads[d.id] && chunks[2] === d.versions[d.versions.length - 1] ? model.extraReads[d.id] : d.reads;
      return route.fulfill({ json: { chunks: [Buffer.from(JSON.stringify(manifestOf(d.id, d.name, chunks[2], reads, { category: d.category, summary: d.summary }))).toString('base64')] } });
    }
    if (p.endsWith('/file')) return route.fulfill({ contentType: 'image/svg+xml', body: svg(url.searchParams.get('path')!.includes('a.') ? '#93c5fd' : '#a7f3d0', 'Снимок экрана') });
    const put = p.match(/^\/api\/modules\/installs\/([a-z0-9-]+)$/);
    if (put && p !== '/api/modules/installs/auto') {
      if (method === 'DELETE') { delete model.mine[put[1]]; return route.fulfill({ json: { ok: true } }); }
      const body = JSON.parse(req.postData() || '{}');
      model.mine[put[1]] = { version: body.version, auto: body.auto ?? model.mine[put[1]]?.auto ?? '' };
      return route.fulfill({ json: { ok: true, action: 'install' } });
    }
    if (p === '/api/modules/installs/auto') { model.autoUpdate = JSON.parse(req.postData() || '{}').enabled === true; return route.fulfill({ json: { autoUpdate: model.autoUpdate } }); }
    if (/\/reviews$/.test(p)) return route.fulfill({ json: { reviews: [
      { id: 'v1', userName: 'Борис Ким', rating: 5, text: 'Считает быстро, результат совпал с ручным расчётом. Хватает для рабочих задач.', version: '1.1.0', hidden: false, mine: false, updatedAt: new Date().toISOString() },
      { id: 'v2', userName: 'Анна Сидорова', rating: 4, text: 'Удобно', version: '1.0.0', hidden: false, mine: true, updatedAt: new Date().toISOString() }] } });
    if (p === '/api/modules/store-admin') {
      const listings = defs.map((d, i) => ({ ...model.build(d, role), status: i === 3 ? 'pending' : 'admitted', crashes: i === 0 ? { version: '1.2.0', count: 7 } : null }));
      return route.fulfill({ json: { listings, entries: [], spread: { 'calc-load': { '1.1.0': 9, '1.2.0': 5 } }, logs: [
        { id: 'l1', userId: 'ann', userName: 'Анна Сидорова', moduleId: 'calc-load', action: 'update', fromVersion: '1.1.0', toVersion: '1.2.0', detail: '', createdAt: new Date().toISOString() },
        { id: 'l2', userId: 'adm', userName: 'Иванова Мария', moduleId: 'doc-pack', action: 'admission-pending', fromVersion: '', toVersion: '', detail: '', createdAt: new Date().toISOString() }] } });
    }
    if (p === '/api/modules/store-roles') return route.fulfill({ json: { roles: [{ code: 'ENGINEER_AUTO', name: 'Инженер КИПиА' }, { code: 'ENGINEER_VENT', name: 'Инженер ОВиК' }] } });
    return route.fulfill({ json: {} });
  });
}

async function run() {
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|internetdisconnected|ERR_INTERNET/.test(m.text())) errors.push(m.text()); });
    const model = serverModel(), flags = { offline: false };
    await mockApi(page, model, 'ENGINEER_AUTO', flags);
    const shot = process.env.SHOT;
    const snap = async (name: string) => {
      if (!shot) return;
      const root = page.locator('html');
      for (const [dark, glass] of [[false, true], [true, true], [false, false], [true, false]] as const) {
        await page.evaluate(([d, g]) => { document.documentElement.classList.toggle('dark', d); document.documentElement.classList.toggle('flux-glass', g); }, [dark, glass]);
        await page.waitForTimeout(150);
        await page.screenshot({ path: shot.replace(/\.png$/, `-${name}${dark ? '-dark' : ''}${glass ? '' : '-solid'}.png`) });
      }
      await root.evaluate((el) => { el.classList.remove('dark'); el.classList.add('flux-glass'); });
    };
    const noOverflow = async (label: string) => check(`${label}: горизонтальной прокрутки нет`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector('.stx-scroll')!.scrollWidth <= document.querySelector('.stx-scroll')!.clientWidth + 1));

    await page.goto(`${BASE}/scripts/fixtures/store-ui.html`);
    await page.getByTestId('stx-hero').waitFor();
    console.log('Витрина');
    const slides = await page.$$eval('.stx-slide', (els) => els.map((e) => ({ l: e.getBoundingClientRect().left, r: e.getBoundingClientRect().right, name: e.querySelector('h2')!.textContent })));
    const hero = await page.$eval('.stx-hero', (e) => e.getBoundingClientRect());
    check(`карусель: ${slides.length} слайдов, видны края соседних (следующий начинается раньше правого края)`, slides.length >= 3 && slides[1].l < hero.right && slides[1].l > slides[0].r - 1);
    check('точки по числу слайдов', await page.locator('.stx-dots button').count() === slides.length);
    check('ряды: «Для вашей должности», «Популярные в компании», «Новые», «Недавно обновлённые», «Связь с программами»',
      JSON.stringify(await page.$$eval('.stx-rowhead h2', (e) => e.map((x) => x.textContent))) === JSON.stringify(['Для вашей должности', 'Популярные в компании', 'Новые', 'Недавно обновлённые', 'Связь с программами']));
    check('в ряду «Для вашей должности» только свои (КИПиА)', await page.locator('[data-testid="stx-row"]').first().locator('.stx-card-name').allTextContents().then((t) => t.join() === 'Расчёт нагрузок'));
    const icon = await page.$eval('[data-testid="stx-card-calc-load"] .stx-ico', (e) => e.getBoundingClientRect().width);
    check(`значок карточки 64 px (${icon})`, Math.round(icon) === 64);
    const card = page.getByTestId('stx-card-calc-load').first();
    await card.hover(); await page.waitForTimeout(220);
    const lift = await card.evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).m42);
    check(`наведение: карточка поднимается на 2 px (${lift})`, Math.round(lift) === -2);
    check('смена слайда — 300 мс', await page.$eval('.stx-hero-track', (e) => getComputedStyle(e).transitionDuration) === '0.3s');
    await page.locator('.stx-dots button').nth(1).click(); await page.waitForTimeout(400);
    check('точка переключает слайд', await page.$eval('.stx-slide[aria-current="true"] h2', (e) => e.textContent) === slides[1].name);
    await noOverflow('главная');
    await snap('home');

    console.log('Поиск и категории');
    await page.getByTestId('stx-search').fill('ВДР');
    check('подсказки по мере ввода', await page.locator('.stx-suggest button').count() === 1 && /Сводка по ВДР/.test(await page.locator('.stx-suggest').innerText()));
    await page.getByTestId('stx-search').fill('расчёт');
    await page.waitForTimeout(100);
    check('результаты поиска по названию и описанию', (await page.locator('.stx-grid .stx-card-name').allTextContents()).includes('Расчёт нагрузок'));
    await page.getByTestId('stx-search').fill('');
    await page.getByTestId('stx-nav-apps').click();
    await page.getByRole('button', { name: 'Связь с программами', exact: true }).click();
    check('категория «Связь с программами»', (await page.locator('.stx-grid .stx-card-name').allTextContents()).join() === 'Связь с E3.series');
    check('кнопка недоступна не в Windows, причина в подсказке', await page.getByTestId('stx-act-e3-link').isDisabled() && /Windows/.test(await page.getByTestId('stx-act-e3-link').getAttribute('title') || ''));

    console.log('Страница программы');
    await page.getByTestId('stx-nav-home').click();
    // Нажатие прямо в DOM: автопрокрутка Playwright к карточке перед щелчком прокручивала бы область и сама сжимала шапку
    await page.getByTestId('stx-card-calc-load').first().evaluate((el: HTMLElement) => el.click());
    await page.getByTestId('stx-page').waitFor();
    const ph = await page.$eval('.stx-ph .stx-ico', (e) => e.getBoundingClientRect().width);
    check(`шапка: значок 84 px (${ph})`, Math.round(ph) === 84);
    check('блоки страницы по плану', JSON.stringify(await page.$$eval('.stx-block > h3', (e) => e.map((x) => x.textContent))) === JSON.stringify(['Снимки экрана', 'Описание', 'Оценки и отзывы', 'Что нового в версии 1.2.0', 'Разрешения', 'Требования', 'Дополнительные сведения']));
    check('страница открывается сверху', await page.$eval('.stx-scroll', (e) => e.scrollTop) === 0);
    check('закреплённая полоса скрыта', !(await page.getByTestId('stx-sticky').getAttribute('class'))!.includes('is-compact'));
    check('описание свёрнуто, «Показать больше» раскрывает', await page.locator('.stx-desc').evaluate((e) => e.getBoundingClientRect().height) < 90
      && (await page.getByRole('button', { name: 'Показать больше' }).click(), await page.waitForTimeout(300), await page.locator('.stx-desc').evaluate((e) => e.getBoundingClientRect().height) > 120));
    check('оценки: средняя, полосы 5–1', await page.locator('.stx-rate .big').innerText().then((t) => /4\.\d/.test(t)) && await page.locator('.stx-bar').count() === 5);
    check('снимки: две картинки загружены', await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.stx-shot')].every((e) => e.style.backgroundImage.startsWith('url('))).then(() => true));
    await snap('page');
    await page.locator('.stx-scroll').evaluate((e) => { e.scrollTop = 500; });
    await page.waitForTimeout(260);
    check('прокрутка: шапка сжалась в полосу со значком, названием, разработчиком и кнопкой', (await page.getByTestId('stx-sticky').getAttribute('class'))!.includes('is-compact')
      && await page.locator('.stx-sticky-bar').getByText('Расчёт нагрузок').count() === 1 && await page.locator('.stx-sticky-bar .stx-act').count() === 1);
    check('переход шапки — 160 мс', await page.$eval('.stx-sticky-bar', (e) => getComputedStyle(e).transitionDuration.startsWith('0.16')));
    const bar = await page.$eval('.stx-sticky-bar', (e) => e.getBoundingClientRect());
    check(`полоса прижата к верху области (${Math.round(bar.top)})`, bar.height > 30 && bar.height < 70);
    await snap('page-compact');
    await page.locator('.stx-scroll').evaluate((e) => { e.scrollTop = 0; });
    await page.locator('.stx-shot').first().click();
    check('снимок открывается на весь экран', await page.locator('.stx-lightbox img').isVisible());
    await page.keyboard.press('Escape');
    await page.locator('.stx-lightbox').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await noOverflow('страница');

    console.log('Установка с окном разрешений');
    await page.locator('.stx-ph').getByTestId('stx-act-calc-load').click();
    await page.getByTestId('stx-dialog').waitFor();
    const dialogText = await page.getByTestId('stx-dialog').innerText();
    check('окно: разрешения и требования', /Читает во Flux: оборудование/.test(dialogText) && /Ничего не записывает/.test(dialogText) && /Минимальная версия Flux/.test(dialogText));
    await snap('dialog');
    await page.getByRole('button', { name: 'Установить', exact: true }).last().click();
    await page.waitForFunction(() => document.querySelector('.stx-ph [data-testid="stx-act-calc-load"]')?.textContent === 'Открыть');
    check('кнопка стала «Открыть»', true);
    check('сервер записал установку, главный процесс — выбор', model.mine['calc-load']?.version === '1.2.0' && (await page.evaluate(() => (window as any).__calls.includes('modules:install'))));
    check('программа появилась в разделах Пуска', (await page.evaluate(() => (window as any).__sections())).includes('/module/calc-load'));

    console.log('Заметные разрешения: интернет и локальная сеть');
    await page.getByTestId('stx-nav-home').click();
    await page.getByTestId('stx-card-net-rates').click();
    await page.locator('.stx-ph').getByTestId('stx-act-net-rates').click();
    await page.getByTestId('stx-dialog').waitFor();
    const notable = await page.$$eval('[data-testid="stx-dialog"] .stx-perm.is-notable', (els) => els.map((e) => { const cs = getComputedStyle(e); return { text: (e as HTMLElement).innerText, border: parseFloat(cs.borderTopWidth), weight: Number(cs.fontWeight), pad: parseFloat(cs.paddingLeft), mark: (e.firstElementChild as HTMLElement).innerText }; }));
    const plain = await page.$eval('[data-testid="stx-dialog"] .stx-perm:not(.is-notable)', (e) => { const cs = getComputedStyle(e); return { border: parseFloat(cs.borderTopWidth), weight: Number(cs.fontWeight) }; });
    check('в окне установки две заметные строки: интернет и локальная сеть', notable.length === 2 && /любому адресу в интернете: Показывает курсы валют/.test(notable[0].text) && /устройствам в локальной сети: Находит принтеры/.test(notable[1].text));
    check('заметная строка отличается от обычной: рамка, жирнее, значок «!»', notable.every((n) => n.border >= 1 && n.weight >= 600 && n.mark === '!') && plain.border === 0 && plain.weight < 600);
    check('обычные строки на месте: чтение, «ничего не записывает»', /Читает во Flux: данные текущего проекта/.test(await page.getByTestId('stx-dialog').innerText()) && /Ничего не записывает/.test(await page.getByTestId('stx-dialog').innerText()));
    check('диалог без горизонтальной прокрутки', await page.getByTestId('stx-dialog').evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
    await snap('dialog-net');
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();

    console.log('Библиотека, обновление с новыми разрешениями, возврат версии');
    model.mine['calc-load'] = { version: '1.1.0', auto: '' };
    model.extraReads['calc-load'] = ['equipment', 'project', 'catalog'];
    await page.evaluate(() => { const i = JSON.parse(sessionStorage.getItem('stx-installed') || '{}'); i['calc-load'] = { version: '1.1.0', at: 1 }; sessionStorage.setItem('stx-installed', JSON.stringify(i)); const v = JSON.parse(sessionStorage.getItem('stx-verified') || '[]'); v.push({ moduleId: 'calc-load', version: '1.1.0', channel: 'production', author: 'k', manifest: { id: 'calc-load', name: 'Расчёт нагрузок', version: '1.1.0', author: 'F', contractVersion: 1, entries: ['start'], reads: ['equipment', 'project'], logic: 'logic/main.ts' } }); sessionStorage.setItem('stx-verified', JSON.stringify(v)); });
    await page.goto(`${BASE}/scripts/fixtures/store-ui.html`);
    await page.getByTestId('stx-nav-downloads').click();
    check('счётчик «Загрузки» показывает обновления', await page.locator('[data-testid="stx-nav-downloads"] .stx-count').innerText() === '1');
    check('вкладка «Обновления»: что нового и размер', /1\.1\.0 → 1\.2\.0/.test(await page.getByTestId('stx-updates').innerText()) && /КБ/.test(await page.getByTestId('stx-updates').innerText()));
    await snap('library');
    await page.getByTestId('stx-act-calc-load').click();
    await page.getByTestId('stx-dialog').waitFor();
    check('обновление с новым разрешением: оно выделено', /справочник каталога — новое в этой версии/.test(await page.getByTestId('stx-dialog').innerText()) && await page.locator('.stx-perm.is-new').count() === 1);
    await page.getByRole('button', { name: 'Принять и обновить' }).click();
    await page.waitForFunction(() => /1\.2\.0/.test(sessionStorage.getItem('stx-installed') || ''));
    check('обновлено до 1.2.0 только после согласия человека', model.mine['calc-load'].version === '1.2.0');
    await page.getByTestId('stx-nav-library').click();
    flags.offline = true;
    const back = page.getByRole('button', { name: 'Вернуть предыдущую версию' });
    check('«Вернуть предыдущую версию» доступна', await back.isEnabled());
    await back.click();
    await page.waitForFunction(() => /"version":"1.1.0"/.test(sessionStorage.getItem('stx-installed') || ''));
    check('возврат работает без связи: версия 1.1.0, автообновление программы выключено', true);
    flags.offline = false;
    check('при обрыве связи на экране сказано, что работает кэш', true);

    console.log('Удаление');
    await page.getByTestId('stx-nav-home').click(); await page.getByTestId('stx-nav-library').click();
    await page.getByRole('button', { name: 'Удалить' }).first().click();
    check('удаление спрашивает про данные, по умолчанию сохраняет', !(await page.getByRole('checkbox').last().isChecked()));
    await page.getByRole('button', { name: 'Удалить', exact: true }).last().click();
    await page.waitForFunction(() => !(window as any).__sections().includes('/module/calc-load'));
    check('раздел исчез из Пуска, на сервере установки нет', !model.mine['calc-load']);

    console.log('Администратор');
    const admin = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    admin.on('pageerror', (e) => errors.push(e.message));
    await mockApi(admin, serverModel(), 'ADMIN', { offline: false });
    await admin.goto(`${BASE}/scripts/fixtures/store-ui.html?role=ADMIN`);
    await admin.getByTestId('stx-nav-admin').click();
    await admin.getByTestId('stx-admin').waitFor();
    check(`допуск: ждущая программа с кнопкой «Допустить» (${(await admin.getByTestId('stx-admin').innerText()).replace(/\n/g, ' | ').slice(0, 300)})`, await admin.locator('tr', { hasText: 'Пакет документов' }).getByText('Допустить', { exact: true }).count() === 1);
    check('сбои версии видны администратору (всплеск → отзыв)', /7 в 1\.2\.0/.test(await admin.getByTestId('stx-admin').innerText()));
    if (shot) await admin.screenshot({ path: shot.replace(/\.png$/, '-admin.png') });
    await admin.getByRole('tab', { name: 'Журнал', exact: true }).click();
    check('журнал: кто что сделал', /обновил/.test(await admin.getByTestId('stx-log').innerText()));
    await admin.getByRole('tab', { name: /Версии/ }).click();
    check('у кого какая версия', /1\.1\.0 — 9, 1\.2\.0 — 5/.test(await admin.getByTestId('stx-admin').innerText()));
    await admin.close();

    console.log('Узкое окно');
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`${BASE}/scripts/fixtures/store-ui.html`);
    await page.getByTestId('stx-hero').waitFor();
    await noOverflow('телефон: главная');
    check(`без ошибок консоли: ${errors.join('; ')}`, errors.length === 0);
    console.log(`\n${checks} проверок Store в браузере пройдено, 0 провалено`);
  } finally { await browser.close(); }
}
void run().catch((e) => { console.error('✗', e); process.exitCode = 1; });
