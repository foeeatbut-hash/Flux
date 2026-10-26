/**
 * Окно «Сохранить в Проводнике Flux» в браузере: подменённый мост windowsFiles
 * с папками в памяти (как в scripts/test-import-file-chooser-ui.ts).
 *
 *   FLUX_UI_URL=http://127.0.0.1:4733 FLUX_CHROME=... tsx scripts/test-flux-save-dialog-ui.ts
 *   FLUX_SNAP_DIR=/tmp/снимки — куда класть снимки обеих тем
 *
 * Страница — scripts/fixtures/flux-save-dialog.html; Vite запускается отдельно.
 * Проверяется поведение окна на подменённом мосте, не запись на настоящий диск Windows.
 */
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';
const SNAP = process.env.FLUX_SNAP_DIR || '';

const BRIDGE = `
(() => {
  const fs = {
    docs: { dirs: new Set(['Отчёты', 'Проекты', 'Отчёты/Архив']), files: { 'Читаю.txt': 'x', 'Отчёты/Смета.xlsx': 'старое', 'Отчёты/Март.docx': 'м' } },
    d: { dirs: new Set(['Резерв']), files: {} },
  };
  const names = { docs: 'Документы', d: 'Диск D' };
  const view = {};
  window.__fs = fs; window.__log = [];
  const parent = p => p.split('/').slice(0, -1).join('/');
  const base = p => p.split('/').pop();
  const entryOf = (rootId, rel) => {
    const f = fs[rootId];
    if (f.dirs.has(rel)) return { name: base(rel), relativePath: rel, rootId, storage: 'windows', kind: 'directory', fileId: 'd:' + rel, size: 0, modifiedAt: '', linked: false };
    if (rel in f.files) return { name: base(rel), relativePath: rel, rootId, storage: 'windows', kind: 'file', fileId: 'f:' + rel, size: f.files[rel].length * 1000, modifiedAt: '', linked: false };
    return null;
  };
  const bad = (code, message) => ({ ok: false, error: { code, message } });
  window.electron = { windowsFiles: { onChanged: () => () => {}, invoke: async r => {
    window.__log.push(r.action);
    if (r.action === 'roots') return { ok: true, data: Object.keys(fs).map(id => ({ id, name: names[id], kind: 'custom', available: true })) };
    if (r.action === 'viewStateGet') return { ok: true, data: Object.fromEntries(r.keys.filter(k => k in view).map(k => [k, view[k]])) };
    if (r.action === 'viewStateSet') { Object.assign(view, r.entries); return { ok: true, data: { stored: 1 } }; }
    if (r.action === 'resolveAddress') return r.text === 'C:\\\\Работа\\\\Отчёты' ? { ok: true, data: { rootId: 'docs', relativePath: 'Отчёты' } } : { ok: true, data: null };
    if (r.action === 'list') {
      const f = fs[r.ref.rootId]; const rel = r.ref.relativePath;
      if (rel && !f.dirs.has(rel)) return bad('ENOENT', 'Папки больше нет.');
      const kids = [...f.dirs, ...Object.keys(f.files)].filter(p => parent(p) === rel).map(p => entryOf(r.ref.rootId, p));
      kids.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'ru') : a.kind === 'directory' ? -1 : 1));
      return { ok: true, data: { entries: kids, nextOffset: null } };
    }
    if (r.action === 'stat') { const e = entryOf(r.ref.rootId, r.ref.relativePath); return e ? { ok: true, data: e } : bad('ENOENT', 'Нет такого файла.'); }
    if (r.action === 'mkdir') { const rel = (r.parent.relativePath ? r.parent.relativePath + '/' : '') + r.name; fs[r.parent.rootId].dirs.add(rel); return { ok: true, data: entryOf(r.parent.rootId, rel) }; }
    if (r.action === 'publish') {
      const rel = (r.parent.relativePath ? r.parent.relativePath + '/' : '') + r.name; const f = fs[r.parent.rootId];
      if (rel in f.files || f.dirs.has(rel)) return bad('EEXIST', 'Занято.');
      f.files[rel] = atob(r.base64); return { ok: true, data: { ref: { rootId: r.parent.rootId, relativePath: rel } } };
    }
    if (r.action === 'fileHash') return { ok: true, data: { sha256: 'h:' + fs[r.ref.rootId].files[r.ref.relativePath] } };
    if (r.action === 'write') { fs[r.ref.rootId].files[r.ref.relativePath] = atob(r.base64); return { ok: true, data: {} }; }
    return bad('UNEXPECTED', 'Unexpected ' + r.action);
  } } };
})();
`;

