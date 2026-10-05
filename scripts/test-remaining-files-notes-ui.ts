/** Real NotesManagement component against a disposable API fixture; no company data or API server. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

let passed = 0;
const check = (label: string, value: boolean) => { assert.equal(value, true, label); passed++; console.log(`✓ ${label}`); };

async function main() {
process.env.DISABLE_HMR = 'true';
const timer = setTimeout(() => { console.error('FLUX_VERIFY_TIMEOUT: Notes component scenario exceeded 180 seconds'); process.exit(1); }, 180_000);
const vite = await createServer({
  configFile: 'scripts/fixtures/remaining-files/notes-ui/vite.config.ts',
  server: { host: '127.0.0.1', port: 5197, strictPort: true, hmr: false },
  logLevel: 'error',
});
console.log('Notes component: Vite fixture created');
let browser: any;
try {
await vite.listen();
const address = vite.httpServer?.address();
if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
console.log(`Notes component: fixture listening on 127.0.0.1:${address.port}`);
browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
console.log('Notes component: Chromium started');
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.getByRole('heading', { name: 'Zulu fixture' }).waitFor();

  const cardTitles = () => page.locator('#notes-sidebar h3 span.flex-1').allTextContents();
  check('own-note scope hides shared and legacy records', await page.getByText('Zulu fixture').count() === 1 && await page.getByText('Shared fixture').count() === 0 && await page.getByText('Legacy fixture').count() === 0);
  await page.getByRole('textbox', { name: 'Поиск заметок' }).fill('Searchable unique phrase');
  check('search matches note content and excludes non-matches', await page.getByText('Alpha fixture').count() === 1 && await page.getByText('Zulu fixture').count() === 0);
  await page.getByRole('button', { name: 'Очистить' }).click();

  const zuluCard = page.locator('#notes-sidebar h3').filter({ hasText: 'Zulu fixture' }).locator('xpath=ancestor::div[contains(@class,"p-3")][1]');
  await zuluCard.getByRole('button', { name: 'Закрепить вверху списка' }).click();
  await page.waitForFunction(() => {
    const ids = JSON.parse(localStorage.getItem('pdm_pinned_notes_files-notes-ui-user') || '[]');
    return ids.includes('note-zulu') && document.querySelector('#notes-sidebar h3 span.flex-1')?.textContent === 'Zulu fixture';
  });
  const afterPin = await cardTitles();
  check('pin persists per user and moves the grouped older note to the top', afterPin[0] === 'Zulu fixture' && JSON.stringify(JSON.parse(await page.evaluate(() => localStorage.getItem('pdm_pinned_notes_files-notes-ui-user') || '[]'))).includes('note-zulu') && await zuluCard.locator('svg.text-amber-500').count() > 0);
  await page.locator('#notes-sidebar button[title="Свернуть группу"]').click();
  check('a pinned note stays visible above its collapsed group', await page.getByText('Zulu fixture', { exact: true }).count() === 1);
  const pinnedCard = page.locator('#notes-sidebar h3').filter({ hasText: 'Zulu fixture' }).locator('xpath=ancestor::div[contains(@class,"p-3")][1]');
  await pinnedCard.getByRole('button', { name: 'Открепить из верха списка' }).click();
  await page.waitForFunction(() => !JSON.parse(localStorage.getItem('pdm_pinned_notes_files-notes-ui-user') || '[]').includes('note-zulu') && document.querySelector('#notes-sidebar button[title="Развернуть группу"]') !== null);
  check('unpin restores a grouped note to its collapsed group without duplication', await page.getByText('Zulu fixture', { exact: true }).count() === 0 && await page.locator('#notes-sidebar button[title="Развернуть группу"]').count() === 1);
  await page.locator('#notes-sidebar button[title="Развернуть группу"]').click();
  check('expanding that group reveals the same unpinned note again', await page.getByText('Zulu fixture', { exact: true }).count() === 1);

  await page.getByRole('button', { name: 'Со мной' }).click();
  check('shared scope displays only the synthetic collaborator note', await page.getByText('Shared fixture').count() === 1 && await page.getByText('Zulu fixture').count() === 0);
  await page.getByRole('button', { name: 'Общие' }).click();
  check('legacy common scope displays the separate legacy record', await page.getByText('Legacy fixture').count() === 1 && await page.getByText('Shared fixture').count() === 0);
  await page.getByRole('button', { name: 'Мои' }).click();
  await page.getByRole('button', { name: 'А–Я' }).click();
  const alphaSorted = await cardTitles();
  check('title sort orders ungrouped and grouped synthetic notes alphabetically', alphaSorted[0] === 'Alpha fixture' && alphaSorted[1] === 'Group buddy fixture' && alphaSorted[2] === 'Zulu fixture');

  const zuluCardForDuplicate = page.locator('#notes-sidebar h3').filter({ hasText: 'Zulu fixture' }).locator('xpath=ancestor::div[contains(@class,"p-3")][1]');
  await zuluCardForDuplicate.getByRole('button', { name: 'Дублировать заметку' }).click();
  await page.waitForFunction(() => (window as any).__notesFixture.notes.some((note: any) => note.title === 'Zulu fixture (копия)'));
  const duplicateId = await page.evaluate(() => (window as any).__notesFixture.notes.find((note: any) => note.title === 'Zulu fixture (копия)')?.id || '');
  const duplicateState = await page.evaluate(() => {
    const notes = (window as any).__notesFixture.notes;
    return { source: notes.find((note: any) => note.id === 'note-zulu'), copy: notes.find((note: any) => note.title === 'Zulu fixture (копия)') };
  });
  check('duplicate has a new ID and preserves source text and group', !!duplicateId && duplicateState.copy.id !== duplicateState.source.id && duplicateState.copy.content === duplicateState.source.content && duplicateState.copy.groupName === duplicateState.source.groupName);
  await page.locator('#notes-content button[title="Группа заметки: объединяйте заметки по темам"]').click();
  await page.getByPlaceholder('Новая группа…').fill('Новая синтетическая группа');
  await page.getByRole('button', { name: 'Создать группу и добавить заметку' }).click();
  const green = page.locator('#notes-content button[title="Зеленый"]');
  await green.click();
  await page.waitForFunction((id) => {
    const notes = (window as any).__notesFixture.notes;
    const updated = notes.find((note: any) => note.id === id);
    return updated?.groupName === 'Новая синтетическая группа' && updated?.color.includes('bg-emerald-50');
  }, duplicateId);
  const updated = await page.evaluate((id) => (window as any).__notesFixture.notes.find((note: any) => note.id === id), duplicateId);
  check('group and color controls write expected fields to the independent API fixture', updated.groupName === 'Новая синтетическая группа' && updated.color.includes('bg-emerald-50'));

  check('component scenario has no uncaught browser errors', errors.length === 0);
  if (errors.length) console.error(errors);
} finally {
  await browser?.close();
  await vite.close();
  clearTimeout(timer);
}
console.log(`Notes component: ${passed} checks PASS (synthetic fixture)`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
