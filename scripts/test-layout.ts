/**
 * Раскладка при сжатии: обходим разделы и меряем геометрию на экране.
 *
 * Зачем отдельно от остальных проверок. `test-flow` проверяет, что кнопка
 * нажимается и данные доходят до базы, — но не то, влезла ли кнопка в панель.
 * Вёрстка ломается тихо: подпись обрывается посреди слова, ряд уезжает за
 * карточку, колонка схлопывается в ноль. Ничего не падает, ошибок в консоли
 * нет, и заметить это можно только глазами — то есть однажды и случайно.
 *
 * Главное здесь — ширина ПАНЕЛИ, а не окна. Рабочий стол делит окно на две
 * или четыре части, и раздел живёт в своей доле: на мониторе 1100 в режиме
 * четырёх панелей каждая панель 442 px, при том что окно широкое. Поэтому
 * обход идёт дважды — в одной панели и в четырёх, — и второй проход находит
 * то, чего первый не видит в принципе.
 *
 * Запуск (нужен поднятый сервер и playwright-core):
 *   nohup npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-layout.ts
 *
 * Переменные: SHOTS=1 — сохранять снимки экрана в /tmp/flux-layout.
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOTS = process.env.SHOTS === '1' ? (process.env.SHOTS_DIR || '/tmp/flux-layout') : '';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 400) : ''));

const SECTIONS: [string, string][] = [
  ['Главная', '/'],
  ['Проекты', '/projects'],
  ['Теги', '/registry'],
  ['Оборудование', '/equipment'],
  ['Справочник', '/directory'],
  ['Менеджмент', '/management'],
  ['Проводник', '/explorer'],
  ['Конструктор', '/constructor'],
  ['Помощник', '/assistant'],
  ['Переводчик', '/translate'],
  ['Блокнот', '/notes'],
  ['Календарь', '/calendar'],
  ['Браузер', '/browser'],
  ['Мессенджер', '/chat'],
  ['Почта', '/mail'],
  ['Руководство', '/handbook'],
  ['Сотрудники', '/users'],
  ['Настройки', '/settings'],
];

/**
 * Список выше — руками, и он уже отставал: раздел «Руководство» появился, а
 * обход о нём не знал и всё равно рапортовал «все тесты пройдены». Сверяем с
 * настоящим реестром разделов, чтобы такое молчание не повторилось. Осознанно
 * не обходим только «Журнал» и «Чертёж» — они пусты без данных проекта, и
 * «Чертёж»: без открытого файла у него нет ни страницы, ни пометок, а мерить
 * пустую заглушку — значит проверять заглушку, а не раскладку.
 */
const SKIP = new Set(['/logs', '/pdf']);
{
  // Файл исполняется через tsx как CommonJS: import.meta здесь нет
  const { readFileSync } = require('fs') as typeof import('fs');
  const { resolve } = require('path') as typeof import('path');
  const src = readFileSync(resolve(__dirname, '../src/workspace/sections.tsx'), 'utf-8');
  const real = [...src.matchAll(/path: '([^']+)', title: '([^']+)'/g)].map((m) => m[1]);
  const covered = new Set(SECTIONS.map(([, p]) => p));
  const missed = real.filter((p) => !covered.has(p) && !SKIP.has(p));
  if (missed.length) {
    console.log(`✗ разделы вне обхода: ${missed.join(', ')}`);
    process.exit(1);
  }
}

/**
 * Ширины экрана. 1920 и 1440 — мониторы, 1280 и 1100 — ноутбуки, 960 и 820 —
 * окно, ужатое в половину экрана. Раздел обязан держаться на всех шести.
 *
 * Меряется при этом ОКНО, а не экран: разделы отступают от своего окна, и
 * ширина стола им ничего не говорит. Раньше здесь было два прохода — одна
 * панель и четыре, — потому что панельная оболочка давала разделу то целый
 * экран, то его четверть. Панелей больше нет: окно и есть панель, только
 * двигается, и узкий случай даёт узкий экран.
 */
const WIDTHS = [1920, 1440, 1280, 1100, 960, 820];

/**
 * Мелочи, которые проба видит, а дефектом они не являются. Список короткий
 * и каждый пункт объяснён: иначе он за год разрастётся и проверка перестанет
 * что-либо значить.
 */
