import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
/**
 * Настройки → «Пароль»: человек меняет свой пароль (PUT своего профиля с
 * currentPassword). Ответы сервера заданы сценарием; настоящие правила пароля
 * проверяет scripts/test-review-auth-live.ts.
 * Ждём состояния страницы (появился текст, пропала кнопка), а не таймеры.
 * SHOT=путь — снимки в обеих темах.
 */
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
let checks = 0;
const check = (label: string, condition: boolean, detail?: unknown) => { assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); checks++; };

async function open(browser: any, role: string, answer: (body: any) => { status: number; json: any } | null) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.stack || e.message));
  const puts: any[] = [];
  await page.route('**/api/**', async (route: any) => {
    const url = route.request().url();
    if (route.request().method() === 'PUT' && url.endsWith('/api/users/u-self')) {
      const body = route.request().postDataJSON();
      puts.push(body);
      const reply = answer(body);
      if (!reply) return route.abort('connectionrefused');
      return route.fulfill({ status: reply.status, json: reply.json });
    }
    if (url.endsWith('/api/logout')) return route.fulfill({ json: { success: true } });
    return route.fulfill({ json: [] });
  });
  await page.goto(`${BASE}/scripts/fixtures/password-section-ui.html?role=${role}`);
  return { page, errors, puts };
}

async function run() {
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    // Владельцу раздела нет: у него нет входа по паролю
    {
      const { page } = await open(browser, 'OWNER', () => ({ status: 200, json: {} }));
      await page.getByRole('navigation', { name: 'Категории настроек' }).waitFor();
      check('владельцу пункт «Пароль» не показан', await page.locator('[data-tour="settings-password"]').count() === 0);
      check('и прямой адрес не открывает форму', await page.getByTestId('password-section').count() === 0);
      await page.close();
    }

    const mode = { value: 'wrong' as 'wrong' | 'short' | 'offline' | 'ok' };
    const { page, errors, puts } = await open(browser, 'ADMIN', () => mode.value === 'wrong'
      ? { status: 403, json: { success: false, message: 'Для смены своего пароля введите текущий пароль.' } }
      : mode.value === 'offline' ? null
      : mode.value === 'short' ? { status: 400, json: { success: false, message: 'Пароль не короче 8 символов.' } }
      : { status: 200, json: { success: true, user: { id: 'u-self' } } });
    const section = page.getByTestId('password-section');
    await section.waitFor({ timeout: 15000 });
    const current = section.getByLabel(/^Текущий пароль/);
    const next = section.getByLabel(/^Новый пароль/);
    const repeat = section.getByLabel(/^Повторите новый пароль/);
    const submit = section.getByRole('button', { name: 'Сменить пароль' });
    const shot = process.env.SHOT;
    const snap = async (name: string) => {
      if (!shot) return;
      for (const dark of [false, true]) {
        await page.evaluate((d) => document.documentElement.classList.toggle('dark', d), dark);
        await page.screenshot({ path: shot.replace(/\.png$/, `-${name}${dark ? '-dark' : ''}.png`) });
      }
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    };

    check('пункт «Пароль» есть в списке настроек', await page.locator('[data-tour="settings-password"]').count() === 1);
    check('три поля пароля скрывают ввод', await section.locator('input[type=password]').count() === 3);
    check('автозаполнение: текущий и новый различаются', await current.getAttribute('autocomplete') === 'current-password' && await next.getAttribute('autocomplete') === 'new-password');
    // Замер: поля одной ширины и не мельче 12 px, кнопка в стандартной высоте
    const sizes = await section.evaluate((root) => ({
      inputs: [...root.querySelectorAll('input')].map((i) => Math.round(i.getBoundingClientRect().height)),
      font: Math.min(...[...root.querySelectorAll('label span, p, button')].map((e) => parseFloat(getComputedStyle(e).fontSize))),
      button: Math.round(root.querySelector('button')!.getBoundingClientRect().height),
    }));
    check('поля ввода 28-32 px, кнопка 28-32 px, текст не мельче 12 px', sizes.inputs.every((h) => h >= 28 && h <= 32) && sizes.button >= 28 && sizes.button <= 32 && sizes.font >= 12, sizes);
    await snap('empty');

    // Проверки на месте, до отправки: на сервер ничего не уходит
    await submit.click();
    await section.getByText('Введите текущий пароль.').waitFor();
    await current.fill('old-password');
    await next.fill('short');
    await submit.click();
    await section.getByText('Новый пароль не короче 8 символов.').waitFor();
    await next.fill('old-password');
    await submit.click();
    await section.getByText('Новый пароль совпадает с текущим.').waitFor();
    await next.fill('new-password-1');
    await repeat.fill('new-password-2');
    await submit.click();
    await section.getByText('Пароли не совпадают.').waitFor();
    check('ошибка привязана к полю (aria-invalid, aria-describedby)', await repeat.getAttribute('aria-invalid') === 'true' && !!(await repeat.getAttribute('aria-describedby')));
    check('до отправки на сервер ничего не ушло', puts.length === 0, puts);
    await snap('error');

    // Сервер: неверный текущий пароль
    await repeat.fill('new-password-1');
    await submit.click();
    await section.getByText('Текущий пароль указан неверно.').waitFor({ timeout: 5000 }).catch(async (e) => { console.error('СТРАНИЦА:', (await section.innerText()), 'PUTS:', JSON.stringify(puts), 'ERR:', errors.join(';')); throw e; });
    check('на сервер ушёл пароль и текущий пароль своего профиля', puts.length === 1 && puts[0].password === 'new-password-1' && puts[0].currentPassword === 'old-password', puts);
    check('причина показана у поля текущего пароля', await current.getAttribute('aria-invalid') === 'true');
    check('ввод не потерян после отказа', await next.inputValue() === 'new-password-1');

    // Сервер: любое другое сообщение показывается как есть
    mode.value = 'short';
    await submit.click();
    await section.getByText('Пароль не короче 8 символов.').waitFor();
    check('отказ сервера по длине показан у нового пароля', await next.getAttribute('aria-invalid') === 'true');

    // Нет связи: пароль не менялся, и «успеха» из автономной копии быть не должно
    mode.value = 'offline';
    await submit.click();
    await section.getByText('Нет связи с сервером. Пароль не изменён, повторите позже.').waitFor();
    check('при обрыве связи форма остаётся, успех не показан', await page.getByTestId('password-done').count() === 0 && await submit.isEnabled());

    // Успех: рассказано про завершение сессий; форма очищена и закрыта
    mode.value = 'ok';
    await submit.click();
    await page.getByTestId('password-done').waitFor();
    const done = await page.getByTestId('password-done').innerText();
    check('после смены сказано, что сессии завершены везде и здесь', /Пароль изменён/.test(done) && /завершены везде/.test(done) && /войдите с новым паролем/.test(done), done);
    check('поля пароля убраны вместе с введённым', await page.locator('input[type=password]').count() === 0);
    await snap('done');
    check('уведомление об этом же осталось', (await page.evaluate(() => (window as any).__toasts() as string[])).includes('Пароль изменён. Все сессии завершены — войдите с новым паролем.'));

    // «Войти заново» выводит из профиля
    await page.getByRole('button', { name: 'Войти заново' }).click();
    await page.waitForFunction(() => (window as any).__user() === null, null, { timeout: 10000 });
    check('кнопка завершает вход в этом окне', true);
    check('в консоли страницы нет ошибок', errors.length === 0, errors);
  } finally {
    await browser.close();
  }
  console.log(`password-section-ui: ${checks} проверок пройдено`);
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
