/**
 * Диагностика в живом окне.
 *
 * Всё остальное про запись проверяется без браузера, а вот три вещи — нет.
 *
 * Первая: подробная запись подключается на самом старте программы, до
 * отрисовки. Ошибка там не даёт разбора «часть работает» — не работает
 * ничего, и увидеть это можно только запустив.
 *
 * Вторая: в браузере моста в оболочку нет. Отсутствие моста не должно
 * считаться потерей — раньше счётчик потерь рос там, где всё было в порядке.
 *
 * Третья: пароль и логин уходят в теле запроса на вход. Проверяем, что в
 * записи их нет, — не рассуждением, а поиском по тому самому файлу, который
 * человек выгрузит кнопкой.
 *
 * Нужен поднятый сервер и собранное окно (`npx vite build`).
 */

const BASE = process.env.FLUX_API || 'http://localhost:3000';
let token = '';

async function api(method: string, path: string, body?: any) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let f = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (f++, console.error('  ✗', name, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ''));

async function main() {
  try {
    const health = await fetch(`${BASE}/api/health`);
    if (!health.ok) throw new Error(String(health.status));
  } catch (_) {
    console.error(`Сервер на ${BASE} не отвечает. Поднимите его: npx tsx server.ts`);
    process.exit(2);
  }
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); }
  catch (_) { console.error('playwright-core не установлен: npm i --no-save playwright-core'); process.exit(2); }

  // Документ заводим через API: проверяем запись работы редактора, а не то,
  // как документ создаётся
  token = (await api('POST', '/api/login', LOGIN)).json?.token || '';
  if (!token) { console.error('Не удалось войти'); process.exit(2); }
  const projectId = (await api('GET', '/api/projects')).json?.projects?.[0]?.id;
  if (!projectId) { console.error('В базе нет проекта'); process.exit(2); }
  const DOC_NAME = `__диагностика ${Date.now().toString(36).slice(-4)}`;
  const docId = (await api('POST', '/api/constructor/docs', {
    projectId, name: DOC_NAME, kind: 'TEXT', scope: 'SHARED',
  })).json?.doc?.id;
  if (!docId) { console.error('Не удалось создать документ'); process.exit(2); }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e: any) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });

  try {
    await page.route('**/api/license/status', (r: any) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
    }));
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const inputs = await page.$$('input');
    if (inputs.length >= 2) {
      await inputs[0].fill(LOGIN.symbol);
      await inputs[1].fill(LOGIN.password);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(5000);
    }

    console.log('1. Программа поднимается с включённой записью');
    ok('оболочка отрисовалась', await page.evaluate(() => !!document.querySelector('[data-taskbar]')));
    ok('в консоли нет ошибок', errors.length === 0, errors.slice(0, 5));

    console.log('\n2. Хвост есть, потерь нет');
    const status = await page.evaluate(() => (window as any).__fluxDiagnostics?.status?.() ?? null);
    ok('состояние доступно', !!status, status);
    ok('события записываются', (status?.tail || 0) > 5, status);
    // Это и есть та самая путаница: моста в браузере нет, но терять нечего
    ok('моста в браузере нет', status?.transport === false, status);
    ok('и отсутствие моста не считается потерей', status?.dropped === 0, status);

    console.log('\n3. В выгрузке нет ни пароля, ни логина');
    const dump: any[] = await page.evaluate(() => {
      const original = URL.createObjectURL;
      let captured: Blob | null = null;
      (URL as any).createObjectURL = (b: Blob) => { captured = b; return original.call(URL, b); };
      (window as any).__fluxDiagnostics?.save?.();
      (URL as any).createObjectURL = original;
      if (!captured) return Promise.resolve([]);
      return (captured as Blob).text().then((t) => t.trim().split('\n').slice(1)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
    });
    const text = JSON.stringify(dump);
    ok('выгрузка не пуста', dump.length > 5, dump.length);
    ok('пароля в выгрузке нет', !text.includes(LOGIN.password), text.slice(0, 200));
    ok('логина в выгрузке нет', !text.includes(LOGIN.symbol));
    ok('тела ответов в выгрузке нет', !/"(json|body|payload|content)"\s*:/.test(text));

    console.log('\n4. Запросы измеряются от начала до чтения тела');
    const names = new Set(dump.map((e) => e.event));
    ok('заголовки ответа замерены', names.has('fetch.headers'), [...names]);
    ok('чтение тела замерено отдельно', names.has('fetch.consume'), [...names]);
    ok('у запросов есть общая метка', dump.filter((e) => e.data?.trace).length > 3);
    // В обычном режиме начала участков не пишутся: иначе объём вдвое, а
    // пользы никакой, пока не включён подробный разбор
    ok('начала запросов в обычном режиме не пишутся', !names.has('fetch.start'), [...names]);

    console.log('\n5. Работа офисного движка измеряется');
    await page.evaluate((id: string) => { window.location.hash = `#/doc?doc=${id}`; }, docId);
    await page.waitForTimeout(9000);
    const office: any[] = await page.evaluate(() => {
      const original = URL.createObjectURL;
      let captured: Blob | null = null;
      (URL as any).createObjectURL = (b: Blob) => { captured = b; return original.call(URL, b); };
      (window as any).__fluxDiagnostics?.save?.();
      (URL as any).createObjectURL = original;
      if (!captured) return Promise.resolve([]);
      return (captured as Blob).text().then((t) => t.trim().split('\n').slice(1)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e: any) => e && String(e.event).startsWith('office.')));
    });
    const officeNames = new Set(office.map((e) => e.event));
    ok('открытие редактора замерено', officeNames.has('office.init'), [...officeNames]);
    const init = office.find((e) => e.event === 'office.init');
    ok('загрузка модулей и сборка документа посчитаны порознь',
      typeof init?.data?.modulesMs === 'number' && typeof init?.data?.bookMs === 'number', init?.data);
    // Имя документа не должно попасть в запись ни одним путём
    ok('имени документа в записи нет', !JSON.stringify(office).includes(DOC_NAME));
    ok('настоящего идентификатора документа в записи нет', !JSON.stringify(office).includes(docId));
    ok('но события об одном документе связаны общей меткой',
      new Set(office.map((e) => e.data?.documentRef).filter(Boolean)).size <= 1,
      office.map((e) => e.data?.documentRef));
    // Снимок берётся каждые 2,5 секунды: в обычном режиме это тысячи
    // одинаковых строк в час, и его место — в подробном режиме
    ok('снимок в обычном режиме не пишется', !officeNames.has('office.snapshot'), [...officeNames]);
  } finally {
    await browser.close();
    // Сначала браузер, потом данные: редактор досохраняет с задержкой, и
    // запись, удалённая при живой странице, появляется снова
    await api('DELETE', `/api/constructor/docs/${docId}`).catch(() => {});
  }

  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
}

void main().catch((error) => { console.error(error); process.exit(1); });
