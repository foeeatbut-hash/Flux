/**
 * Окно «Сообщить о проблеме» в настоящем браузере и против настоящего сервера.
 *
 * Проверяется то, что пользователь заметил руками: после отправки форма пуста
 * и старый текст не возвращается; обращений можно отправить несколько подряд
 * без ожидания; двойное нажатие даёт одну карточку; кнопка в верхней панели
 * закрывает открытую панель, а не переоткрывает её.
 *
 * Запуск: сервер с интерфейсом на FLUX_UI_URL (по умолчанию http://localhost:3917),
 * FLUX_USER / FLUX_PASS — вход, FLUX_CHROME — путь к chromium.
 */
import { testCredentials } from './testCredentials';

const BASE = process.env.FLUX_UI_URL || 'http://localhost:3917';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
let failed = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log('  ✓', name); else { failed++; console.error('  ✗', name, detail ?? ''); }
};

(async () => {
  const login = testCredentials();
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/');
    await page.getByPlaceholder('Введите логин').fill(login.symbol);
    await page.getByPlaceholder('Введите пароль').fill(login.password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    const toggle = page.locator('button[aria-label="Сообщить о проблеме"]');
    await toggle.waitFor({ state: 'attached' });
    // В браузере верхняя панель оболочки спрятана насовсем (она всплывает только
    // в окне Electron), поэтому нажимаем кнопку так, как это делает мышь: сначала
    // mousedown, затем click. Одного click мало — «клик мимо» слушает mousedown
    const press = () => toggle.evaluate((el) => {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      (el as HTMLElement).click();
    });
    const stamp = Date.now().toString(36);
    const mine = () => page.evaluate(async () => {
      const r = await fetch('/api/feedback/reports?limit=100');
      return (await r.json()).data as Array<{ title: string; number: number }>;
    });
    const panel = page.getByRole('dialog', { name: 'Сообщить о проблеме' });
    const box = panel.locator('textarea');
    const drafts = () => page.evaluate(() => new Promise<number>((resolve) => {
      const open = indexedDB.databases ? indexedDB.databases() : Promise.resolve([]);
      open.then((list: any[]) => {
        const info = list.find((d) => /draft|feedback/i.test(d.name || ''));
        if (!info) return resolve(0);
        const req = indexedDB.open(info.name);
        req.onsuccess = () => {
          const db = req.result;
          const name = db.objectStoreNames[0];
          if (!name) return resolve(0);
          const all = db.transaction(name).objectStore(name).getAll();
          all.onsuccess = () => resolve((all.result as any[]).filter((d) => d.state === 'EDITING').length);
          all.onerror = () => resolve(-1);
        };
        req.onerror = () => resolve(-1);
      });
    }));

    console.log('\n1. Кнопка открывает и закрывает панель');
    await press();
    await box.waitFor();
    await press();
    await page.waitForTimeout(400);
    check('второй клик по кнопке закрыл панель, а не открыл заново', await panel.count() === 0);

    console.log('\n2. После отправки форма пуста, старый текст не возвращается');
    await press();
    await box.fill(`__проба ${stamp} первое`);
    await page.waitForTimeout(700); // черновик успел записаться
    check('пока не отправлено, черновик в хранилище есть (контроль самой проверки)', (await drafts()) === 1, await drafts());
    await panel.getByRole('button', { name: 'Отправить' }).click();
    await panel.getByText(/Отправлено/).first().waitFor();
    // Закрытие крестиком при записи черновика — как раз то место, где текст возвращался
    await panel.getByRole('button', { name: 'Закрыть' }).click();
    await page.waitForTimeout(500);
    await press();
    await box.waitFor();
    check('после повторного открытия поле пусто', (await box.inputValue()) === '', await box.inputValue());
    check('несданных черновиков в хранилище нет', (await drafts()) === 0, await drafts());

    console.log('\n3. Несколько обращений подряд без ожидания');
    for (const n of [2, 3, 4]) {
      await box.fill(`__проба ${stamp} №${n}`);
      await panel.getByRole('button', { name: 'Отправить' }).click();
      await panel.getByText(/Отправлено/).first().waitFor();
      await panel.getByRole('button', { name: 'Ещё одно' }).click();
      check(`№${n}: поле очищено после «Ещё одно»`, (await box.inputValue()) === '');
    }
    const after = (await mine()).filter((r) => r.title.includes(stamp));
    check('на сервере все четыре обращения', after.length === 4, after.map((r) => r.title));

    console.log('\n4. Двойное нажатие даёт одну карточку');
    await box.fill(`__проба ${stamp} двойное`);
    const send = panel.getByRole('button', { name: 'Отправить' });
    await send.dblclick();
    await panel.getByText(/Отправлено/).first().waitFor();
    const doubled = (await mine()).filter((r) => r.title.includes('двойное') && r.title.includes(stamp));
    check('карточка одна', doubled.length === 1, doubled.length);

    check('ошибок страницы нет', errors.length === 0, errors);
  } finally { await browser.close(); }
  console.log(failed === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