void (async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  let failed = false;
  const check = (name: string, value: boolean) => { if (value) console.log(`✓ ${name}`); else { failed = true; console.error(`✗ ${name}`); } };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript({ content: BRIDGE });
    await page.goto(`${BASE}/scripts/fixtures/flux-save-dialog.html`);
    const dialog = page.getByRole('dialog', { name: 'Сохранить в Проводнике Flux' });
    const result = page.getByLabel('Результат');

    // 1. Занятое имя: окно спрашивает, а не затирает
    await page.getByRole('button', { name: 'Сохранить смету' }).click();
    await dialog.waitFor();
    check('окно открывается на первом диске, имя подставлено', await dialog.getByLabel('Имя файла').inputValue() === 'Смета.xlsx' && await dialog.getByLabel('Папка Windows').inputValue() === 'docs');
    await dialog.getByRole('button', { name: 'Отчёты' }).click();
    await dialog.getByText('Март.docx').waitFor();
    check('файлы папки видны приглушённо, папки — перед ними', await dialog.getByLabel('Содержимое папки').locator('button').first().textContent().then(t => t?.includes('Архив') ?? false));
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await dialog.getByText('Файл «Смета.xlsx» уже есть в этой папке.').waitFor();
    check('занятое имя: ничего не записано, предложены «Заменить» / «Оставить оба»', await page.evaluate(() => (window as any).__fs.docs.files['Отчёты/Смета.xlsx'] === 'старое') && await dialog.getByRole('button', { name: 'Заменить' }).count() === 1 && await dialog.getByRole('button', { name: 'Оставить оба' }).count() === 1);

    // снимки окна с вопросом о замене в обеих темах + замеры
    const box = await dialog.locator('.fx-dialog').boundingBox();
    check('окно помещается в экран и компактно (не выше 480 px)', !!box && box.height <= 480 && box.width <= 600 && box.y >= 0);
    if (SNAP) {
      await page.screenshot({ path: `${SNAP}/save-dialog-light.png` });
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.waitForTimeout(600); // тема переключается плавно
      await page.screenshot({ path: `${SNAP}/save-dialog-dark.png` });
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    }

    await dialog.getByRole('button', { name: 'Оставить оба' }).click();
    await dialog.waitFor({ state: 'detached' });
    check('«Оставить оба»: рядом лёг «Смета (2).xlsx», старый нетронут', await page.evaluate(() => { const f = (window as any).__fs.docs.files; return f['Отчёты/Смета (2).xlsx'] === '\u0001\u0002\u0003' && f['Отчёты/Смета.xlsx'] === 'старое'; }));
    check('вызывающему возвращён человекочитаемый путь', (await result.textContent())?.includes('Документы\\\\Отчёты\\\\Смета (2).xlsx') === true);
    check('человеку сказано, куда лёг файл', await page.getByText('Сохранено: Документы\\Отчёты\\Смета (2).xlsx').count() === 1);

    // 2. Последняя папка запомнена; замена с подтверждением
    await page.getByRole('button', { name: 'Сохранить смету' }).click();
    await dialog.waitFor();
    await dialog.getByText('Март.docx').waitFor();
    check('следующее окно открывается в последней папке', await dialog.getByRole('navigation', { name: 'Путь к папке' }).textContent().then(t => (t || '').includes('Отчёты')));
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await dialog.getByRole('button', { name: 'Заменить' }).click();
    await dialog.waitFor({ state: 'detached' });
    check('«Заменить» записывает новое содержимое поверх', await page.evaluate(() => (window as any).__fs.docs.files['Отчёты/Смета.xlsx'] === '\u0001\u0002\u0003'));

    // 3. Новая папка и другое имя
    await page.getByRole('button', { name: 'Сохранить смету' }).click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Новая папка' }).click();
    await dialog.getByLabel('Имя новой папки').fill('Мартовские');
    await dialog.getByRole('button', { name: 'Создать' }).click();
    await dialog.getByRole('button', { name: 'Мартовские' }).waitFor();
    await dialog.getByLabel('Имя файла').fill('Итог: март.xlsx');
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await dialog.getByText('В имени нельзя использовать знаки').waitFor();
    check('недопустимое имя объяснено до записи', true);
    await dialog.getByLabel('Имя файла').fill('Итог март.xlsx');
    await dialog.getByLabel('Имя файла').press('Enter');
    await dialog.waitFor({ state: 'detached' });
    check('новая папка создана, файл лёг в неё', await page.evaluate(() => (window as any).__fs.docs.files['Отчёты/Мартовские/Итог март.xlsx'] === '\u0001\u0002\u0003'));

    // 4. Esc закрывает без ошибки
    await page.getByRole('button', { name: 'Сохранить смету' }).click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    check('Esc: отмена — не ошибка', (await result.textContent())?.includes('"canceled":true') === true && (await result.textContent())?.includes('"ok":false') === true);

    // 5. Папка рядом с источником файла имеет приоритет над последней
    await page.evaluate(() => { (window as any).__originDir = 'C:\\Работа\\Отчёты'; });
    await page.getByRole('button', { name: 'Сохранить смету' }).click();
    await dialog.waitFor();
    await dialog.getByText('Март.docx').waitFor();
    check('рядом с источником: окно открылось в папке, откуда файл принесли', await dialog.getByRole('navigation', { name: 'Путь к папке' }).textContent().then(t => (t || '').endsWith('Отчёты')));
    await dialog.getByRole('button', { name: 'Отмена' }).click();
    await dialog.waitFor({ state: 'detached' });

    // 6. Выбор папки
    await page.getByRole('button', { name: 'Выбрать папку' }).click();
    const folderDialog = page.getByRole('dialog', { name: 'Куда сохранить папку' });
    await folderDialog.waitFor();
    check('режим папки: поля имени файла нет, есть кнопка действия', await folderDialog.getByLabel('Имя файла').count() === 0 && await folderDialog.getByRole('button', { name: 'Сохранить сюда' }).count() === 1);
    await folderDialog.getByRole('navigation', { name: 'Путь к папке' }).getByRole('button', { name: 'Документы' }).click();
    await folderDialog.getByRole('button', { name: 'Проекты' }).click();
    await folderDialog.getByRole('button', { name: 'Сохранить сюда' }).click();
    await folderDialog.waitFor({ state: 'detached' });
    check('папка возвращена ссылкой, без абсолютного пути', (await result.textContent()) === '{"rootId":"docs","relativePath":"Проекты"}');

    // 7. Узкое окно
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByRole('button', { name: 'Сохранить смету' }).click();
    await dialog.waitFor();
    const narrow = await dialog.locator('.fx-dialog').boundingBox();
    check('на узком экране окно не шире экрана, горизонтальной прокрутки нет', !!narrow && narrow.x >= 0 && narrow.x + narrow.width <= 390 && await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    if (SNAP) await page.screenshot({ path: `${SNAP}/save-dialog-narrow.png` });
    await page.keyboard.press('Escape');

    check('в окне нет ошибок браузера', errors.length === 0);
    if (errors.length) console.error(errors.join('\n'));
  } finally { await browser.close(); }
  if (failed) process.exit(1);
})();
