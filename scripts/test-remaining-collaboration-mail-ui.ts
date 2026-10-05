import assert from 'node:assert/strict';
import { chmod, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from '../node_modules/playwright-core/index.mjs';
import { loginPage } from './officeHarness';

type Fixture = {
  kind: string;
  databaseName: string;
  servers: Array<{ origin: string }>;
  accounts: Array<{ id: string; symbol: string; password: string; role: string }>;
  mailFixture: {
    accountId: string; personalAccountId: string; folderId: string;
    messageId: string; attachmentId: string; threadKey: string; syntheticSuffix: string;
  };
};

async function main() {
assert.equal(process.env.FLUX_TEST_FIXTURE, '1', 'mail UI live test requires the explicitly isolated FLUX_TEST_FIXTURE=1 server');
assert.ok(process.env.FLUX_REMAINING_LIVE_METADATA, 'mail UI live test requires explicit private fixture metadata');
const metadataPath = path.resolve(process.env.FLUX_REMAINING_LIVE_METADATA!);
const metadataStat = await readFile(metadataPath).then(async (bytes) => {
  const { stat } = await import('node:fs/promises');
  return { bytes, mode: (await stat(metadataPath)).mode & 0o777 };
});
assert.equal(metadataStat.mode & 0o077, 0, 'fixture metadata must remain private (0600)');
const fixture = JSON.parse(metadataStat.bytes.toString('utf8')) as Fixture;
assert.equal(fixture.kind, 'flux-remaining-live-fixture');
assert.match(fixture.databaseName, /^flux_[a-z0-9_]+_fixture(?:_|$)/i);
assert.equal(fixture.servers.length, 2);
assert.ok(fixture.mailFixture?.messageId && fixture.mailFixture.attachmentId, 'seed-mail fixture details are required');
const [admin, coworker] = fixture.accounts.filter((a) => a.role === 'ADMIN' || a.role === 'ENGINEER_VENT');
assert.ok(admin && coworker);
const origin = new URL(fixture.servers[0].origin);
const otherOrigin = new URL(fixture.servers[1].origin);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && ['127.0.0.1', 'localhost', '[::1]'].includes(otherOrigin.hostname));
assert.notEqual(origin.origin, otherOrigin.origin);
const account = fixture.mailFixture;
const subject = `Проверка общего ящика ${account.syntheticSuffix}`;
const fileName = `collaboration-fixture-${account.syntheticSuffix}.txt`;
const payload = `Synthetic Flux collaboration attachment ${account.syntheticSuffix}\n`;

function assertPage(page: Page, errors: string[]) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === origin.origin && response.status() >= 500) errors.push(`HTTP ${response.status()} ${url.pathname}`);
  });
}

async function login(page: Page, user: { symbol: string; password: string }) {
  await loginPage(page, origin.origin, user);
  await page.goto(`${origin.origin}/#/mail`);
  try {
    await page.getByRole('button', { name: 'Настройки ящика' }).waitFor({ timeout: 15_000 });
  } catch {
    const diagnostic = await page.evaluate(() => ({
      href: location.href,
      title: document.title,
      text: (document.body.innerText || '').slice(0, 1000),
      rootText: document.querySelector('#root')?.textContent?.slice(0, 500) || '',
    }));
    throw new Error(`mail UI did not open after login: ${JSON.stringify(diagnostic)}`);
  }
}

async function assertLayout(page: Page, width: number) {
  await page.setViewportSize({ width, height: 820 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
    const layout = await page.evaluate(() => ({
      viewport: innerWidth,
      body: document.documentElement.scrollWidth,
      outsideControls: [...document.querySelectorAll('button,input,select')].filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
      }).length,
    }));
    assert.ok(layout.body <= width + 2 && layout.outsideControls === 0, `mail UI geometry ${width}px ${theme}: ${JSON.stringify(layout)}`);
  }
}

