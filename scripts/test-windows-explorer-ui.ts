/** Браузерная проверка Проводника с имитацией нативного файлового моста. */
import { EXPLORER_KEYS, type KeyAction } from '../src/components/files/explorerKeys';

const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';
let passed = 0; let failed = 0;
const ok = (name: string, value: boolean) => { if (value) { passed++; console.log('✓', name); } else { failed++; console.error('✗', name); } };
const MENU = 'body > [data-context-menu]';
const KINDS = ['Папку', 'Документ Word', 'Книгу Excel', 'Текстовый файл', 'Архив ZIP'];
type Page = import('playwright-core').Page;
/** Панель «Создать» из меню пустого места: «Создать ▸» и нужный раздел раскрыты, мышь стоит на разделе. */
async function openCreateMenu(page: Page, section: 'В Windows' | 'В Flux') {
  await page.locator('main').click({ button: 'right', position: { x: 600, y: 400 } });
  await page.locator(MENU).first().getByRole('button', { name: 'Создать', exact: true }).hover();
  await page.getByRole('button', { name: section, exact: true }).hover();
  await page.locator(MENU).last().getByRole('button', { name: 'Папку', exact: true }).waitFor();
}
/** Создать объект через панель и дождаться закрытия окна имени. */
async function createVia(page: Page, section: 'В Windows' | 'В Flux', item: string, name?: string) {
  await openCreateMenu(page, section);
  await page.locator(MENU).last().getByRole('button', { name: item, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  if (name !== undefined) await dialog.getByLabel('Имя').fill(name);
  await dialog.getByRole('button', { name: 'Создать', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`); });
    await page.goto(`${BASE}/scripts/fixtures/windows-explorer-ui.html`);
    await page.getByRole('heading', { name: 'Проводник' }).waitFor();
    await page.getByRole('row', { name: /Проекты/ }).waitFor();
    ok('Нативный sidebar загружает подключённые папки и список', await page.getByRole('button', { name: 'Документы', exact: true }).isVisible() && await page.getByRole('row', { name: /Инструкция\.docx/ }).isVisible());
    await page.getByRole('button', { name: 'Общий доступ', exact: true }).click();
    await page.getByRole('heading', { name: 'Общий доступ' }).waitFor();
    ok('Общий доступ открывается внутренней папкой того же Проводника', await page.getByText('Папка «Общий доступ» пуста').isVisible() && (await page.getByTestId('route').textContent())?.includes('view=shared'));
    await page.getByRole('button', { name: 'Проводник' }).click();
    await page.getByRole('heading', { name: 'Проводник' }).waitFor();
    await page.getByRole('row', { name: /Проекты/ }).waitFor();
    ok('Возврат из общего доступа сохраняет текущую папку Windows', (await page.getByTestId('route').textContent())?.includes('root=desktop-id') === true);
    await page.evaluate(() => (window as any).__go('/windows-files?root=desktop-id&path='));
    await page.getByRole('heading', { name: 'Проводник' }).waitFor();
    ok('Сохранённый адрес «Файлы Windows» открывает ту же программу', await page.getByRole('row', { name: /Инструкция\.docx/ }).isVisible());
    await page.evaluate(() => (window as any).__go('/explorer?root=desktop-id&path='));
    await page.getByRole('row', { name: /Инструкция\.docx/ }).waitFor();
    await page.getByRole('row', { name: /Проекты/ }).locator('img[src^="data:image/png;"]').waitFor();
    ok('Папка использует PNG из нативного моста', await page.getByRole('row', { name: /Проекты/ }).locator('img').evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0));

    await page.getByRole('row', { name: /Проекты/ }).dblclick();
    await page.getByRole('row', { name: /Отчёт\.xlsx/ }).waitFor();
    ok('Двойное нажатие входит в папку и обновляет путь', (await page.getByTestId('route').textContent())?.includes('path=Проекты') || await page.getByRole('button', { name: 'Проекты', exact: true }).isVisible());
    await page.getByLabel('Путь').getByRole('button', { name: 'Рабочий стол', exact: true }).click();
    await page.getByRole('row', { name: /Инструкция\.docx/ }).waitFor();
    ok('Повторный переход в папку сохраняет предыдущий шаг истории', await page.getByRole('button', { name: 'Назад' }).isEnabled());
    await page.getByRole('button', { name: 'Назад' }).click();
    await page.getByRole('row', { name: /Отчёт\.xlsx/ }).waitFor();
    ok('Назад после повторного перехода возвращает к последней посещённой папке', await page.getByRole('row', { name: /Отчёт\.xlsx/ }).isVisible());
    for (let step = 0; step < 5; step++) {
      await page.getByLabel('Путь').getByRole('button', { name: 'Рабочий стол', exact: true }).click();
      await page.getByRole('row', { name: /Инструкция\.docx/ }).waitFor();
      await page.getByRole('button', { name: 'Назад' }).click();
      await page.getByRole('row', { name: /Отчёт\.xlsx/ }).waitFor();
    }
    ok('Быстрые повторные переходы не теряют историю', await page.getByRole('button', { name: 'Вперёд' }).isEnabled());
    await page.getByRole('textbox', { name: 'Поиск по имени' }).fill('Отчёт');
    ok('Поиск по имени оставляет совпадение', await page.getByRole('row', { name: /Отчёт\.xlsx/ }).count() === 1 && await page.getByRole('row', { name: /Архив/ }).count() === 0);

    await page.getByRole('button', { name: 'Свойства Отчёт.xlsx' }).click();
    await page.getByRole('dialog', { name: /Свойства/ }).waitFor();
    ok('Свойства показывают проекты, теги и историю', await page.getByText('Проект 1 · текущий').isVisible() && await page.getByText('AHU-01', { exact: true }).count() >= 1 && await page.getByText(/История файла/).isVisible());
    await page.getByRole('button', { name: 'Сохранить свойства' }).click();
    ok('Свойства отправляются только в windowsFiles bridge', await page.evaluate(() => (window as any).__windowsFilesCalls.some((request: any) => request.action === 'setMetadata')));

    await page.evaluate(() => (window as any).__go('/explorer?root=desktop-id&path='));
    await page.getByRole('textbox', { name: 'Поиск по имени' }).fill('');
    await page.getByRole('row', { name: /Инструкция\.docx/ }).waitFor();
    await page.evaluate(() => { (window as any).__delayMetadataPath('Инструкция.docx'); (window as any).__failMetadataPath('Инструкция.docx'); });
    await page.getByRole('button', { name: 'Свойства Инструкция.docx' }).click();
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.getByRole('button', { name: 'Свойства Архив.bin' }).click();
    await page.getByRole('dialog', { name: /Свойства · Архив\.bin/ }).waitFor();
    await page.waitForTimeout(400);
    ok('Поздний сбой закрытой карточки не портит новую карточку', await page.getByLabel('Ревизия').inputValue() === 'Архив.bin' && await page.getByRole('alert').count() === 0);
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();

    await page.getByRole('button', { name: 'Проекты', exact: true }).click();
    await page.getByRole('row', { name: /Отчёт\.xlsx/ }).waitFor();
    await page.getByRole('button', { name: 'Назад' }).click();
    await page.getByRole('row', { name: /Инструкция\.docx/ }).waitFor();
    ok('Кнопка «Назад» возвращает к исходной папке', (await page.getByTestId('route').textContent())?.includes('path=') === true && await page.getByRole('row', { name: /Инструкция\.docx/ }).isVisible());
    await page.evaluate(() => (window as any).__delayListPath('Проекты'));
    await page.getByRole('button', { name: 'Проекты', exact: true }).click();
    await page.getByLabel('Путь').getByRole('button', { name: 'Проекты', exact: true }).waitFor();
    await page.getByLabel('Путь').getByRole('button', { name: 'Рабочий стол', exact: true }).click();
    await page.waitForTimeout(700);
    ok('Запоздалый список старой папки не подменяет текущую', await page.getByRole('row', { name: /Инструкция\.docx/ }).isVisible() && await page.getByRole('row', { name: /Отчёт\.xlsx/ }).count() === 0);
    await page.evaluate(() => (window as any).__delayListPath(''));

    await page.evaluate(() => (window as any).__go('/explorer?root=desktop-id&path=Проекты&target=Проекты%2FОтчёт.xlsx&properties=1'));
    await page.getByRole('dialog', { name: /Свойства · Отчёт\.xlsx/ }).waitFor();
    ok('Deep link свойств загружает родительскую папку и выбирает целевой файл', await page.evaluate(() => (window as any).__windowsFilesCalls.some((request: any) => request.action === 'list' && request.ref.relativePath === 'Проекты')) && await page.getByText('Проект 1 · текущий').isVisible());
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();

    ok('Шапка Проводника без кнопок создания: создание только правой кнопкой', await page.getByRole('banner').getByRole('button', { name: /Создать|Новая папка/ }).count() === 0);
    await openCreateMenu(page, 'В Windows');
    ok('«Создать ▸»: раздел «В Windows» с пятью пунктами', JSON.stringify(await page.locator(MENU).last().locator('button').allInnerTexts()) === JSON.stringify(KINDS));
    await page.getByRole('button', { name: 'В Flux', exact: true }).hover();
    await page.waitForTimeout(450);
    await page.locator(MENU).last().getByRole('button', { name: 'Архив ZIP', exact: true }).waitFor();
    ok('«Создать ▸»: раздел «В Flux» с теми же пятью пунктами', JSON.stringify(await page.locator(MENU).last().locator('button').allInnerTexts()) === JSON.stringify(KINDS));
    ok('Старые пункты «Создать в Flux» и «Создать папку в Windows» из меню пустого места убраны', await page.locator(MENU).first().getByRole('button', { name: /Создать в Flux|Создать папку в Windows/ }).count() === 0);
    await page.keyboard.press('Escape');
    await createVia(page, 'В Windows', 'Папку', 'Чертежи');
    ok('Папка Windows: mkdir с родителем «Проекты» и введённым именем', await page.evaluate(() => (window as any).__windowsFilesCalls.some((request: any) => request.action === 'mkdir' && request.name === 'Чертежи' && request.parent.relativePath === 'Проекты')));
    await page.getByRole('row', { name: /Чертежи/ }).waitFor();
    ok('Созданная папка Windows появляется в списке и выделена', await page.getByRole('row', { name: /Чертежи/ }).getAttribute('aria-selected') === 'true');
    const draftsBefore = await page.evaluate(() => (window as any).__windowsFilesCalls.filter((request: any) => request.action === 'publishDraft').length);
    await createVia(page, 'В Flux', 'Документ Word');
    ok('Документ Flux: createDraft с именем по умолчанию, без публикации', await page.evaluate((before) => {
      const calls = (window as any).__windowsFilesCalls;
      return calls.some((request: any) => request.action === 'createDraft' && request.name === 'Новый документ.docx' && request.parent.relativePath === 'Проекты') && calls.filter((request: any) => request.action === 'publishDraft').length === before;
    }, draftsBefore));
    await page.getByRole('row', { name: /Новый документ\.docx/ }).waitFor();
    await page.getByRole('row', { name: /Новый документ\.docx/ }).click();
    await page.getByRole('button', { name: /Опубликовать/ }).click();
    ok('Публикация черновика запускается отдельно', await page.evaluate((before) => (window as any).__windowsFilesCalls.filter((request: any) => request.action === 'publishDraft').length > before, draftsBefore));

    await page.getByRole('button', { name: 'Этот компьютер', exact: true }).click();
    await page.getByRole('button', { name: /Локальный диск \(C:\)/ }).waitFor();
    ok('Этот компьютер показывает подключённые тома из нативного моста', await page.evaluate(() => (window as any).__windowsFilesCalls.some((request: any) => request.action === 'volumes')));
    await page.getByRole('button', { name: /Локальный диск \(C:\)/ }).click();
    await page.getByRole('row', { name: /Fluxdraftfolders/ }).waitFor();
    ok('Том открывается и показывает папку Fluxdraftfolders', await page.getByRole('row', { name: /Fluxdraftfolders/ }).isVisible());
    await page.getByRole('row', { name: /Fluxdraftfolders/ }).dblclick();
    await page.getByRole('row', { name: /Fluxdraftfolders/ }).waitFor({ state: 'detached' });
    await createVia(page, 'В Flux', 'Папку', 'Экспортируемая папка');
    ok('Создание папки Flux отправляет createDraftFolder с родительским путём', await page.evaluate(() => {
      const request = (window as any).__windowsFilesCalls.find((item: any) => item.action === 'createDraftFolder');
      return request?.name === 'Экспортируемая папка' && request?.parent?.relativePath === 'Fluxdraftfolders' && request?.parent?.rootId === 'disk-c';
    }));
    const folderDraftId = await page.evaluate(() => (window as any).__draftFolderIds[0]);
    await page.evaluate((draftId) => (window as any).__go(`/explorer?root=disk-c&path=Fluxdraftfolders%2FЭкспортируемая%20папка&draft=${draftId}`), folderDraftId);
    await page.locator('main').click({ button: 'right', position: { x: 600, y: 400 } });
    await page.locator(MENU).first().getByRole('button', { name: 'Создать', exact: true }).hover();
    await page.getByRole('button', { name: 'В Flux', exact: true }).waitFor();
    ok('В папке-черновике Flux раздела «В Windows» нет: там нет настоящего каталога', await page.getByRole('button', { name: 'В Windows', exact: true }).count() === 0);
    await page.keyboard.press('Escape');
    await createVia(page, 'В Flux', 'Документ Word', 'Вложенный документ.docx');
    ok('Вложенный документ записывается под draft ref папки Flux', await page.evaluate((draftId) => {
      const request = (window as any).__windowsFilesCalls.find((item: any) => item.action === 'createDraft' && item.name === 'Вложенный документ.docx');
      return request?.parent?.draftId === draftId && request?.parent?.relativePath === 'Fluxdraftfolders/Экспортируемая папка';
    }, folderDraftId));
    await page.evaluate(() => (window as any).__go('/explorer?root=disk-c&path=Fluxdraftfolders'));
    const draftFolder = page.getByRole('row', { name: /Экспортируемая папка/ });
    await draftFolder.waitFor();
    await draftFolder.click({ button: 'right' });
    await page.locator('[data-context-menu]').getByRole('button', { name: 'Опубликовать в Windows' }).click();
    await page.waitForFunction(() => (window as any).__windowsFilesCalls.some((request: any) => request.action === 'publishDraftTree'));
    ok('Публикация папки с вложенным документом отправляет publishDraftTree с draft ref', await page.evaluate(() => {
      const request = (window as any).__windowsFilesCalls.find((item: any) => item.action === 'publishDraftTree');
      return request?.ref?.rootId === 'disk-c' && request?.ref?.relativePath === 'Fluxdraftfolders/Экспортируемая папка' && !!request?.ref?.draftId;
    }));
    await page.evaluate(() => (window as any).__go('/explorer?root=desktop-id&path=Проекты'));
    await page.getByRole('row', { name: /Отчёт\.xlsx/ }).waitFor();

    await page.getByRole('row', { name: /Отчёт\.xlsx/ }).click();
    await page.getByRole('button', { name: 'Копировать', exact: true }).click();
    await page.locator('main').click({ button: 'right', position: { x: 600, y: 400 } });
    const freeMenu = page.locator(MENU).first();
    const copyMoveCountBeforeMenu = await page.evaluate(() => (window as any).__windowsFilesCalls.filter((request: any) => ['copy', 'move'].includes(request.action)).length);
    ok('ПКМ по пустому месту с буфером не вставляет файл автоматически', await freeMenu.getByRole('button', { name: 'Вставить', exact: true }).isVisible() && await page.evaluate((count) => (window as any).__windowsFilesCalls.filter((request: any) => ['copy', 'move'].includes(request.action)).length === count, copyMoveCountBeforeMenu));
    await page.keyboard.press('Escape');

    await createVia(page, 'В Flux', 'Текстовый файл');
    ok('Текстовый черновик: имя по умолчанию и пустое содержимое', await page.evaluate(() => {
      const request = (window as any).__windowsFilesCalls.find((item: any) => item.action === 'createDraft' && item.name === 'Новый текстовый документ.txt');
      return !!request && atob(request.base64).length === 0;
    }));

    await page.evaluate(() => (window as any).__go('/explorer?root=desktop-id&path=Проекты'));
    await page.getByRole('row', { name: /Отчёт\.xlsx/ }).waitFor();
    await createVia(page, 'В Flux', 'Архив ZIP');
    ok('ZIP-черновик содержит корректную запись EOCD пустого архива', await page.evaluate(() => {
      const request = (window as any).__windowsFilesCalls.find((item: any) => item.action === 'createDraft' && item.name === 'Новый архив.zip');
      if (!request) return false;
      const bytes = Uint8Array.from(atob(request.base64), (character) => character.charCodeAt(0));
      if (bytes.length < 22) return false;
      const start = bytes.length - 22;
      const view = new DataView(bytes.buffer, bytes.byteOffset + start, 22);
      return view.getUint32(0, true) === 0x06054b50 && view.getUint16(4, true) === 0 && view.getUint16(6, true) === 0 && view.getUint16(8, true) === 0 && view.getUint16(10, true) === 0 && view.getUint32(12, true) === 0 && view.getUint32(16, true) === 0 && view.getUint16(20, true) === 0;
    }));
    await page.evaluate(() => (window as any).__go('/explorer?root=desktop-id&path=Проекты'));
    await page.getByRole('row', { name: /Отчёт\.xlsx/ }).waitFor();
    // Имя вводится без расширения: панель сама добавляет «.zip»
    await createVia(page, 'В Windows', 'Архив ZIP', 'Сжатая папка');
    ok('ZIP в Windows: черновик «.zip» и сразу публикация, как у остальных файлов Windows', await page.evaluate(() => {
      const calls = (window as any).__windowsFilesCalls;
      const draftIndex = calls.findIndex((item: any) => item.action === 'createDraft' && item.name === 'Сжатая папка.zip');
      return draftIndex >= 0 && calls.slice(draftIndex + 1).some((item: any) => item.action === 'publishDraft');
    }));
    await page.evaluate(() => (window as any).__go('/explorer?root=desktop-id&path=Проекты'));
    await page.getByRole('row', { name: /Отчёт\.xlsx/ }).waitFor();

    await page.evaluate(() => document.documentElement.classList.remove('dark'));

    await page.screenshot({ path: '/tmp/flux-explorer-light.png', fullPage: true });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.screenshot({ path: '/tmp/flux-explorer-dark.png', fullPage: true });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    ok('Снимки Проводника сохранены в светлой и тёмной теме', await page.getByRole('heading', { name: 'Проводник' }).isVisible());

    await page.getByRole('button', { name: 'Плитки' }).click();
    ok('Переключение на плитки работает', await page.getByRole('button', { name: /Отчёт\.xlsx/ }).count() === 1);
    await page.getByRole('button', { name: 'Список' }).click();

    // --- Выделение нескольких объектов
    await page.evaluate(() => (window as any).__go('/explorer?root=desktop-id&path='));
    await page.getByRole('row', { name: /Инструкция\.docx/ }).waitFor();
    const docRow = page.getByRole('row', { name: /Инструкция\.docx/ });
    const binRow = page.getByRole('row', { name: /Архив\.bin/ });
    const selectedRows = () => page.locator('tbody tr[aria-selected="true"]').count();
    await docRow.click();
    ok('Щелчок выделяет один объект', await selectedRows() === 1 && await docRow.getAttribute('aria-selected') === 'true');
    await binRow.click({ modifiers: ['Control'] });
    ok('Ctrl+щелчок добавляет объект к выделению', await selectedRows() === 2);
    await docRow.click({ modifiers: ['Control'] });
    ok('Ctrl+щелчок по выбранному снимает его', await selectedRows() === 1 && await binRow.getAttribute('aria-selected') === 'true');
    await docRow.click();
    await binRow.click({ modifiers: ['Shift'] });
    ok('Shift+щелчок выделяет диапазон от первого щелчка', await selectedRows() === 2);
    ok('В строке состояния видно число выбранных', await page.getByText(/выбрано 2/).isVisible());
    await docRow.click();
    ok('Обычный щелчок снова оставляет один объект', await selectedRows() === 1);

    // --- Обновление списка сохраняет выделение
    await docRow.click();
    await page.evaluate(() => (window as any).__externalAdd('Внешний.txt'));
    await page.getByRole('row', { name: /Внешний\.txt/ }).waitFor();
    ok('Обновление извне добавляет объект в список', await page.getByRole('row', { name: /Внешний\.txt/ }).isVisible());
    ok('Обновление списка сохраняет выделение', await selectedRows() === 1 && await docRow.getAttribute('aria-selected') === 'true');

    // --- Страницы и прокрутка: обновление не теряет подгруженное и не сбрасывает прокрутку
    await page.evaluate(() => (window as any).__go('/explorer?root=desktop-id&path=Большая'));
    await page.getByRole('row', { name: /Файл 001/ }).waitFor();
    ok('Большая папка открывается первой страницей', await page.locator('tbody tr').count() === 200);
    await page.getByRole('button', { name: 'Показать ещё' }).click();
    await page.getByRole('row', { name: /Файл 300/ }).waitFor();
    await page.getByRole('button', { name: 'Показать ещё' }).click();
    await page.getByRole('row', { name: /Файл 450/ }).waitFor();
    await page.getByRole('row', { name: /Файл 150/ }).click();
    await page.evaluate(() => { document.querySelector<HTMLElement>('tbody')!.closest<HTMLElement>('.overflow-auto')!.scrollTop = 2400; });
    const scrollBefore = await page.evaluate(() => document.querySelector<HTMLElement>('tbody')!.closest<HTMLElement>('.overflow-auto')!.scrollTop);
    const listsBefore = await page.evaluate(() => (window as any).__windowsFilesCalls.filter((request: any) => request.action === 'list' && request.ref.relativePath === 'Большая' && !request.offset).length);
    await page.evaluate(() => (window as any).__emitChanged('desktop-id', 'Большая/Новый.txt'));
    await page.waitForFunction((before) => (window as any).__windowsFilesCalls.filter((request: any) => request.action === 'list' && request.ref.relativePath === 'Большая' && !request.offset).length > before, listsBefore);
    await page.waitForTimeout(300);
    const scrollAfter = await page.evaluate(() => document.querySelector<HTMLElement>('tbody')!.closest<HTMLElement>('.overflow-auto')!.scrollTop);
    ok('Обновление перечитывает уже показанные страницы, а не только первую', await page.locator('tbody tr').count() === 450);
    ok('Обновление не сбрасывает прокрутку', scrollBefore > 1000 && Math.abs(scrollAfter - scrollBefore) <= 2);
    ok('Выделение в большой папке переживает обновление', await page.getByRole('row', { name: /Файл 150/ }).getAttribute('aria-selected') === 'true' && await selectedRows() === 1);
    await page.getByRole('row', { name: /Файл 003/ }).click();
    await page.getByRole('row', { name: /Файл 007/ }).click({ modifiers: ['Shift'] });
    ok('Shift+щелчок берёт все промежуточные объекты', await selectedRows() === 5);
    await page.evaluate(() => (window as any).__go('/explorer?root=desktop-id&path='));
    await page.getByRole('row', { name: /Инструкция\.docx/ }).waitFor();
    ok('Смена папки сбрасывает выделение', await selectedRows() === 0);
    await page.evaluate(() => (window as any).__go('/explorer?root=desktop-id&path=Проекты'));
    await page.getByRole('row', { name: /Отчёт\.xlsx/ }).waitFor();

    // --- Горячие клавиши: таблица explorerKeys читается здесь же, клавиша без сценария роняет набор
    const go = (path: string) => page.evaluate((target) => (window as any).__go(`/explorer?root=desktop-id&path=${target}`), path);
    const route = async () => (await page.getByTestId('route').textContent()) || '';
    const callsOf = (action: string) => page.evaluate((name) => (window as any).__windowsFilesCalls.filter((request: any) => request.action === name), action);
    /** Начать с чистого списка: другая папка сбрасывает выделение, потом нужная. */
    const fresh = async (path: string, wanted: RegExp) => {
      await go(path === 'Проекты' ? 'Большая' : 'Проекты');
      // Дожидаемся другой папки: два перехода подряд без паузы сливаются в один, и выбор не сбрасывается
      await page.getByRole('row', { name: path === 'Проекты' ? /Файл 001/ : /Отчёт\.xlsx/ }).waitFor();
      await go(path);
      await page.getByRole('row', { name: wanted }).waitFor();
    };
    /** Фокус в списке без выделения: щелчок по пустому месту. */
    const focusList = () => page.locator('main').click({ position: { x: 600, y: 520 } });
    const row = (name: RegExp) => page.getByRole('row', { name });
    const selectedAt = async () => page.locator('tbody tr').evaluateAll((items) => items.map((item, index) => item.getAttribute('aria-selected') === 'true' ? index : -1).filter((index) => index >= 0));
    const SCENARIOS: Record<KeyAction, () => Promise<boolean>> = {
      open: async () => {
        await fresh('', /Инструкция\.docx/); await docRow.click(); await page.keyboard.press('Enter');
        // Переход идёт следом за нажатием, а не вместе с ним: ждём адрес, а не спрашиваем сразу
        const file = await page.waitForFunction(() => document.querySelector('[data-testid="route"]')?.textContent?.startsWith('/windows-file?'), undefined, { timeout: 5000 }).then(() => true, () => false);
        await fresh('', /Инструкция\.docx/);
        await row(/Проекты/).click({ position: { x: 4, y: 8 } }); await page.keyboard.press('Enter');
        await row(/Отчёт\.xlsx/).waitFor();
        // Папка открылась: в строке пути появилась «Проекты» (ждём, а не спрашиваем сразу — отрисовка идёт следом за переходом)
        await page.getByLabel('Путь').getByRole('button', { name: 'Проекты', exact: true }).waitFor();
        return file;
      },
      properties: async () => {
        await fresh('', /Инструкция\.docx/); await docRow.click(); await page.keyboard.press('Alt+Enter');
        const dialog = page.getByRole('dialog', { name: /Свойства · Инструкция\.docx/ }); await dialog.waitFor();
        const shown = await dialog.isVisible();
        await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
        return shown;
      },
      rename: async () => {
        await fresh('', /Архив\.bin/); await binRow.click(); await page.keyboard.press('F2');
        const input = page.getByLabel('Новое имя'); await input.waitFor();
        const before = await input.inputValue();
        await input.fill('Архив2.bin'); await input.press('Enter');
        await page.getByRole('dialog', { name: 'Переименовать' }).waitFor({ state: 'detached' });
        return before === 'Архив.bin' && (await callsOf('rename')).some((request: any) => request.name === 'Архив2.bin' && request.ref.relativePath === 'Архив.bin');
      },
      trash: async () => {
        await fresh('Большая', /Файл 003/);
        await row(/Файл 003/).click(); await row(/Файл 004/).click({ modifiers: ['Control'] });
        let question = ''; page.once('dialog', (dialog) => { question = dialog.message(); void dialog.accept(); });
        await page.keyboard.press('Delete');
        await row(/Файл 003/).waitFor({ state: 'detached' });
        const paths = (await callsOf('trash')).map((request: any) => request.ref.relativePath);
        return question.includes('(2)') && paths.includes('Большая/Файл 003.txt') && paths.includes('Большая/Файл 004.txt') && await row(/Файл 004/).count() === 0 && await row(/Файл 005/).count() === 1;
      },
      copy: async () => {
        await fresh('Большая', /Файл 010/);
        await row(/Файл 010/).click(); await row(/Файл 011/).click({ modifiers: ['Control'] });
        await page.keyboard.press('Control+c');
        return await page.getByText('Скопировано объектов: 2').isVisible();
      },
      paste: async () => {
        // Два файла копируются и вставляются в другую папку; затем один файл — в ту же, со свободным именем
        await fresh('Большая', /Файл 012/);
        await row(/Файл 012/).click(); await row(/Файл 013/).click({ modifiers: ['Control'] });
        await page.keyboard.press('Control+c');
        await go('Проекты'); await row(/Отчёт\.xlsx/).waitFor(); await focusList();
        await page.keyboard.press('Control+v');
        await row(/Файл 013/).waitFor();
        const copies = (await callsOf('copy')).filter((request: any) => request.parent.relativePath === 'Проекты');
        const two = copies.length === 2 && copies.every((request: any) => /^Большая\/Файл 01[23]/.test(request.ref.relativePath));
        await fresh('Большая', /Файл 030/);
        await row(/Файл 030/).click(); await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v');
        // Копия встаёт в конец большой папки (за первой страницей), поэтому смотрим на вызов моста, а не на строку
        await page.waitForFunction(() => (window as any).__windowsFilesCalls.some((request: any) => request.action === 'copy' && request.name === 'Файл 030 - копия.txt'));
        return two;
      },
      cut: async () => {
        await fresh('Большая', /Файл 020/);
        await row(/Файл 020/).click(); await row(/Файл 021/).click({ modifiers: ['Control'] });
        await page.keyboard.press('Control+x');
        const shown = await page.getByText('Вырезано объектов: 2').isVisible();
        await go(encodeURIComponent('Проекты/Архив')); await page.getByText('Папка пуста').waitFor(); await focusList();
        await page.keyboard.press('Control+v');
        await row(/Файл 021/).waitFor();
        const moves = (await callsOf('move')).filter((request: any) => request.parent.relativePath === 'Проекты/Архив');
        return shown && moves.length === 2 && moves.every((request: any) => /^a{64}$/.test(request.baseSha256 || '')) && await page.getByText('Вырезано объектов').count() === 0;
      },
      selectAll: async () => {
        await fresh('', /Инструкция\.docx/); await docRow.click(); await page.keyboard.press('Control+a');
        const total = await page.locator('tbody tr').count();
        return total > 1 && await selectedRows() === total;
      },
      create: async () => {
        await fresh('Проекты', /Отчёт\.xlsx/); await focusList();
        await page.keyboard.press('Control+Shift+N');
        // Меню, раскрытое сразу, кладётся в страницу от внутреннего к внешнему: «последнего» по порядку тут нет
        await page.getByRole('button', { name: 'Папку', exact: true }).waitFor();
        await page.waitForTimeout(100);
        const onFolder = await page.evaluate(() => document.activeElement?.textContent === 'Папку');
        const bothPlaces = await page.getByRole('button', { name: 'В Flux', exact: true }).isVisible();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog', { name: 'Новая папка Windows' }); await dialog.waitFor();
        const named = await page.getByLabel('Имя').inputValue() === 'Новая папка';
        await page.getByLabel('Имя').press('Escape');
        await dialog.waitFor({ state: 'detached' });
        return onFolder && bothPlaces && named;
      },
      back: async () => {
        await fresh('', /Инструкция\.docx/);
        await page.getByRole('button', { name: 'Проекты', exact: true }).click(); await row(/Отчёт\.xlsx/).waitFor();
        await page.keyboard.press('Backspace'); await row(/Инструкция\.docx/).waitFor();
        return (await route()).endsWith('path=');
      },
      clear: async () => {
        await fresh('', /Инструкция\.docx/); await docRow.click();
        const before = await selectedRows(); await page.keyboard.press('Escape');
        return before === 1 && await selectedRows() === 0;
      },
      down: async () => {
        await fresh('', /Инструкция\.docx/); await focusList();
        await page.keyboard.press('ArrowDown'); const first = await selectedAt();
        await page.keyboard.press('ArrowDown'); const second = await selectedAt();
        return first.join() === '0' && second.join() === '1';
      },
      up: async () => {
        await fresh('', /Инструкция\.docx/); await focusList();
        await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp');
        return (await selectedAt()).join() === '0';
      },
      extendDown: async () => {
        await fresh('', /Инструкция\.docx/); await page.locator('tbody tr').nth(0).click({ position: { x: 4, y: 8 } });
        await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown');
        return (await selectedAt()).join() === '0,1,2';
      },
      extendUp: async () => {
        await fresh('', /Инструкция\.docx/); await page.locator('tbody tr').nth(0).click({ position: { x: 4, y: 8 } });
        await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowUp');
        return (await selectedAt()).join() === '0,1';
      },
      right: async () => {
        await fresh('', /Инструкция\.docx/); await page.getByRole('button', { name: 'Плитки' }).click(); await focusList();
        const tiles = page.locator('[data-entries-grid] button[data-entry-key]');
        await page.keyboard.press('ArrowRight'); const first = await tiles.nth(0).getAttribute('aria-selected');
        await page.keyboard.press('ArrowRight'); const second = await tiles.nth(1).getAttribute('aria-selected');
        return first === 'true' && second === 'true' && await tiles.nth(0).getAttribute('aria-selected') === 'false';
      },
      left: async () => {
        const tiles = page.locator('[data-entries-grid] button[data-entry-key]');
        await tiles.nth(1).click(); await page.keyboard.press('ArrowLeft');
        const moved = await tiles.nth(0).getAttribute('aria-selected') === 'true' && await tiles.nth(1).getAttribute('aria-selected') === 'false';
        await page.getByRole('button', { name: 'Список' }).click();
        return moved;
      },
    };
    for (const binding of EXPLORER_KEYS) {
      const scenario = SCENARIOS[binding.action];
      ok(`Для клавиши ${binding.label} есть сценарий проверки`, !!scenario);
      if (!scenario) continue;
      try { ok(`Клавиша ${binding.label}: ${binding.does}`, await scenario()); }
      catch (cause: any) { console.error(String(cause?.message || cause).split('\n')[0]); ok(`Клавиша ${binding.label}: ${binding.does}`, false); }
    }
    ok('Таблица клавиш не содержит повторов сочетаний', new Set(EXPLORER_KEYS.map((binding) => binding.label)).size === EXPLORER_KEYS.length);
    await go('Проекты');
    await page.getByRole('row', { name: /Отчёт\.xlsx/ }).waitFor();
    await page.setViewportSize({ width: 1440, height: 820 });
    await page.evaluate(() => { const windowFrame = document.querySelector<HTMLElement>('#mount > div')!; Object.assign(windowFrame.style, { inset: 'auto', width: '800px', height: '500px', left: '600px', top: '80px', transform: 'translate(24px, 20px)', overflow: 'hidden' }); });
    const explorerRow = page.getByRole('row', { name: /Отчёт\.xlsx/ });
    await explorerRow.waitFor({ state: 'visible' });
    const explorerRect = await explorerRow.boundingBox();
    if (!explorerRect) throw new Error('Не нашлась строка Отчёт.xlsx для открытия меню');
    const explorerPoint = { x: explorerRect.x + explorerRect.width / 2, y: explorerRect.y + explorerRect.height / 2 };
    await explorerRow.click({ button: 'right' });
    const explorerMenu = page.locator('body > [data-context-menu]');
    await explorerMenu.waitFor();
    ok('Контекстное меню открыто для выбранного файла', await explorerMenu.getByRole('button', { name: 'Открыть', exact: true }).isVisible() && await explorerMenu.getByRole('button', { name: 'Свойства', exact: true }).isVisible());
    const explorerMenuRect = await explorerMenu.boundingBox();
    ok('Меню Проводника в перемещённом окне остаётся у указателя и в пределах экрана', !!explorerMenuRect && Math.abs(explorerMenuRect.x - explorerPoint.x) < 270 && explorerMenuRect.x + explorerMenuRect.width <= 1440 && explorerMenuRect.y + explorerMenuRect.height <= 820);
    await page.keyboard.press('Escape');
    ok('Escape закрывает контекстное меню Проводника', await explorerMenu.count() === 0);

    await page.evaluate(() => {
      const windowFrame = document.querySelector<HTMLElement>('#mount > div')!;
      Object.assign(windowFrame.style, { inset: '0px', width: '100vw', height: '100vh', left: '0px', top: '0px', transform: 'none', overflow: 'visible' });
      (window as any).__showWindowsDesktop();
    });
    const desktopArea = page.locator('section[aria-label="Рабочий стол Windows"] > div.relative');
    await desktopArea.waitFor();
    await page.getByRole('button', { name: 'Системная папка' }).waitFor();
    const desktopSettled = await page.waitForFunction(() => !document.querySelector('section[aria-label="Рабочий стол Windows"]')?.textContent?.includes('Читаем Рабочий стол Windows'), undefined, { timeout: 3000 }).then(() => true).catch(() => false);
    ok('Рабочий стол завершает полный запрос списка и убирает индикатор загрузки', desktopSettled);
    await page.waitForTimeout(100);
    const desktopRect = await desktopArea.boundingBox();
    if (!desktopRect) throw new Error('Не нашлась область рабочего стола для проверки меню');
    const desktopPoint = { x: desktopRect.x + desktopRect.width - 8, y: desktopRect.y + desktopRect.height - 8 };
    const shellIcon = page.getByRole('button', { name: 'Системная папка' });
    const shellBox = await shellIcon.boundingBox();
    ok('Системный значок использует глобальные DIP на мониторе с отрицательным началом', !!shellBox && Math.abs(shellBox.x - 80) < 5 && Math.abs(shellBox.y - 100) < 5);
    await page.screenshot({ path: '/tmp/flux-desktop-light.png' });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.screenshot({ path: '/tmp/flux-desktop-dark.png' });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.evaluate(({ x, y }) => {
      const area = document.querySelector('section[aria-label="Рабочий стол Windows"] > div.relative > div.absolute') as HTMLElement | null;
      const target = area || document.elementFromPoint(x, y) as HTMLElement | null;
      target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
    }, desktopPoint);
    const desktopMenu = page.locator('[data-context-menu]');
    await page.waitForTimeout(100);
    const hasDesktopMenu = await desktopMenu.count() > 0;
    const desktopMenuRect = hasDesktopMenu ? await desktopMenu.first().boundingBox() : null;
    ok('Меню рабочего стола в перемещённом окне целиком видно у правого нижнего края', !!desktopMenuRect && desktopMenuRect.x < desktopPoint.x && desktopMenuRect.y < desktopPoint.y && desktopMenuRect.x + desktopMenuRect.width <= 1440 && desktopMenuRect.y + desktopMenuRect.height <= 820);
    ok('Меню рабочего стола содержит создание Windows и настройки экрана', hasDesktopMenu && await desktopMenu.getByRole('button', { name: 'Создать Windows' }).count() === 1 && await desktopMenu.getByRole('button', { name: 'Создать Flux' }).count() === 0 && await desktopMenu.getByRole('button', { name: 'Параметры экрана' }).count() === 1);
    await page.mouse.click(10, 10);
    ok('Щелчок снаружи закрывает контекстное меню рабочего стола', await desktopMenu.count() === 0);
    ok('Рабочий стол Windows не дублирует приложение «Общий доступ» отдельным ярлыком', await page.getByRole('button', { name: 'Общий доступ', exact: true }).count() === 0 && await page.evaluate(() => (window as any).__nativeAppOpenCalls.length === 0));
    await page.evaluate(() => { const windowFrame = document.querySelector<HTMLElement>('#mount > div')!; Object.assign(windowFrame.style, { inset: '0px', width: '100vw', height: '100vh', left: '0px', top: '0px', transform: 'none', overflow: 'visible' }); });

    for (const width of [1440, 1024, 768, 600]) {
      await page.setViewportSize({ width, height: 820 });
      for (const dark of [false, true]) {
        await page.evaluate((enabled) => document.documentElement.classList.toggle('dark', enabled), dark);
        const size = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        ok(`Без горизонтального переполнения при ${width}px (${dark ? 'тёмная' : 'светлая'} тема)`, size.scroll <= size.client + 2);
      }
    }
    ok('Нет загрузки файловых байтов или метаданных на сервер компании', await page.evaluate(() => (window as any).__windowsFilesCalls.every((request: any) => !['upload', 'projectWrite'].includes(request.action))));
    ok('Нет ошибок браузера', errors.length === 0);
    if (errors.length) console.error(errors.slice(0, 5));
  } finally { await browser.close(); }
  console.log(`${passed} проверок пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
