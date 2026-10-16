type IssueSaveArgs = {
  page: any;
  fileId: string;
  api: (method: string, route: string) => Promise<{ status: number; json: any }>;
  waitFor: (probe: () => Promise<boolean>, timeout?: number) => Promise<boolean>;
};

/** Выпуск проверяет сохранённую общую книгу, поэтому ждём подтверждения записи и чистого журнала. */
export async function saveAndWaitForIssueReady(args: IssueSaveArgs) {
  const id = encodeURIComponent(args.fileId);
  const contentPath = '/api/office/files/' + id + '/content';
  const metaPath = '/api/office/files/' + id + '/meta';
  const responseWait = args.page.waitForResponse((response: any) => {
    try { return new URL(response.url()).pathname === contentPath && response.request().method() === 'PUT'; }
    catch { return false; }
  }, { timeout: 10_000 }).then(async (response: any) => ({
    status: response.status(), ok: response.ok(),
    body: (await response.text().catch(() => '')).slice(0, 500),
  })).catch((error: unknown) => ({ status: 0, ok: false, body: String(error).slice(0, 240) }));
  await args.page.keyboard.press('Control+s');
  const save = await responseWait;
  const metaSamples: Array<{ status: number; pendingSharedEdits?: unknown; updatedAt?: unknown; error?: string }> = [];
  let converged = false;
  if (save.ok) converged = await args.waitFor(async () => {
    try {
      const meta = await args.api('GET', metaPath);
      if (metaSamples.length < 6) metaSamples.push({ status: meta.status, pendingSharedEdits: meta.json?.pendingSharedEdits, updatedAt: meta.json?.updatedAt });
      return meta.status === 200 && meta.json?.pendingSharedEdits === false;
    } catch (error) {
      if (metaSamples.length < 6) metaSamples.push({ status: 0, error: String(error).slice(0, 160) });
      return false;
    }
  }, 12_000);
  if (!save.ok || !converged) {
    console.error('OFFICE_ISSUE_SAVE_PREFLIGHT_FAILED', JSON.stringify({ fileId: args.fileId, save, metaSamples }));
    throw new Error('XLSX ' + args.fileId + ' did not save and settle before issue');
  }
}

export async function prepareStandaloneXlsxForIssue(args: IssueSaveArgs & {
  navigateOffice: (page: any, route: string) => Promise<void>;
  openPanel: (page: any, title: string) => Promise<any>;
  waitForSheetFile: (frame: any) => Promise<boolean>;
}) {
  await args.navigateOffice(args.page, '/office-sheet?file=' + encodeURIComponent(args.fileId));
  const frame = await args.openPanel(args.page, 'Flux Office — Таблица');
  if (!await args.waitForSheetFile(frame)) throw new Error('Standalone XLSX editor did not load before issue preflight');
  const address = frame.locator('input.univer-box-border').first();
  await address.fill('Z20'); await address.press('Enter');
  await frame.locator('canvas[id^="univer-sheet-main-canvas_"]').first().focus();
  await args.page.keyboard.type('NATIVE_ISSUE_PREFLIGHT_' + Date.now());
  await args.page.keyboard.press('Enter');
  await saveAndWaitForIssueReady(args);
}