const errors: string[] = [];
const browser: Browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
let savedFileId = '';
let adminPage: Page | null = null;
let coworkerPage: Page | null = null;
let externalRequests = 0;
try {
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await adminContext.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== origin.origin) {
      externalRequests++;
      await route.abort();
      return;
    }
    await route.continue();
  });
  adminPage = await adminContext.newPage();
  assertPage(adminPage, errors);
  await login(adminPage, admin);

  // Reset only this synthetic thread for this admin, in case the prior API suite
  // already tested the same per-person local Seen key.
  await adminPage.evaluate(async (ids) => {
    const response = await fetch('/api/mail/flag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, flag: 'seen', on: false }) });
    if (!response.ok) throw new Error(`Could not reset fixture unread state: ${response.status}`);
  }, [account.messageId]);

  try {
    await adminPage.getByText(subject, { exact: true }).waitFor({ timeout: 30_000 });
  } catch {
    const visible = (await adminPage.locator('body').innerText()).slice(0, 900);
    throw new Error(`seeded mail thread did not appear in the live UI; visible page text: ${visible}`);
  }
  assert.match(await adminPage.locator('body').innerText(), /Проверочная общая/, 'the seeded shared account did not load in the real mail UI');

  // Search keyboard: slash focuses the actual mail search; clear restores the list.
  await adminPage.keyboard.press('/');
  const search = adminPage.getByRole('textbox', { name: 'Поиск по письмам' });
  await search.waitFor();
  assert.equal(await search.evaluate((el) => el === document.activeElement), true, 'slash shortcut did not focus mail search');
  await search.fill(account.syntheticSuffix);
  await adminPage.getByText(subject, { exact: true }).waitFor();
  await adminPage.getByRole('button', { name: 'Очистить поиск' }).click();
  await search.waitFor((el) => el.inputValue().then((value) => value === ''));

  // Exercise editable account fields against the real API but stub only the
  // external IMAP/SMTP verification step. The synthetic account stays inactive.
  const verifyPath = new RegExp(`/api/mail/accounts/${account.accountId}/verify$`);
  let verifyRequests = 0;
  await adminPage.route(verifyPath, async (route) => {
    verifyRequests++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ imap: { ok: false, folders: 0, error: 'Изолированная фикстура не подключает почтовый сервер' }, smtp: { ok: false, error: 'Изолированная фикстура не подключает почтовый сервер' } }) });
  });
  await adminPage.getByRole('button', { name: 'Настройки ящика' }).click();
  const accountDialog = adminPage.getByRole('dialog', { name: 'Подключение почтового ящика' });
  await accountDialog.waitFor();
  const labelInput = accountDialog.locator('#mail-label');
  const originalLabel = await labelInput.inputValue();
  const editedLabel = `${originalLabel} · UI fixture`;
  await labelInput.fill(editedLabel);
  await accountDialog.getByRole('button', { name: 'Сохранить и проверить', exact: true }).click();
  await accountDialog.getByText('Изолированная фикстура не подключает почтовый сервер', { exact: true }).waitFor();
  assert.equal(verifyRequests, 1, 'account edit did not reach the explicitly stubbed verification boundary');
  const edited = await adminPage.evaluate(async (id) => {
    const response = await fetch('/api/mail/accounts');
    const data = await response.json();
    return data.accounts.find((item: any) => item.id === id)?.label;
  }, account.accountId);
  assert.equal(edited, editedLabel, 'account edit did not persist through the real API');
  await labelInput.fill(originalLabel);
  await accountDialog.getByRole('button', { name: 'Сохранить и проверить', exact: true }).click();
  await accountDialog.getByText('Изолированная фикстура не подключает почтовый сервер', { exact: true }).waitFor();
  assert.equal(verifyRequests, 2, 'fixture account label was not restored');
  await accountDialog.getByRole('button', { name: 'Закрыть' }).click();
  await adminPage.unroute(verifyPath);

  // Unread-folder filter and bulk selection are exercised on the same seeded row.
  await adminPage.getByRole('button', { name: 'Непрочитанные' }).click();
  await adminPage.getByText(subject, { exact: true }).waitFor();
  const row = adminPage.getByRole('listitem').filter({ hasText: subject });
  const pick = row.getByRole('checkbox', { name: `Отметить переписку «${subject}»` });
  await pick.check();
  await adminPage.getByText('Отмечено: 1', { exact: true }).waitFor();
  await adminPage.getByRole('button', { name: 'Снять отметки' }).click();
  assert.equal(await pick.isChecked(), false, 'clear-selection did not unpick the thread');

  // Opening the real thread marks it read for this employee. The iframe must
  // remove active HTML and remain sandboxed; no external content is requested.
  await row.click();
  const frame = adminPage.locator(`iframe[title="Письмо: ${subject}"]`);
  await frame.waitFor({ timeout: 20_000 });
  const frameSource = await frame.getAttribute('srcdoc') || '';
  assert.equal(await frame.getAttribute('sandbox'), '', 'mail body iframe must have no script or same-origin sandbox permissions');
  assert.doesNotMatch(frameSource, /<script|onerror\s*=|javascript:|fixture\.invalid|position\s*:\s*fixed/i, 'malicious HTML survived mail sanitization');
  const opaqueOrigin = await adminPage.evaluate((selector) => {
    const iframe = document.querySelector(selector) as HTMLIFrameElement | null;
    try { return !iframe?.contentDocument?.body; } catch { return true; }
  }, `iframe[title="Письмо: ${subject}"]`);
  assert.equal(opaqueOrigin, true, 'mail body must be inaccessible to the parent page');
  assert.equal(externalRequests, 0, 'mail body triggered an external request');
  const adminReadState = await adminPage.evaluate(async ({ accountId, threadKey }) => {
    const response = await fetch(`/api/mail/threads?accountId=${encodeURIComponent(accountId)}`);
    const data = await response.json();
    const thread = (data.threads || []).find((item: any) => item.threadKey === threadKey);
    return { ok: response.ok, unread: thread?.unread };
  }, { accountId: account.accountId, threadKey: account.threadKey });
  assert.equal(adminReadState.ok, true, 'could not read the administrator thread state through the live API');
  assert.equal(adminReadState.unread, false, 'opening the thread did not mark it read for this employee');

  const claimButton = adminPage.getByRole('button', { name: 'Взять в работу', exact: true });
  const releaseButton = adminPage.getByRole('button', { name: 'Отпустить', exact: true });
  // Earlier attempts may have left this one disposable seed thread claimed by
  // this administrator. Release that exact fixture before asserting takeover.
  if (await releaseButton.count()) {
    await releaseButton.click();
    await claimButton.waitFor({ timeout: 10_000 });
  }
  try {
    await claimButton.waitFor({ timeout: 5_000 });
  } catch {
    const claimUi = await adminPage.evaluate(() => ({
      text: (document.body.innerText || '').slice(-900),
      buttons: [...document.querySelectorAll('button')].map((button) => (button.innerText || button.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(-20),
    }));
    throw new Error(`shared thread claim control missing: ${JSON.stringify(claimUi)}`);
  }
  await claimButton.click();
  await adminPage.getByText('В работе у вас', { exact: true }).waitFor();

  // Another synthetic employee sees both the shared account and the claim, but
  // cannot see the administrator's personal mailbox or silently steal the work.
  const coworkerContext = await browser.newContext({ viewport: { width: 1024, height: 820 } });
  await coworkerContext.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== origin.origin) {
      externalRequests++;
      await route.abort();
      return;
    }
    await route.continue();
  });
  coworkerPage = await coworkerContext.newPage();
  assertPage(coworkerPage, errors);
  await login(coworkerPage, coworker);
  await coworkerPage.evaluate(async (ids) => {
    const response = await fetch('/api/mail/flag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, flag: 'seen', on: false }) });
    if (!response.ok) throw new Error(`Could not reset colleague fixture unread state: ${response.status}`);
  }, [account.messageId]);
  await coworkerPage.getByText(subject, { exact: true }).waitFor({ timeout: 30_000 });
  const coworkerBeforeOpen = await coworkerPage.evaluate(async ({ accountId, threadKey }) => {
    const response = await fetch(`/api/mail/threads?accountId=${encodeURIComponent(accountId)}`);
    const data = await response.json();
    const thread = (data.threads || []).find((item: any) => item.threadKey === threadKey);
    return { ok: response.ok, unread: thread?.unread };
  }, { accountId: account.accountId, threadKey: account.threadKey });
  assert.equal(coworkerBeforeOpen.ok, true);
  assert.equal(coworkerBeforeOpen.unread, true, 'administrator reading the shared thread changed the colleague unread state');
  assert.doesNotMatch(await coworkerPage.locator('body').innerText(), new RegExp(fixture.mailFixture.personalAccountId), 'another employee can identify the personal mailbox by its seeded id');
  assert.doesNotMatch(await coworkerPage.locator('body').innerText(), /collab-personal-[a-f0-9]+@flux\.invalid/, 'another employee can see an owner-only personal email address');
  const coworkerRow = coworkerPage.getByRole('listitem').filter({ hasText: subject });
  assert.equal(await coworkerRow.count(), 1, 'colleague could not read the shared seed thread');
  await coworkerRow.click();
  const coworkerClaimStatus = coworkerPage.getByText(/^В работе у .+$/);
  await coworkerClaimStatus.waitFor();
  assert.doesNotMatch(await coworkerClaimStatus.innerText(), /В работе у вас/, 'the colleague saw the administrator claim as their own');
  assert.equal(externalRequests, 0, 'rendering the mail thread for a colleague triggered an external request');
  await coworkerPage.getByRole('button', { name: 'Взять в работу', exact: true }).click();
  await coworkerPage.getByText(/уже ведёт/).waitFor();
  await adminPage.getByRole('button', { name: 'Отпустить', exact: true }).click();

  // Cross-program command: choose the attachment destination through the mail
  // UI, then independently read the resulting Explorer file and bytes.
  await adminPage.getByRole('button', { name: `Сохранить ${fileName} в Проводник` }).click();
  const folderDialog = adminPage.getByRole('dialog', { name: 'Куда сохранить вложение' });
  await folderDialog.waitFor();
  const savedResponsePromise = adminPage.waitForResponse((response) => new URL(response.url()).pathname === `/api/mail/attachments/${account.attachmentId}/to-explorer` && response.status() === 200);
  await folderDialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const savedResponse = await savedResponsePromise;
  const saved = await savedResponse.json();
  savedFileId = String(saved?.file?.id || '');
  assert.ok(savedFileId, 'mail attachment command did not create an Explorer file');
  await adminPage.getByText(/сохранён в Проводник/).waitFor();
  const explorer = await adminPage.evaluate(async (id) => {
    const response = await fetch(`/api/files/${encodeURIComponent(id)}`);
    if (!response.ok) return { status: response.status };
    const data = await response.json();
    return { status: response.status, name: data.file?.name, content: data.file?.content };
  }, savedFileId);
  assert.equal(explorer.status, 200, 'Explorer cannot read the file saved from mail');
  assert.equal(explorer.name, fileName, 'Explorer filename differs from the source attachment');
  assert.equal(explorer.content, `data:text/plain;base64,${Buffer.from(payload).toString('base64')}`, 'Explorer bytes differ from the original attachment');

  for (const width of [390, 1024]) await assertLayout(adminPage, width);
  assert.equal(errors.length, 0, `unexpected page errors or server failures: ${errors.join(' | ')}`);
  console.log(JSON.stringify({
    result: 'passed', suite: 'collab-mail-browser-live', layer: 'browser-live',
    actionIds: ['mail.account.connect-edit', 'mail.search-shortcuts', 'mail.sync-folders-filters', 'mail.bulk-actions', 'mail.open-thread-unread', 'mail.claim-thread'],
    connectionIds: ['mail.to-explorer'],
    claims: [
      'real account edit persists through API while mail server verification stays explicitly isolated',
      'slash focuses mail search and clearing it restores the seeded list',
      'unread filter and selection clearing operate on the seeded shared thread',
      'opening the thread renders sanitized malicious HTML inside an empty-permission sandbox',
      'the parent page cannot read the opaque-origin mail body and no external resource was requested',
      'a second employee sees the shared thread and claim but not the administrator personal account',
      'mail UI cannot let the second employee take an already-claimed thread',
      'saving an attachment from mail creates an Explorer file whose bytes match the seed payload',
      '390px and 1024px layouts fit in both themes',
    ],
    verifyExternalMailOrIMAP: 'NOT_RUN', errors,
  }, null, 2));
} finally {
  if (savedFileId && adminPage) {
    await adminPage.evaluate(async (id) => { await fetch(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' }); }, savedFileId).catch(() => {});
  }
  await browser.close();
}
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
