/**
 * Редактор Ворда: живая проверка через интерфейс.
 *
 * Почему живьём, а не только модулями. `test-doc-export` проверяет сборку HTML
 * на готовом снапшоте — это чистая функция. Но между ней и человеком стоит
 * движок Univer: лента со шрифтами, лист с полями, кнопки выгрузки. Ошибка в
 * этой связке (не подхватился список шрифтов, лист не сменил формат, файл не
 * скачался) на модульных проверках не видна совсем.
 *
 * Запуск (нужен поднятый сервер и playwright-core):
 *   npx tsx server.ts &
 *   npx tsx scripts/test-word.ts
 *
 * Созданный документ удаляется в конце, даже при сбое.
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 240) : ''));

let token = '';
const api = async (method: string, url: string, body?: any) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null as any, text }; }
};

(async () => {
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); }
  catch { console.error('playwright-core не установлен: npm i --no-save playwright-core'); process.exit(2); }

  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e})`); process.exit(2);
  }

  token = (await api('POST', '/api/login', LOGIN)).json?.token || '';
  if (!token) { console.error('Не удалось войти'); process.exit(2); }
  const projectId = (await api('GET', '/api/projects')).json?.projects?.[0]?.id;
  if (!projectId) { console.error('В базе нет проекта'); process.exit(2); }

  // Хвосты прошлых прогонов: одинаковые имена в списке — и сценарий откроет
  // не тот документ (проверено: именно так проверка титула «не видела» настройки)
  const stale = ((await api('GET', `/api/constructor/docs?projectId=${projectId}`)).json?.docs || [])
    .filter((d: any) => /^(Проверка Ворда|Титул проверки)/.test(d.name || ''));
  for (const d of stale) await api('DELETE', `/api/constructor/docs/${d.id}`).catch(() => {});
  if (stale.length) console.log(`  (убрано документов от прошлых прогонов: ${stale.length})`);

  // Документ заводим через API: проверяем редактор, а не создание документа
  const DOC_NAME = `Проверка Ворда ${Date.now().toString(36).slice(-4)}`;
  const made = await api('POST', '/api/constructor/docs', {
    projectId, name: DOC_NAME, kind: 'TEXT', scope: 'SHARED',
  });
  const docId = made.json?.doc?.id;
  if (!docId) { console.error('Не удалось создать документ: ' + JSON.stringify(made.json)); process.exit(2); }

  let tplId = '';                      // шаблон титула, созданный сценарием
  const formulaIds: string[] = [];     // и его формулы

  // Титул с формулами готовим ДО входа: редактор читает настройки документа
  // один раз при открытии, и присваивать титул уже открытому документу значит
  // проверять не выгрузку, а перезаход.
  // Самое важное в задаче: формулы живут в программе, а в файл должны попасть
  // ПОСЧИТАННЫЕ значения — иначе на чужом компьютере вместо шифра и подписи
  // будет пустое место.
  const usersRes = (await api('GET', '/api/users')).json;
  const users: any[] = Array.isArray(usersRes) ? usersRes : (usersRes?.users || []);
  const me = users.find((u: any) => u.symbol === LOGIN.symbol);
  ok('нашли себя в списке сотрудников', !!me?.id, users.map(u => u.symbol));
  ok('картинка подписи в списке не отдаётся', me && !('signatureImage' in me), Object.keys(me || {}));

  // Подпись сотрудника: крошечный PNG — проверяем перенос, а не картинку
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const sigPut = await api('PUT', `/api/users/${me.id}/signature`, { signatureImage: PNG, signatureHeightMm: 10 });
  ok('подпись сотрудника сохранена в общей базе', sigPut.status === 200, sigPut.json);

  // Формулы проекта: дата, инициалы, подпись и сборка «шифр + ревизия»
  const mkF = async (name: string, kind: string, config: any) =>
    (await api('POST', `/api/projects/${projectId}/formulas`, { name, kind, config })).json?.formula;
  const fDate = await mkF('Дата', 'value', { field: 'date', date: { order: 'dmy', month: 'gen', year: 'suffix' } });
  const fIni = await mkF('Инициалы', 'value', { field: 'person', name: 'initialsAfter', person: 'author' });
  const fSig = await mkF('Подпись', 'signature', { person: 'author', heightMm: 10 });
  const fCode = await mkF('Шифр с ревизией', 'compose', { parts: [
    { kind: 'field', value: 'doc.code' },
    { kind: 'field', value: 'doc.revision', sep: ' рев. ' },
  ] });
  ok('формулы созданы', !!(fDate?.id && fIni?.id && fSig?.id && fCode?.id));
  formulaIds.push(fDate.id, fIni.id, fSig.id, fCode.id);

  // Шаблон титула с плашками — ровно так его сохраняет редактор шаблонов
  const chip = (f: any) => `<span data-formula-id="${f.id}" contenteditable="false" class="tt-chip tt-chip-fx">${f.name}</span>`;
  const tplHtml = `<p style="text-align:center">ПОЯСНИТЕЛЬНАЯ ЗАПИСКА</p>`
    + `<p>Шифр: ${chip(fCode)}</p><p>Дата: ${chip(fDate)}</p>`
    + `<p>Разработал: ${chip(fIni)} ${chip(fSig)}</p>`;
  const tpl = (await api('POST', '/api/constructor/docs', {
    projectId, name: 'Титул проверки', kind: 'TEMPLATE', scope: 'SHARED',
    bindings: JSON.stringify({ subtype: 'title', html: tplHtml }),
  })).json?.doc;
  ok('шаблон титула создан', !!tpl?.id, tpl);
  if (tpl?.id) tplId = tpl.id;

  // Присваиваем титул документу и заполняем шифр с ревизией
  await api('PUT', `/api/constructor/docs/${docId}`, {
    settings: JSON.stringify({ titleTemplateId: tpl.id, docMeta: { code: 'ПЗ-042', revision: 'B' } }),
  });

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
  const errors: string[] = [];
  page.on('pageerror', (e: any) => errors.push('исключение: ' + String(e.message).slice(0, 130)));


  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('консоль: ' + m.text().slice(0, 130)); });

  // Лицензия проверяется подписью, приватного ключа в репозитории нет —
  // подменяем только ответ проверки, код программы не трогаем
  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));

  /** Снапшот документа из базы — сверяем то, что реально сохранилось */
  const docSnapshot = async (): Promise<any> => {
    const doc = (await api('GET', `/api/constructor/docs/${docId}`)).json?.doc;
    try { return JSON.parse(doc?.workbook || '{}'); } catch (_) { return {}; }
  };

  const clickByName = async (name: string | RegExp, timeout = 6000) => {
    const loc = page.getByRole('button', { name });
    const n = await loc.count();
    for (let k = 0; k < n; k++) {
      const el = loc.nth(k);
      if (!(await el.isVisible())) continue;
      if (await el.click({ timeout }).then(() => true).catch(() => false)) return true;
    }
    return false;
  };

  try {
    console.log('1. Вход и открытие документа');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6500);
    const inputs = await page.$$('input');
    await inputs[0].fill(LOGIN.symbol);
    await inputs[1].fill(LOGIN.password);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(9000);
    ok('вход выполнен', await page.evaluate(() => !!document.querySelector('[data-taskbar]')));

    // Идём прямо в документ: путь через разделы проверяет test-flow
    await page.evaluate((id: string) => {
      window.history.pushState({}, '', `/?doc=${id}`);
    }, docId);
    await page.goto(`${BASE}/?constructorDoc=${docId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);

    // Открываем через программу «Таблица»: адресной строки у неё нет
    await clickByName(/Таблица/i, 8000);
    await page.waitForTimeout(3500);
    // Открываем по точному имени: подстрока может совпасть с чужим документом
    const openDoc = () => page.getByText(DOC_NAME, { exact: true }).first()
      .dblclick({ timeout: 8000 }).then(() => true).catch(() => false);
    ok('документ открыт из списка Flux Office', await openDoc());
    await page.waitForTimeout(9000);   // движок Univer грузится лениво

    console.log('2. Общая лента редакторов');
    // Панель движка спрятана целиком, вместо неё общая лента Flux (lib/ribbonDoc):
    // вкладки свои, органы помечены data-organ. Проверяем её, а не Univer:
    // человек нажимает на то, что видит.
    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll('[role="tab"]')].map(b => (b.textContent || '').trim()));
    ok('вкладки ленты на месте',
      ['Главная', 'Вставка', 'Разметка'].every(t => tabs.includes(t)), tabs);

    const organs = await page.evaluate(() =>
      [...document.querySelectorAll('[data-organ]')].map(x => (x as HTMLElement).dataset.organ));
    ok('в ленте есть поле шрифта', organs.includes('doc.font'), organs.slice(0, 20));
    ok('в ленте есть кегль', organs.includes('doc.size'), organs.slice(0, 20));

    // Список шрифтов читается прямо из поля: это обычный select, а не свой
    // выпадающий слой, — и поэтому у него работает клавиатура и не надо
    // угадывать, куда он раскроется
    const fonts = await page.evaluate(() => {
      const sel = document.querySelector('[data-organ="doc.font"]') as HTMLSelectElement | null;
      return sel ? [...sel.options].map(o => o.textContent || '') : [];
    });
    ok('список шрифтов на месте', fonts.includes('Verdana') && fonts.includes('Courier New'), fonts.slice(0, 20));
    ok('в списке шрифты для русских документов',
      fonts.includes('Times New Roman') && fonts.includes('Calibri'), fonts);
    ok('китайских шрифтов больше нет',
      !fonts.some(x => /SimSun|FangSong|STXingkai|Kaiti/.test(x)), fonts);
    ok('чертёжный шрифт доступен', fonts.some(x => x.startsWith('ISOCPEUR')), fonts);

    console.log('3. Линейка над листом');
    // Линейку рисуем после того, как движок разложил страницу, — ждём её
    // появления, а не «подольше поспим»: на медленной машине сон не спасёт
    await page.waitForSelector('[data-doc-ruler] > div', { timeout: 20000 }).catch(() => {});
    if (process.env.FLUX_DEBUG) {
      console.log('    отладка:', JSON.stringify(await page.evaluate(() => ({
        линеек: document.querySelectorAll('[data-doc-ruler]').length,
        кнопкаИнтервал: [...document.querySelectorAll('button')].filter(b => /Интервал/.test(b.textContent || '')).length,
        видимаяКнопка: [...document.querySelectorAll('button')].filter(b => /Интервал/.test(b.textContent || '') && b.getClientRects().length > 0).length,
        именаКнопок: [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 22),
      }))));
    }
    // Линейка должна стоять ровно по ширине листа. Проверяем не «есть элемент»,
    // а совпадение с самим листом: движок рисует лист на полотне, поэтому
    // сравниваем ширину линейки с шириной листа в пунктах и масштабом.
    const rulerGeom = await page.evaluate(() => {
      const strip = document.querySelector('[data-doc-ruler] > div') as HTMLElement | null;
      if (!strip) return null;
      const box = strip.getBoundingClientRect();
      const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
      const cbox = canvas?.getBoundingClientRect();
      // Светлая полоса внутри — текстовая область между полями
      const text = strip.firstElementChild as HTMLElement | null;
      const tbox = text?.getBoundingClientRect();
      return {
        left: Math.round(box.left), width: Math.round(box.width),
        textLeft: tbox ? Math.round(tbox.left - box.left) : null,
        textWidth: tbox ? Math.round(tbox.width) : null,
        canvasLeft: cbox ? Math.round(cbox.left) : null,
        canvasWidth: cbox ? Math.round(cbox.width) : null,
      };
    });
    ok('линейка на экране', !!rulerGeom, rulerGeom);
    if (rulerGeom) {
      // А4 книжная: 595,3 pt при 100% — это 595 px (пункт в пиксель)
      ok('ширина линейки равна ширине листа', Math.abs(rulerGeom.width - 595) <= 2, rulerGeom.width);
      // Поля 2,54 см = 72 pt с каждой стороны → текст 451 px
      ok('светлая полоса — текстовая область между полями',
        Math.abs((rulerGeom.textWidth ?? 0) - 451) <= 3, rulerGeom.textWidth);
      ok('текстовая область начинается на левом поле',
        Math.abs((rulerGeom.textLeft ?? 0) - 72) <= 2, rulerGeom.textLeft);
      // Линейка по центру полотна — там же, где движок рисует лист
      const rulerCenter = rulerGeom.left + rulerGeom.width / 2;
      const canvasCenter = (rulerGeom.canvasLeft ?? 0) + (rulerGeom.canvasWidth ?? 0) / 2;
      ok('линейка стоит над листом, а не сбоку', Math.abs(rulerCenter - canvasCenter) <= 12,
        { rulerCenter, canvasCenter });
    }

    const handles = await page.evaluate(() =>
      [...document.querySelectorAll('[data-doc-ruler] button')].map(b => b.getAttribute('title') || ''));
    ok('бегунки полей есть', handles.some(t => /Левое поле/.test(t)) && handles.some(t => /Правое поле/.test(t)), handles);
    ok('значение поля показано в миллиметрах', handles.some(t => /25,4 мм/.test(t)), handles);

    // Тянем левое поле линейкой и сверяем с базой: 72 pt → примерно 20 мм
    const leftHandle = await page.evaluate(() => {
      const b = [...document.querySelectorAll('[data-doc-ruler] button')]
        .find(x => /Левое поле/.test(x.getAttribute('title') || '')) as HTMLElement | undefined;
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    ok('бегунок левого поля пойман', !!leftHandle, leftHandle);
    if (leftHandle) {
      await page.mouse.move(leftHandle.x, leftHandle.y);
      await page.mouse.down();
      // Влево на 15 px: 72 pt → 57 pt (примерно 20 мм), с прилипанием к 0,5 мм
      await page.mouse.move(leftHandle.x - 15, leftHandle.y, { steps: 6 });
      const tip = await page.evaluate(() => {
        const el = [...document.querySelectorAll('[data-doc-ruler] div')]
          .find(x => /Левое:/.test(x.textContent || ''));
        return el?.textContent || '';
      });
      ok('пока тянем, видно значение', /Левое:\s*\d+/.test(tip), tip);
      await page.mouse.up();
      await page.waitForTimeout(2500);

      const snap = await docSnapshot();
      const left = snap?.documentStyle?.marginLeft;
      ok('поле в документе уменьшилось', typeof left === 'number' && left < 72 && left > 45, left);
      ok('прилипло к полумиллиметру',
        typeof left === 'number' && Math.abs((left * 25.4 / 72) * 2 - Math.round((left * 25.4 / 72) * 2)) < 0.02,
        left && left * 25.4 / 72);
      ok('текст документа при этом не пострадал', typeof snap?.body?.dataStream === 'string');
    }

    console.log('4. Интервалы к выделению');
    // Ставим курсор в текст: без курсора интервал применять некуда
    await page.mouse.click(760, 300);
    await page.waitForTimeout(600);
    await page.keyboard.type('Проверка интервала', { delay: 12 });
    await page.waitForTimeout(1200);

    ok('кнопка «Интервал» на месте', await clickByName('Интервал', 6000));
    await page.waitForTimeout(800);
    const spacingMenu = await page.evaluate(() => document.body.innerText);
    ok('в меню есть 1,5 для ГОСТ', /1,5 · ГОСТ/.test(spacingMenu), spacingMenu.slice(-300));
    ok('и интервалы до и после абзаца',
      /Интервал до абзаца/.test(spacingMenu) && /Интервал после абзаца/.test(spacingMenu));
    ok('и красная строка 1,25 см', /Красная строка 1,25 см/.test(spacingMenu));

    await clickByName('Как в записке по ГОСТ', 6000);
    await page.waitForTimeout(2500);
    {
      const snap = await docSnapshot();
      const para = (snap?.body?.paragraphs || []).find((p: any) => p.paragraphStyle);
      ok('междустрочный интервал 1,5 записан в абзац', para?.paragraphStyle?.lineSpacing === 1.5, para?.paragraphStyle);
      ok('красная строка 1,25 см записана',
        Math.abs((para?.paragraphStyle?.indentFirstLine?.v || 0) * 25.4 / 72 - 12.5) < 0.2,
        para?.paragraphStyle?.indentFirstLine);
      ok('набранный текст на месте', /Проверка интервала/.test(snap?.body?.dataStream || ''), snap?.body?.dataStream?.slice(0, 60));
    }

    console.log('5. Разметка страницы');
    // Параметры листа переехали на вкладку «Разметка»: сначала вкладка, потом
    // орган. Так же их ищет человек — по названию вкладки, а не наугад
    await page.getByRole('tab', { name: 'Разметка' }).first().click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(600);
    ok('кнопка параметров листа на месте', await clickByName('Параметры', 6000));
    await page.waitForTimeout(1200);
    const dlg = await page.evaluate(() => document.body.innerText);
    ok('окно разметки открылось', /Разметка страницы/.test(dlg));
    ok('форматы листа перечислены', /A4 210 × 297 мм/.test(dlg) && /A3 297 × 420 мм/.test(dlg), dlg.slice(0, 300));
    ok('наборы полей перечислены', /Обычные · 2,54 см/.test(dlg) && /ГОСТ/.test(dlg));
    ok('поля показаны в миллиметрах', /Сверху, мм/.test(dlg));

    // Ставим ГОСТ-поля и альбомную ориентацию — и проверяем, что легло в базу
    await clickByName(/ГОСТ · слева 3 см/, 5000);
    await clickByName('Альбомная', 5000);
    await clickByName('Применить', 5000);
    await page.waitForTimeout(6000);

    const after = (await api('GET', `/api/constructor/docs/${docId}`)).json?.doc;
    let snap: any = {};
    try { snap = JSON.parse(after?.workbook || '{}'); } catch (_) {}
    const ds = snap.documentStyle || {};
    ok('поля ГОСТ сохранены в документе', ds.marginLeft === 85 && ds.marginRight === 43, ds);
    ok('лист стал альбомным', ds.pageSize?.width > ds.pageSize?.height, ds.pageSize);
    ok('текст документа при смене разметки не потерялся', typeof snap.body?.dataStream === 'string', Object.keys(snap));

    console.log('6. Выгрузка в Ворд');
    // Перехватываем скачивание и читаем сам файл
    const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    // Выгрузка живёт в «Файле» — том самом экране, что в Ворде за зелёной
    // кнопкой слева от вкладок (lib/ribbonFile)
    ok('экран «Файл» открылся', await clickByName('Файл', 6000));
    await page.waitForTimeout(900);
    const menu = await page.evaluate(() => document.body.innerText);
    ok('в «Файле» есть выгрузка в Ворд', /В Ворд \(\.doc\)/.test(menu), menu.slice(0, 400));
    ok('и сохранение в Проводник', /В Проводник/.test(menu));
    await clickByName(/В Ворд \(\.doc\)/, 6000);

    const download = await dl;
    ok('файл скачался', !!download, download ? await download.suggestedFilename() : null);
    if (download) {
      // В контейнере у Chromium не задана локаль (LC_CTYPE=POSIX), и он теряет
      // кириллицу в имени скачиваемого файла — проверено отдельно: латинское
      // имя доходит, русское превращается в «download». На рабочем месте
      // выгрузка идёт не скачиванием, а окном «Сохранить как» (doc:save-word),
      // поэтому здесь проверяем только само содержимое файла.
      const name = await download.suggestedFilename();
      ok('файл получен', !!name, name);
      const path = await download.path();
      const fs = await import('node:fs/promises');
      const text = path ? await fs.readFile(path, 'utf8') : '';
      ok('файл не пустой', text.length > 200, text.length);
      ok('Ворд откроет его как документ', text.includes('WordSection1') && text.includes('urn:schemas-microsoft-com:office:word'));
      ok('поля листа ушли в файл — 30 мм слева', /margin:20\.1mm 15\.2mm 20\.1mm 30mm/.test(text), (text.match(/margin:[^;}]*/) || [])[0]);
      ok('альбомный лист в файле', /size:297mm 210mm/.test(text), (text.match(/size:[^;]*/) || [])[0]);
      ok('кодировка указана — русский текст не поедет', /charset="?utf-8/i.test(text));
      ok('в начале файла BOM — Ворд не покажет кракозябры', text.charCodeAt(0) === 0xFEFF, text.charCodeAt(0));
      // Титул присвоен, поэтому вместо служебного заголовка в файле его текст
      ok('кириллица внутри файла читается', /ПОЯСНИТЕЛЬНАЯ ЗАПИСКА/.test(text), text.slice(0, 200));
      ok('формул в файле нет, только значения', !/data-formula/.test(text) && !/tt-chip/.test(text));
    }

    console.log('7. Титул с формулами: получатель в Windows видит значения');
    // Присвоенный титул виден по органу ленты: он горит зелёным. Не горит —
    // редактор не прочитал настройки, и проверять выгрузку бессмысленно
    await page.getByRole('tab', { name: 'Вставка' }).first().click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(600);
    const titleAssigned = await page.evaluate(() => {
      const b = document.querySelector('[data-organ="doc.title"]');
      return b ? b.className.includes('bg-emerald-50') : null;
    });
    ok('редактор увидел присвоенный титул', titleAssigned === true, titleAssigned);

    const dl2 = page.waitForEvent('download', { timeout: 25000 }).catch(() => null);
    await clickByName('Файл', 6000);
    await page.waitForTimeout(900);
    await clickByName(/В Ворд \(\.doc\)/, 6000);
    const d2 = await dl2;
    ok('файл с титулом скачался', !!d2);
    if (d2) {
      const p2 = await d2.path();
      const fs = await import('node:fs/promises');
      const t2 = p2 ? await fs.readFile(p2, 'utf8') : '';
      ok('титул попал в файл', /ПОЯСНИТЕЛЬНАЯ ЗАПИСКА/.test(t2), t2.length);
      ok('сборка «шифр + ревизия» посчитана', /ПЗ-042 рев\. B/.test(t2), (t2.match(/Шифр:[^<]*/) || [])[0]);
      ok('дата словами, как настроено', /\d{1,2} [а-яё]+ \d{4} г\./.test(t2), (t2.match(/Дата:[\s\S]{0,60}/) || [])[0]);
      // «Раупов Хусрав Хуршедович» → «Раупов Х.Х.», через неразрывный пробел
      ok('инициалы собраны из ФИО', /Раупов(&nbsp;| | )Х\.Х\./.test(t2), (t2.match(/Разработал:[\s\S]{0,140}/) || [])[0]);
      ok('подпись ушла картинкой внутри файла', /<img src="data:image\/png;base64,/.test(t2) && /height:10mm/.test(t2), (t2.match(/<img[^>]*/) || [])[0]);
      ok('названий формул в файле нет — только значения',
        !/data-formula-id/.test(t2) && !/tt-chip/.test(t2) && !/>Дата</.test(t2), (t2.match(/tt-chip[^"]*/) || [])[0]);
      ok('зачёркнутых плашек нет — каталог формул подхватился', !/line-through/.test(t2));
      ok('титул отделён разрывом страницы', /page-break-after:always/.test(t2));
    }

    console.log('8. Ошибок в консоли нет');
    // Свои ошибки движка про отсутствующие шрифты не считаем: их нет в контейнере
    const real = errors.filter(e => !/font|Font|favicon|ResizeObserver/.test(e));
    ok('исключений и ответов 4xx/5xx не было', real.length === 0, real.slice(0, 4));
  } finally {
    await page.screenshot({ path: '/tmp/word-editor.png', fullPage: false }).catch(() => {});
    await browser.close().catch(() => {});
    // За собой убираем: документ, шаблон титула и формулы проекта
    await api('DELETE', `/api/constructor/docs/${docId}`).catch(() => {});
    if (tplId) await api('DELETE', `/api/constructor/docs/${tplId}`).catch(() => {});
    for (const id of formulaIds) await api('DELETE', `/api/formulas/${id}`).catch(() => {});
  }

  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
