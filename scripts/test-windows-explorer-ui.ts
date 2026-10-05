/** Браузерная проверка Проводника с имитацией нативного файлового моста. */
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';
let passed = 0; let failed = 0;
const ok = (name: string, value: boolean) => { if (value) { passed++; console.log('✓', name); } else { failed++; console.error('✗', name); } };

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

    await page.getByRole('banner').getByRole('button', { name: 'Создать в Flux' }).click();
    await page.getByRole('dialog', { name: 'Создать в Flux' }).waitFor();
    await page.getByRole('button', { name: 'Создать черновик' }).click();
    await page.getByRole('dialog', { name: 'Создать в Flux' }).waitFor({ state: 'detached' });
    ok('Создание нового документа записывает локальный черновик и открывает ref', await page.evaluate(() => (window as any).__windowsFilesCalls.some((request: any) => request.action === 'createDraft')) && (await page.getByTestId('route').textContent())?.startsWith('/windows-file?root='));
    await page.evaluate(() => (window as any).__go('/explorer?root=desktop-id&path=Проекты'));
    await page.getByRole('row', { name: /Новый документ\.docx/ }).click();
    await page.getByRole('button', { name: /Опубликовать/ }).click();
    ok('Публикация черновика запускается отдельно', await page.evaluate(() => (window as any).__windowsFilesCalls.some((request: any) => request.action === 'publishDraft')));

    await page.getByRole('button', { name: 'Этот компьютер', exact: true }).click();
    await page.getByRole('button', { name: /Локальный диск \(C:\)/ }).waitFor();
    ok('Этот компьютер показывает подключённые тома из нативного моста', await page.evaluate(() => (window as any).__windowsFilesCalls.some((request: any) => request.action === 'volumes')));
    await page.getByRole('button', { name: /Локальный диск \(C:\)/ }).click();
    await page.getByRole('row', { name: /Fluxdraftfolders/ }).waitFor();
    ok('Том открывается и показывает папку Fluxdraftfolders', await page.getByRole('row', { name: /Fluxdraftfolders/ }).isVisible());
    await page.getByRole('row', { name: /Fluxdraftfolders/ }).dblclick();
    await page.getByRole('banner').getByRole('button', { name: 'Создать в Flux' }).click();
    await page.getByRole('dialog', { name: 'Создать в Flux' }).waitFor();
    await page.getByLabel('Тип').selectOption('folder');
    await page.getByLabel('Имя').fill('Экспортируемая папка');
    await page.getByRole('button', { name: 'Создать черновик' }).click();
    await page.getByRole('dialog', { name: 'Создать в Flux' }).waitFor({ state: 'detached' });
    ok('Создание папки Flux отправляет createDraftFolder с родительским путём', await page.evaluate(() => {
      const request = (window as any).__windowsFilesCalls.find((item: any) => item.action === 'createDraftFolder');
      return request?.name === 'Экспортируемая папка' && request?.parent?.relativePath === 'Fluxdraftfolders' && request?.parent?.rootId === 'disk-c';
    }));
    const folderDraftId = await page.evaluate(() => (window as any).__draftFolderIds[0]);
    await page.evaluate((draftId) => (window as any).__go(`/explorer?root=disk-c&path=Fluxdraftfolders%2FЭкспортируемая%20папка&draft=${draftId}`), folderDraftId);
    await page.getByRole('banner').getByRole('button', { name: 'Создать в Flux' }).click();
    await page.getByLabel('Имя').fill('Вложенный документ.docx');
    await page.getByRole('button', { name: 'Создать черновик' }).click();
    await page.getByRole('dialog', { name: 'Создать в Flux' }).waitFor({ state: 'detached' });
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
    const freeArea = page.locator('main');
    await freeArea.click({ button: 'right', position: { x: 600, y: 400 } });
    const freeMenu = page.locator('body > [data-context-menu]').first();
    await freeMenu.getByRole('button', { name: 'Создать в Flux', exact: true }).hover();
    await page.getByRole('button', { name: 'Папка', exact: true }).waitFor();
    ok('Меню пустого места открывает подменю папки, текста и ZIP', await page.getByRole('button', { name: 'Папка', exact: true }).isVisible() && await page.getByRole('button', { name: 'Текстовый файл', exact: true }).isVisible() && await page.getByRole('button', { name: 'Архив ZIP', exact: true }).isVisible());
    const copyMoveCountBeforeMenu = await page.evaluate(() => (window as any).__windowsFilesCalls.filter((request: any) => ['copy', 'move'].includes(request.action)).length);
    ok('ПКМ по пустому месту с буфером не вставляет файл автоматически', await freeMenu.getByRole('button', { name: 'Вставить', exact: true }).isVisible() && await page.evaluate((count) => (window as any).__windowsFilesCalls.filter((request: any) => ['copy', 'move'].includes(request.action)).length === count, copyMoveCountBeforeMenu));
    await page.getByRole('button', { name: 'Папка', exact: true }).click();
    await page.getByRole('dialog', { name: 'Создать в Flux' }).waitFor();
    ok('Пункт «Папка» открывает создание черновой папки', await page.getByLabel('Тип').inputValue() === 'folder');
    await page.getByRole('dialog', { name: 'Создать в Flux' }).getByRole('button', { name: 'Отмена' }).click();

    await freeArea.click({ button: 'right', position: { x: 600, y: 400 } });
    await page.locator('body > [data-context-menu]').first().getByRole('button', { name: 'Создать в Flux', exact: true }).hover();
    await page.getByRole('button', { name: 'Текстовый файл', exact: true }).click();
    await page.getByRole('dialog', { name: 'Создать в Flux' }).waitFor();
    ok('Пункт «Текстовый файл» задаёт имя нового текста', await page.getByLabel('Имя').inputValue() === 'Новый текст.txt');
    await page.getByRole('button', { name: 'Создать черновик' }).click();
    await page.getByRole('dialog', { name: 'Создать в Flux' }).waitFor({ state: 'detached' });
    ok('Текстовый черновик отправляет пустое содержимое', await page.evaluate(() => {
      const request = (window as any).__windowsFilesCalls.find((item: any) => item.action === 'createDraft' && item.name === 'Новый текст.txt');
      return !!request && atob(request.base64).length === 0;
    }));

    await page.evaluate(() => (window as any).__go('/explorer?root=desktop-id&path=Проекты'));
    await page.getByRole('row', { name: /Отчёт\.xlsx/ }).waitFor();
    await freeArea.click({ button: 'right', position: { x: 600, y: 400 } });
    await page.locator('body > [data-context-menu]').first().getByRole('button', { name: 'Создать в Flux', exact: true }).hover();
    await page.getByRole('button', { name: 'Архив ZIP', exact: true }).click();
    await page.getByRole('dialog', { name: 'Создать в Flux' }).waitFor();
    ok('Пункт «Архив ZIP» задаёт имя нового архива', await page.getByLabel('Имя').inputValue() === 'Новый архив.zip');
    await page.getByRole('button', { name: 'Создать черновик' }).click();
    await page.getByRole('dialog', { name: 'Создать в Flux' }).waitFor({ state: 'detached' });
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

    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.screenshot({ path: '/tmp/flux-explorer-light.png', fullPage: true });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.screenshot({ path: '/tmp/flux-explorer-dark.png', fullPage: true });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    ok('Снимки Проводника сохранены в светлой и тёмной теме', await page.getByRole('heading', { name: 'Проводник' }).isVisible());

    await page.getByRole('button', { name: 'Плитки' }).click();
    ok('Переключение на плитки работает', await page.getByRole('button', { name: /Отчёт\.xlsx/ }).count() === 1);
    await page.getByRole('button', { name: 'Список' }).click();
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
    await desktopMenu.getByRole('button', { name: 'Создать в Flux', exact: true }).hover();
    await page.getByRole('button', { name: 'Папку', exact: true }).last().click();
    const draftFolderDialog = page.getByRole('dialog', { name: 'Новая папка Flux' });
    await draftFolderDialog.waitFor();
    ok('Создание папки рабочего стола явно сообщает о хранении только в Flux', await draftFolderDialog.getByText('Объект сохранится только в Flux. Позже его можно сохранить в Windows.').isVisible());
    await draftFolderDialog.getByRole('button', { name: 'Отмена', exact: true }).click();
    await page.evaluate((point) => {
      const target = document.querySelector('section[aria-label="Рабочий стол Windows"] > div.relative');
      target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y }));
    }, desktopPoint);
    await page.locator('[data-context-menu]').getByRole('button', { name: 'Создать в Flux', exact: true }).hover();
    await page.getByRole('button', { name: 'Архив ZIP', exact: true }).last().click();
    const draftArchiveDialog = page.getByRole('dialog', { name: 'Новый архив Flux' });
    await draftArchiveDialog.waitFor();
    ok('Создание архива рабочего стола не обещает немедленного появления в Windows', await draftArchiveDialog.getByText('Объект сохранится только в Flux. Позже его можно сохранить в Windows.').isVisible());
    await draftArchiveDialog.getByRole('button', { name: 'Отмена', exact: true }).click();
    await page.evaluate((point) => document.querySelector('section[aria-label="Рабочий стол Windows"] > div.relative')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y })), desktopPoint);
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