const ALLOWED = [
  // Холст связей в Тегах двигают мышью нарочно — содержимое там заведомо
  // больше окна, это и есть смысл холста
  { text: 'ПКМ — двигать холст', why: 'холст связей прокручивается мышью' },
  // Круглая кнопка журнала: счётчик намеренно выступает за её край
  { cls: 'rounded-full flex items-center justify-center shadow-lg', why: 'счётчик выступает за круглую кнопку' },
  { cls: 'fixed bottom-4', why: 'обёртка плавающего значка журнала' },
  // Полоска «показать стол» в правом нижнем углу. Она узкая нарочно и берёт не
  // размером, а положением: мышь упирается в угол экрана и попадает в неё не
  // глядя, сколько бы ни было в ней точек. Ради этого она и идёт во всю высоту
  // панели вплотную к краю — расширять её значит съесть место у трея впустую
  // Ширина полоски задаётся общей мерой оболочки (BAR_EDGE), а не классом
  // ширины: после переезда на неё исключение по классу «w-3» перестало
  // совпадать, и проба начала считать полоску дефектом
  { cls: 'self-stretch ml-1 cursor-pointer', why: 'угловая полоска «показать стол»' },
];

/** Порог: 1–3 px набегают от округления и субпиксельных рамок */
const TOLERANCE = 4;

