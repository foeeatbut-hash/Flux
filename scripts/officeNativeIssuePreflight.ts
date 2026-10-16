type IssueSaveArgs = {
  page: any;
  fileId: string;
  api: (method: string, route: string) => Promise<{ status: number; json: any }>;
  waitFor: (probe: () => Promise<boolean>, timeout?: number) => Promise<boolean>;
};

/** Наблюдаем реальный IPC-ответ сохранения, затем проверяем сохранённость общего журнала. */
export async function saveAndWaitForIssueReady(args: IssueSaveArgs) {
  const key = '__nativeIssueSave_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  await args.page.evaluate(({ key }: { key: string }) => {
    const parent = window;
    const iframe = [...document.querySelectorAll('iframe')].find(item => item.title === 'Flux Office — Таблица');
    const child = iframe?.contentWindow;
    if (!child) throw new Error('Native Sheets iframe missing before save');
    const spy: any = { requests: [], replies: [] };
    (parent as any)[key] = spy;
    const request = (event: MessageEvent) => {
      const m = event.data;
      if (event.source !== child || event.origin !== parent.location.origin || !m || m.flux !== 'office'
        || m.op !== 'ipc' || m.payload?.channel !== 'workbook:save' || !Number.isInteger(m.id)) return;
      spy.requests.push({ id: m.id, at: Date.now() });
      if (spy.requests.length > 12) spy.requests.shift();
    };
    const reply = (event: MessageEvent) => {
      const m = event.data;
      if (event.source !== parent || event.origin !== parent.location.origin || !m || m.flux !== 'office'
        || !Number.isInteger(m.reply) || !spy.requests.some((item: any) => item.id === m.reply)) return;
      const result = m.result;
      spy.replies.push({
        id: m.reply, at: Date.now(), present: !!result, kind: typeof result,
        ok: result?.ok !== false, canceled: !!result?.canceled,
        error: m.error ? String(m.error).slice(0, 300) : result?.error ? String(result.error).slice(0, 300) : null,
      });
      if (spy.replies.length > 12) spy.replies.shift();
    };
    parent.addEventListener('message', request);
    child.addEventListener('message', reply);
    spy.dispose = () => { parent.removeEventListener('message', request); child.removeEventListener('message', reply); };
  }, { key });
  const metaSamples: Array<{ status: number; pendingSharedEdits?: unknown; updatedAt?: unknown; error?: string }> = [];
  let observed: any = null;
  try {
    await args.page.keyboard.press('Control+s');
    const acknowledged = await args.waitFor(async () => {
      observed = await args.page.evaluate((key: string) => {
        const spy = (window as any)[key], first = spy?.requests[0];
        return { requests: spy?.requests || [], replies: spy?.replies || [], reply: first ? spy.replies.find((item: any) => item.id === first.id) : null };
      }, key);
      return !!observed.reply;
    }, 15_000);
    const reply = observed?.reply;
    const saved = acknowledged && reply?.present && reply.ok && !reply.canceled && !reply.error;
    let converged = false;
    if (saved) converged = await args.waitFor(async () => {
      try {
        const meta = await args.api('GET', '/api/office/files/' + encodeURIComponent(args.fileId) + '/meta');
        if (metaSamples.length === 6) metaSamples.shift();
        metaSamples.push({ status: meta.status, pendingSharedEdits: meta.json?.pendingSharedEdits, updatedAt: meta.json?.updatedAt });
        return meta.status === 200 && meta.json?.pendingSharedEdits === false;
      } catch (error) {
        if (metaSamples.length === 6) metaSamples.shift();
        metaSamples.push({ status: 0, error: String(error).slice(0, 160) });
        return false;
      }
    }, 12_000);
    if (!saved || !converged) {
      console.error('OFFICE_ISSUE_SAVE_PREFLIGHT_FAILED', JSON.stringify({ fileId: args.fileId, observed, metaSamples }));
      throw new Error('XLSX ' + args.fileId + ' did not save and settle before issue');
    }
    console.log('OFFICE_ISSUE_SAVE_PREFLIGHT_PASSED', JSON.stringify({ fileId: args.fileId, requestId: reply.id }));
  } finally {
    await args.page.evaluate((key: string) => { const spy = (window as any)[key]; spy?.dispose?.(); delete (window as any)[key]; }, key).catch(() => {});
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
