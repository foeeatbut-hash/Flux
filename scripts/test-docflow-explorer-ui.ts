/**
 * Документооборот в Проводнике и в ДО на стенде с подменённым мостом (docs/docflow-program.md,
 * разделы 3 и 4): столбцы Шифр/Тип/Ред./Статус/В реестре, значок «имя не по маске», фильтры,
 * «Сведения», меню «Документооборот ▸», связывание с проверкой имени, слежение, столбцы «Файл»
 * и «Возврат», вкладка «Сверка с папкой». Снимки обеих тем — в EXPLORER_SHOTS.
 */
import { mkdir } from 'node:fs/promises';

const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5174';
const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';
const SHOTS = process.env.EXPLORER_SHOTS || '/tmp/flux-docflow-shots';
const URL = `${BASE}/scripts/fixtures/windows-explorer-ui.html?docflow=1`;
let passed = 0; let failed = 0;
const ok = (name: string, value: boolean, detail?: unknown) => { if (value) { passed++; console.log('✓', name); } else { failed++; console.error('✗', name, detail === undefined ? '' : JSON.stringify(detail)); } };
type Page = import('playwright-core').Page;

async function shoot(page: Page, name: string, target = '[data-windows-explorer]') {
  for (const dark of [false, true]) {
    await page.evaluate((enabled) => document.documentElement.classList.toggle('dark', enabled), dark);
    await page.locator(target).first().screenshot({ path: `${SHOTS}/${name}-${dark ? 'dark' : 'light'}.png` });
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
}
const posts = (page: Page) => page.evaluate(() => (window as any).__docflowPosts as Array<{ url: string; body: any }>);

(async () => {
  const { chromium } = await import('playwright-core');
  await mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 820 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(URL);
    await page.locator('[data-windows-explorer]').waitFor();
    await page.evaluate(() => (window as any).__go('/explorer?root=desktop-id&path=Проекты'));
    await page.getByRole('row', { name: /3700-B01-E02-001_B\.pdf/ }).waitFor();

    // ── Столбцы документооборота включаются в «Просмотреть»/меню столбцов ──
    await page.locator('[data-column-header]').first().click({ button: 'right' });
    const menu = page.getByRole('dialog', { name: 'Столбцы и порядок' });
    for (const label of ['Шифр', 'Тип документа', 'Ред.', 'Статус', 'В реестре']) await menu.getByLabel(label, { exact: true }).check();
    await menu.getByRole('button', { name: 'Готово' }).click();
    const linked = page.getByRole('row', { name: /3700-B01-E02-001_B\.pdf/ });
    const cells = (await linked.getByRole('cell').allTextContents()).join(' | ');
    ok('Файл из реестра: шифр, тип, ревизия файла и последняя, статус и наименование строки', /3700-B01-E02-001(?!_)/.test(cells) && cells.includes('E02 · Общий вид') && cells.includes('B (последняя C)') && cells.includes('Выдан') && cells.includes('Общий вид установки П1'));
    const loose = page.getByRole('row', { name: /3700-B01-E02-004_A\.pdf/ });
    const looseCells = (await loose.getByRole('cell').allTextContents()).join(' | ');
    ok('Файл по маске без строки: шифр и тип из имени, «В реестре» — прочерк', looseCells.includes('3700-B01-E02-004') && looseCells.includes('A') && /—\s*$/.test(looseCells.trim()));

    // ── Значок «имя не по маске» с причиной ──
    const draft = page.getByRole('row', { name: /черновик\.docx/ });
    const badge = draft.locator('[data-off-mask]');
    ok('У имени не по маске есть значок с подсказкой, что не так', await badge.count() === 1 && /Имя не по маске проекта: .+/.test(await badge.getAttribute('title') || ''));
    const noRev = page.getByRole('row', { name: /3700-B01-E02-001\.pdf/ });
    ok('Подсказка называет недостающее поле', /нет поля «Ревизия»/.test(await noRev.locator('[data-off-mask]').getAttribute('title') || ''));
    ok('У подходящего имени значка нет', await linked.locator('[data-off-mask]').count() === 0 && await loose.locator('[data-off-mask]').count() === 0);

    // ── Замочек (3.7): связанный файл заблокирован — значок, неактивные пункты с причиной ──
    ok('У заблокированного связанного файла есть значок замка с подсказкой, у свободного — нет', await linked.locator('[data-lock-badge="locked"]').count() === 1 && /Заблокирован/.test(await linked.locator('[data-lock-badge]').getAttribute('title') || '') && await loose.locator('[data-lock-badge]').count() === 0);
    await linked.click({ button: 'right' });
    const lockMenu = page.locator('body > [data-context-menu]').first();
    for (const name of ['Вырезать', 'Переименовать', 'Удалить', 'Открыть']) {
      const item = lockMenu.getByRole('button', { name, exact: true });
      ok(`Заблокированный файл: «${name}» неактивно, причина названа`, await item.isDisabled() && /заблокирован: он связан со строкой документооборота/.test(await item.getAttribute('title') || ''), name);
    }
    ok('Копировать как новый файл остаётся доступным', await lockMenu.getByRole('button', { name: 'Копировать', exact: true }).isEnabled());
    await page.keyboard.press('Escape');
    await loose.click({ button: 'right' });
    ok('У свободного файла правка доступна', await page.locator('body > [data-context-menu]').first().getByRole('button', { name: 'Удалить', exact: true }).isEnabled());
    await page.keyboard.press('Escape');

    // ── Фильтры ──
    const filter = page.getByLabel('Фильтр документооборота');
    await filter.selectOption({ label: 'Нет в реестре' });
    ok('«Нет в реестре»: остаются файлы без строки', await page.getByRole('row', { name: /черновик\.docx/ }).count() === 1 && await page.getByRole('row', { name: /3700-B01-E02-004_A/ }).count() === 1 && await page.getByRole('row', { name: /3700-B01-E02-001_B/ }).count() === 0);
    await filter.selectOption({ label: 'Имя не по маске' });
    ok('«Имя не по маске»: только файлы с проблемным именем', await page.getByRole('row', { name: /черновик\.docx/ }).count() === 1 && await page.getByRole('row', { name: /3700-B01-E02-004_A/ }).count() === 0);
    await filter.selectOption({ label: 'В реестре' });
    ok('«В реестре»: только связанные', await page.getByRole('row', { name: /3700-B01-E02-001_B/ }).count() === 1 && await page.getByRole('row', { name: /черновик\.docx/ }).count() === 0);
    await filter.selectOption({ label: 'Все файлы' });

    // ── Слежение: файл связи пропал из папки — сервер получает «не найден» ──
    await page.waitForFunction(() => (window as any).__docflowPosts.some((p: any) => p.url.startsWith('/api/docflow/links/track')), null, { timeout: 8000 }).catch(() => undefined);
    const track = (await posts(page)).find((p) => p.url.startsWith('/api/docflow/links/track'));
    ok('Пропавший файл связи помечается на сервере, а не отвязывается', !!track && track.body.updates.some((u: any) => u.linkId === 'l2' && u.lost === true) && !track.body.updates.some((u: any) => u.linkId === 'l1'));

    // ── Сведения: строка ВДР ──
    await linked.click();
    await page.keyboard.press('Alt+Shift+P');
    const details = page.locator('[data-doc-details]');
    await details.waitFor();
    const text = await details.innerText();
    ok('«Сведения»: шифр, наименование, ревизия файла и последняя, статус, ответственный, срок, теги', text.includes('3700-B01-E02-001') && text.includes('Общий вид установки П1') && text.includes('ред. B · последняя C') && text.includes('Выдан') && text.includes('Иванов И. И.') && text.includes('20.11.2026') && text.includes('П1'));
    await page.getByText('Файлы по ревизиям').waitFor();
    ok('«Сведения»: файлы по ревизиям и возврат', (await details.innerText()).includes('возврат: Замечания.pdf (код 2)'));
    await shoot(page, 'explorer-details');

    // ── Меню «Документооборот ▸» у файла из реестра ──
    await linked.click({ button: 'right' });
    const ctx = page.locator('body > [data-context-menu]').first();
    await ctx.getByRole('button', { name: 'Документооборот', exact: true }).hover();
    const sub = page.locator('body > [data-context-menu]').last();
    await sub.getByRole('button', { name: 'Открыть в ДО' }).waitFor();
    const subText = await sub.innerText();
    ok('У связанного файла: открыть в ДО, назначить возвратом, отвязать — без «Связать»', /Открыть в ДО/.test(subText) && /Отвязать/.test(subText) && /Назначить возвратом к…/.test(subText) && !/Связать со строкой/.test(subText), subText as any);
    await sub.getByRole('button', { name: 'Открыть в ДО' }).click();
    await page.getByTestId('route').filter({ hasText: /^\/docflow\?tab=registry&vdr=r1&item=i1$/ }).waitFor({ timeout: 5000 });
    ok('«Открыть в ДО» ведёт на строку реестра', true);
    await page.getByRole('columnheader', { name: 'Файл', exact: true }).waitFor();
    ok('Открыт настоящий экран ДО, Проводник размонтирован', await page.locator('[data-windows-explorer]').count() === 0);
    await page.evaluate(() => (window as any).__go('/explorer?root=desktop-id&path=Проекты'));
    await page.getByRole('row', { name: /3700-B01-E02-004_A\.pdf/ }).waitFor();

    // ── Связать: несходящееся имя не связывается и показывает расхождения ──
    await page.getByRole('row', { name: /3700-B01-E02-004_A\.pdf/ }).click({ button: 'right' });
    await page.locator('body > [data-context-menu]').first().getByRole('button', { name: 'Документооборот', exact: true }).hover();
    await page.locator('body > [data-context-menu]').last().getByRole('button', { name: 'Связать со строкой ВДР…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Назначить файл' });
    await dialog.waitFor();
    await dialog.getByRole('option', { name: /3700-B01-E02-001 / }).click();
    const wrong = dialog.getByRole('list', { name: 'Проверка имени файла' });
    await wrong.waitFor();
    ok('Не тот шифр: окно показывает расхождение по полям и связать нельзя', /в имени шифр 3700-B01-E02-004, в строке 3700-B01-E02-001/.test(await wrong.innerText()) && await dialog.getByRole('button', { name: /Назначить/ }).last().isDisabled());
    ok('Из Проводника исправляет имя сам человек: окно не предлагает переименование', /Переименуйте файл \(F2\)/.test(await dialog.innerText()) && await dialog.getByText(/Переименовать в/).count() === 0);
    await shoot(page, 'explorer-link-mismatch', '[role="dialog"]');
    await dialog.getByRole('option', { name: /3700-B01-E02-004 / }).click();
    await dialog.getByText('шифр совпал', { exact: false }).first().waitFor();
    const submit = dialog.getByRole('button', { name: 'Назначить', exact: true });
    await page.waitForFunction(() => !(document.querySelector('[role="dialog"] button.fx-btn-primary, [role="dialog"] button[class*="primary"]') as HTMLButtonElement | null)?.disabled).catch(() => undefined);
    await submit.click();
    await page.waitForFunction(() => (window as any).__docflowPosts.some((p: any) => p.url === '/api/docflow/links' && p.body?.itemId === 'i4'), null, { timeout: 8000 });
    const made = (await posts(page)).find((p) => p.url === '/api/docflow/links')!;
    ok('Сходящееся имя связывается: на сервер уходят строка, папка проекта, путь внутри неё и отпечаток', made.body.role === 'file' && made.body.fileName === '3700-B01-E02-004_A.pdf' && made.body.relativePath === '3700-B01-E02-004_A.pdf' && /^[0-9a-f]{20,}$/.test(made.body.folderKey) && /^[0-9a-f]{64}$/.test(made.body.sha256), made.body);

    // ── Добавить в реестр: имя не по маске — сначала исправить ──
    await page.getByRole('row', { name: /черновик\.docx/ }).click({ button: 'right' });
    await page.locator('body > [data-context-menu]').first().getByRole('button', { name: 'Документооборот', exact: true }).hover();
    await page.locator('body > [data-context-menu]').last().getByRole('button', { name: 'Добавить в реестр…' }).click();
    const add = page.getByRole('dialog', { name: 'Добавить в реестр' });
    await add.waitFor();
    ok('Имя не по маске: строка не создаётся, окно просит исправить имя', /Исправьте имя \(F2\)/.test(await add.innerText()) && await add.getByRole('button', { name: 'Добавить', exact: true }).isDisabled());
    await add.getByRole('button', { name: 'Отмена' }).click();

    // ── ДО: столбцы «Файл» и «Возврат» ссылками ──
    await page.goto(`${URL}&screen=docflow&tab=registry`);
    await page.getByRole('columnheader', { name: 'Файл' }).waitFor();
    const regRow = page.getByRole('row', { name: /3700-B01-E02-001/ });
    const remarks = await regRow.locator('[data-file-link="remarks"]').innerText();
    ok('Реестр: прежний файл B не выдаётся за текущую ревизию C, возврат остаётся ссылкой', await regRow.locator('[data-file-link="file"]').count() === 0 && remarks.includes('Замечания.pdf'));
    const currentRow = page.getByRole('row', { name: /3700-B01-E02-002/ });
    ok('Реестр: файл текущей ревизии A открывается ссылкой', (await currentRow.locator('[data-file-link="file"]').innerText()).includes('ред. A'));
    const emptyRow = page.getByRole('row', { name: /3700-B01-E02-004/ });
    ok('Пустое место — кнопка «Назначить…» при праве docflow.files', await emptyRow.locator('[data-assign="file"]').count() === 1);
    const lostRow = page.getByRole('row', { name: /3700-B01-E02-002/ });
    await shoot(page, 'docflow-registry', '.fx-page');
    await emptyRow.locator('[data-assign="file"]').click();
    const assign = page.getByRole('dialog', { name: 'Назначить файл' });
    await assign.waitFor();
    ok('«Назначить файл…»: путь к файлу и «Выбрать…» через окно Проводника Flux', await assign.getByLabel('Путь к файлу').isVisible() && await assign.getByText('Выбрать…').count() >= 1);
    await shoot(page, 'docflow-assign', '[role="dialog"]');
    await assign.getByRole('button', { name: 'Отмена' }).click();
    void lostRow;

    // ── ДО: замочек в строке Реестра ──
    const lockBtn = regRow.locator('[data-file-lock]');
    ok('Реестр: замок возврата закрыт, в подсказке кто и когда, нарушения нет', await lockBtn.count() === 1 && await lockBtn.getAttribute('data-file-lock') === 'locked' && /Заблокирован .*Иванов И\. И\./.test(await lockBtn.getAttribute('title') || '') && await regRow.locator('[data-lock-violation-text]').count() === 0);
    await lockBtn.click();
    await page.waitForFunction(() => (window as any).__docflowPosts.some((p: any) => p.url === '/api/docflow/links/lock' && p.body.locked === false), null, { timeout: 5000 });
    ok('Нажатие на замок снимает его: на сервер уходят строка, связь и locked=false', (await posts(page)).some((p) => p.url === '/api/docflow/links/lock' && p.body.itemId === 'i1' && p.body.linkId === 'l3' && p.body.locked === false));
    await regRow.locator('[data-file-lock="open"]').waitFor({ timeout: 5000 });
    const openTitle = await regRow.locator('[data-file-lock]').getAttribute('title') || '';
    ok('После снятия замок открыт, подсказка называет снявшего', /Замок снят.*Администратор/.test(openTitle), openTitle);
    await shoot(page, 'docflow-registry-lock', '.fx-page');

    // ── ДО: «Выпустить…» ──
    const issueRow = page.getByRole('row', { name: /3700-B01-E02-005/ });
    ok('Строка «Согласован» получает кнопку выпуска, «В работе» — нет', await issueRow.locator('[data-issue-row]').count() === 1 && await page.getByRole('row', { name: /3700-B01-E02-002/ }).locator('[data-issue-row]').count() === 0);
    await page.getByRole('row', { name: /3700-B01-E02-002/ }).getByRole('checkbox').check();
    await page.locator('[data-issue-selected]').click();
    const bad = page.getByRole('dialog', { name: 'Выпустить документы' });
    await bad.waitFor();
    await bad.getByText(/не разрешает выпуск/).waitFor();
    ok('Строка «В работе»: проверки называют причину, «Выпустить» недоступна', await bad.locator('[data-issue-submit]').isDisabled());
    await bad.getByRole('button', { name: 'Отмена' }).click();
    await page.getByRole('row', { name: /3700-B01-E02-002/ }).getByRole('checkbox').uncheck();
    await issueRow.hover();
    await issueRow.locator('[data-issue-row]').click();
    const issue = page.getByRole('dialog', { name: 'Выпустить документы' });
    await issue.getByText('Все проверки пройдены').waitFor();
    ok('Окно выпуска показывает отпечаток файла и честно говорит, что файл на сервер не уходит', /^a{16}…/.test(await issue.locator('[data-issue-hash]').innerText()) && /на сервер не передаётся/.test(await issue.innerText()));
    ok('Предпросмотр ничего не записал', !(await posts(page)).some((p) => p.url === '/api/docflow/issue/apply'));
    await shoot(page, 'docflow-issue', '[role="dialog"]');
    await issue.locator('[data-issue-submit]').click();
    await issue.locator('[data-issue-done]').waitFor();
    const applied = (await posts(page)).find((p) => p.url === '/api/docflow/issue/apply');
    ok('Подтверждение шлёт отпечаток, прочитанный заново, а не файл', !!applied && applied.body.hashes.i5 === 'a'.repeat(64) && JSON.stringify(applied.body).length < 500, applied?.body);
    await issue.getByRole('button', { name: 'Закрыть', exact: true }).last().click();
    await page.waitForFunction(() => document.querySelector('tr [data-issued]'), null, { timeout: 5000 });
    ok('В Реестре у выпущенного файла пометка «выдан»', await issueRow.locator('[data-issued]').count() === 1);

    // ── ДО: «Сверка с папкой» ──
    await page.goto(`${URL}&screen=docflow&tab=reconcile`);
    await page.locator('[data-reconcile]').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-recon-group]').length === 4, null, { timeout: 8000 });
    const groups = await page.locator('[data-recon-group]').allInnerTexts();
    ok('Сверка: четыре группы', groups.length === 4 && /Есть в реестре, файла нет/.test(groups[0]) && /Файл есть, в реестре нет/.test(groups[1]) && /Имя не по маске/.test(groups[2]) && /Расходится/.test(groups[3]));
    ok('Сверка: нет файла у строки, файл без строки, имя не по маске', /3700-B01-E02-004/.test(groups[0]) && /3700-B01-E02-004_A\.pdf/.test(groups[1]) && /черновик\.docx/.test(groups[2]) && /3700-B01-E02-001\.pdf/.test(groups[2]));
    ok('Сверка: расхождение — привязанный файл, которого нет в папке', /3700-B01-E02-002_A\.pdf/.test(groups[3]) && /Найти…/.test(groups[3]));
    await shoot(page, 'docflow-reconcile', '.fx-page');

    ok('Без ошибок страницы', errors.length === 0 || (console.error(errors), false));
  } finally { await browser.close(); }
  console.log(`${passed} проверок пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