(async () => {
  let chromium: any;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    console.error('playwright-core не установлен. Поставьте: npm i --no-save playwright-core');
    process.exit(2);
  }
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}). Поднимите: npx tsx server.ts`);
    process.exit(2);
  }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  const jsErrors: string[] = [];
  page.on('pageerror', (e: any) => jsErrors.push(String(e.message).slice(0, 160)));

  // Лицензия проверяется подписью, приватного ключа в репозитории нет —
  // подменяем только ответ проверки, код программы не трогаем
  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));

  /**
   * Замер на текущей странице.
   *
   * Тело передаём строкой: tsx оборачивает именованные функции в свой хелпер
   * __name, которого в браузере нет, и обычная стрелка падает с ReferenceError.
   */
  const PROBE = String.raw`((rootSel) => {
    // В одной панели меряем весь документ: там же и оболочка — меню, рельс,
    // полоса вкладок. В четырёх — только активную панель, иначе находки
    // соседних панелей приписываются не тому разделу.
    const root = rootSel ? document.querySelector(rootSel) : document.body;
    if (!root) return { overflow: [], clipped: [], tiny: [], zero: [] };
    const out = { overflow: [], clipped: [], tiny: [], zero: [] };
    const seen = new Set();
    const key = (el) => el.tagName + '|' + (typeof el.className === 'string' ? el.className.slice(0, 70) : '');
    const label = (el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 130),
    });
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;

      // Внутри невидимого предка мерить нечего: на Главной левое меню свёрнуто
      // в нулевую ширину и погашено прозрачностью — оно существует, но его не видно
      let ghost = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const ao = getComputedStyle(a);
        if (ao.opacity === '0' || ao.visibility === 'hidden') { ghost = true; break; }
        if (a.getBoundingClientRect().width === 0 && ao.overflowX !== 'visible') { ghost = true; break; }
      }
      if (ghost) continue;

      const lost = el.scrollWidth - el.clientWidth;
      if (lost > 1 && el.clientWidth > 0) {
        const ox = cs.overflowX;
        if (ox === 'hidden' || ox === 'clip') {
          // Обрезано наглухо и без многоточия — человек видит обрубок слова
          if (cs.textOverflow !== 'ellipsis' && (el.textContent || '').trim()) {
            if (!seen.has('c' + key(el))) { seen.add('c' + key(el)); out.clipped.push({ ...label(el), lost }); }
          }
        } else if (ox === 'visible') {
          // Содержимое шире контейнера, а прокрутки нет: часть просто вылезла
          if (!seen.has('o' + key(el))) { seen.add('o' + key(el)); out.overflow.push({ ...label(el), lost }); }
        }
      }

      // Цель нажатия, в которую надо целиться мышью
      const role = el.getAttribute('role');
      if ((el.tagName === 'BUTTON' || role === 'button') && r.width > 0 && (r.width < 20 || r.height < 20)) {
        if (!seen.has('t' + key(el))) { seen.add('t' + key(el)); out.tiny.push({ ...label(el), w: Math.round(r.width), h: Math.round(r.height) }); }
      }

      // Схлопнулось в ноль, а текст внутри есть
      if (r.width < 2 && r.height > 6 && (el.textContent || '').trim() && el.children.length === 0) {
        if (!seen.has('z' + key(el))) { seen.add('z' + key(el)); out.zero.push(label(el)); }
      }
    }
    return out;
  })`;

  const paneWidth = () => page.evaluate(String.raw`(() => {
    const p = document.querySelector('[data-window-body]');
    return p ? Math.round(p.getBoundingClientRect().width) : 0;
  })()`) as Promise<number>;

  /** Отсев объяснённых мелочей и подпороговых расхождений */
  const real = (items: any[]) => items.filter((it) => {
    if ((it.lost ?? TOLERANCE) < TOLERANCE) return false;
    return !ALLOWED.some((a) =>
      (a.text && it.text && it.text.includes(a.text)) ||
      (a.cls && it.cls && it.cls.includes(a.cls)));
  });

  try {
    console.log('1. Вход и подготовка');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6500);
    const inputs = await page.$$('input');
    await inputs[0].fill(LOGIN.symbol);
    await inputs[1].fill(LOGIN.password);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
    ok('вход выполнен', await page.evaluate(() => !!document.querySelector('[data-taskbar]')));

    // Без выбранного проекта пять разделов показывают заглушку, и таблицы —
    // ровно то, что надо смотреть при сжатии — вообще не рисуются
    // Проект выбирается не кнопкой: раньше её искали по подписи «Проект», и
    // после переезда меню в панель задач по этой подписи находилась уже кнопка
    // раздела «Проекты». Обход тихо шёл по заглушкам «Сначала выберите проект»
    // и рапортовал, что раскладка цела, — мерить там было нечего. Кладём
    // проект туда же, где его помнит сама программа.
    await page.evaluate(async () => {
      const me = JSON.parse(localStorage.getItem('pdm_session_user') || 'null');
      const list = await (await fetch('/api/projects')).json();
      const first = Array.isArray(list) ? list[0] : (list?.projects || [])[0];
      if (me && first) localStorage.setItem(`max_active_project_${me.id}`, JSON.stringify(first));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6500);
    await page.evaluate(() => { window.location.hash = '#/registry'; });
    await page.waitForTimeout(3000);
    const hasProject = await page.evaluate(() => !/Сначала выберите проект/.test(document.body.innerText));
    ok('проект выбран — разделы показывают данные, а не заглушку', hasProject);

    if (SHOTS) {
      const fs = await import('fs');
      fs.mkdirSync(SHOTS, { recursive: true });
    }

    console.log('\n2. Обход разделов: меряем ОКНО, а не стол');
    for (const [name, path] of SECTIONS) {
      // Через адрес: оболочка сама заводит окно, увидев новый адрес
      await page.evaluate((p: string) => { window.location.hash = '#' + p; }, path);
      await page.waitForTimeout(3200);

      const bad: string[] = [];
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w, height: 950 });
        await page.waitForTimeout(900);
        // Корень измерения — тело окна: разделы отступают от него, а не от
        // экрана, и мерить надо ровно то, что видит раздел
        const p: any = await page.evaluate(`(${PROBE})('[data-window-body]')`);
        const pw = await paneWidth();

        const over = real(p.overflow);
        const cut = real(p.clipped);
        const tiny = real(p.tiny);
        const zero = real(p.zero);

        if (over.length) bad.push(`окно ${pw}: шире места ${over.map((x: any) => `«${x.text}» +${x.lost}px`).slice(0, 2).join(', ')}`);
        if (cut.length) bad.push(`окно ${pw}: обрезано без многоточия ${cut.map((x: any) => `«${x.text}» +${x.lost}px`).slice(0, 2).join(', ')}`);
        if (tiny.length) bad.push(`окно ${pw}: мелкая цель ${tiny.map((x: any) => `«${x.text || x.cls.slice(0, 24)}» ${x.w}×${x.h}`).slice(0, 2).join(', ')}`);
        if (zero.length) bad.push(`окно ${pw}: схлопнулось «${zero[0].text}»`);

        if (SHOTS) {
          await page.screenshot({ path: `${SHOTS}/${path.replace(/\W/g, '') || 'home'}-${w}.png` });
        }
      }
      ok(`${name} держит раскладку на всех ширинах`, bad.length === 0, bad.slice(0, 3));
    }

    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.waitForTimeout(600);

    console.log('\n3. Тишина в консоли за весь обход');
    ok('ни исключений, ни ошибок отрисовки', jsErrors.length === 0, Array.from(new Set(jsErrors)).slice(0, 5));
  } finally {
    await browser.close();
  }

  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
