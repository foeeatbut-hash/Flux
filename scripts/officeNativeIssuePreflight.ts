type IssueSaveArgs = {
  page: any;
  fileId: string;
  api: (method: string, route: string) => Promise<{ status: number; json: any }>;
  waitFor: (probe: () => Promise<boolean>, timeout?: number) => Promise<boolean>;
};

async function evaluateBrowserCode(page: any, code: string) {
  return page.evaluate((source: string) => (0, eval)(source), code);
}

/** Наблюдает начальный replay журнала в Sheets, не вмешиваясь в IPC. */
export async function installInitialReplayObserver(page: any) {
  const script = `(() => {
  if (window !== window.parent || window.__nativeIssueReplayObserver) return;
  const key = '__nativeIssueReplayObserver';
  const observer = { frames: [] };
  window[key] = observer;
  const reset = (state) => {
    for (const entry of state.listeners.values()) entry.child.removeEventListener('message', entry.listener);
    state.requests.clear();
    state.listeners.clear();
    state.configRequestId = null;
    state.wantRequestId = null;
    state.configSeen = false;
    state.collab = null;
    state.wantFromZeroSeen = false;
    state.initialFetched = false;
    state.expectedOpsCount = null;
    state.appliedOps = 0;
    state.ready = false;
    state.error = null;
  };
  const stateFor = (child) => {
    let state = observer.frames.find((entry) => entry.child === child);
    if (!state) {
      state = { child, requests: new Map(), listeners: new Map(), configRequestId: null, wantRequestId: null, configSeen: false, collab: null, wantFromZeroSeen: false, initialFetched: false, expectedOpsCount: null, appliedOps: 0, ready: false, error: null };
      observer.frames.push(state);
    }
    return state;
  };
  const onMessage = (event) => {
    if (event.origin !== location.origin || !event.data || event.data.flux !== 'office') return;
    const frame = [...document.querySelectorAll('iframe')].find((item) => item.title === 'Flux Office — Таблица' && item.contentWindow === event.source);
    if (!frame) return;
    const child = frame.contentWindow;
    const message = event.data;
    if (message.op === 'ipc' && Number.isInteger(message.id)) {
      const channel = message.payload?.channel;
      const from = channel === 'flux:x-want' ? Number(message.payload?.args?.[0]) : null;
      if (channel === 'flux:x-config' || channel === 'flux:x-want' && from === 0) {
        const state = stateFor(child);
        if (channel === 'flux:x-config') reset(state);
        const request = { channel, from };
        state.requests.set(message.id, request);
        if (channel === 'flux:x-config') state.configRequestId = message.id;
        else {
          state.wantFromZeroSeen = true;
          state.wantRequestId = message.id;
        }
        const listener = (replyEvent) => {
          const reply = replyEvent.data;
          if (replyEvent.source !== window || replyEvent.origin !== location.origin || !reply || reply.flux !== 'office' || reply.reply !== message.id) return;
          child.removeEventListener('message', listener);
          state.listeners.delete(message.id);
          state.requests.delete(message.id);
          if (reply.error) state.error = String(reply.error);
          if (channel === 'flux:x-config') {
            state.configSeen = true;
            state.collab = typeof reply.result?.collab === 'boolean' ? reply.result.collab : null;
          } else {
            state.initialFetched = Array.isArray(reply.result?.ops);
            state.expectedOpsCount = state.initialFetched ? reply.result.ops.length : null;
            if (!state.initialFetched && !state.error) state.error = 'flux:x-want reply had no ops array';
          }
        };
        state.listeners.set(message.id, { child, listener });
        child.addEventListener('message', listener);
      }
      return;
    }
    if (message.op !== 'ipc-send') return;
    const state = stateFor(child);
    const channel = message.payload?.channel;
    const args = message.payload?.args || [];
    if (channel === 'flux:x-ready') state.ready = true;
    if (channel === 'flux:x-applied') {
      const count = Number(args[0]);
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(state.appliedOps + count)) state.error = 'invalid flux:x-applied count';
      else state.appliedOps += count;
    }
  };
  window.addEventListener('message', onMessage);
  observer.dispose = () => window.removeEventListener('message', onMessage);
})()`;
  await page.addInitScript(script);
  await evaluateBrowserCode(page, script);
}

/** Waits for the initial shared-journal fetch and every fetched operation to apply. */
export async function waitForInitialReplayApplied(page: any, waitFor: (probe: () => Promise<boolean>, timeout?: number) => Promise<boolean>) {
  const inspect = async () => evaluateBrowserCode(page, `(() => {
    const iframe = [...document.querySelectorAll('iframe')].find((item) => item.title === 'Flux Office — Таблица');
    const observer = window.__nativeIssueReplayObserver;
    const state = observer?.frames?.find((entry) => entry.child === iframe?.contentWindow);
    if (!state) return { observerInstalled: !!observer, frameFound: !!iframe, configSeen: false, collab: null, initialFetched: false, expectedOpsCount: null, appliedOps: 0, ready: false, error: observer ? null : 'replay observer was not installed for this page' };
    return {
      observerInstalled: true, frameFound: true,
      configSeen: state.configSeen, collab: state.collab,
      configRequestId: state.configRequestId, wantRequestId: state.wantRequestId,
      wantFromZeroSeen: state.wantFromZeroSeen,
      initialFetched: state.initialFetched, expectedOpsCount: state.expectedOpsCount,
      appliedOps: state.appliedOps, ready: state.ready, error: state.error,
      requestIds: [...state.requests.keys()],
    };
  })()`);
  const isReady = (snapshot: any) => !snapshot.error && !!snapshot.configSeen && (snapshot.collab === false || snapshot.collab === true && snapshot.ready === true && snapshot.wantFromZeroSeen === true && snapshot.initialFetched === true && Number.isSafeInteger(snapshot.expectedOpsCount) && snapshot.expectedOpsCount >= 0 && Number.isSafeInteger(snapshot.appliedOps) && snapshot.appliedOps >= 0 && snapshot.appliedOps >= snapshot.expectedOpsCount);
  let snapshot: any = null;
  let ready = false;
  try {
    ready = await waitFor(async () => {
      snapshot = await inspect();
      return isReady(snapshot);
    });
    snapshot = await inspect();
    ready = ready && isReady(snapshot);
  } catch (error: any) {
    snapshot = { ...(snapshot || {}), observerError: error?.stack || String(error) };
    ready = false;
  }
  console.log('OFFICE_ISSUED_XLSX_REPLAY_READINESS', JSON.stringify({ ready, snapshot }));
  if (!ready) console.error('OFFICE_ISSUED_XLSX_REPLAY_NOT_READY', JSON.stringify(snapshot));
  return ready;
}

/** Наблюдаем реальный IPC-ответ сохранения, затем проверяем сохранённость общего журнала. */
export async function saveAndWaitForIssueReady(args: IssueSaveArgs) {
  const key = '__nativeIssueSave_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  await evaluateBrowserCode(args.page, `(({ key }) => {
    const parent = window;
    const iframe = [...document.querySelectorAll('iframe')].find(item => item.title === 'Flux Office — Таблица');
    const child = iframe?.contentWindow;
    if (!child) throw new Error('Native Sheets iframe missing before save');
    const spy = { requests: [], replies: [] };
    parent[key] = spy;
    const request = event => {
      const m = event.data;
      if (event.source !== child || event.origin !== parent.location.origin || !m || m.flux !== 'office'
        || m.op !== 'ipc' || m.payload?.channel !== 'workbook:save' || !Number.isInteger(m.id)) return;
      spy.requests.push({ id: m.id, at: Date.now() });
      if (spy.requests.length > 12) spy.requests.shift();
    };
    const reply = event => {
      const m = event.data;
      if (event.source !== parent || event.origin !== parent.location.origin || !m || m.flux !== 'office'
        || !Number.isInteger(m.reply) || !spy.requests.some(item => item.id === m.reply)) return;
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
  })(${JSON.stringify({ key })})`);
  const metaSamples: Array<{ status: number; pendingSharedEdits?: unknown; updatedAt?: unknown; error?: string }> = [];
  let observed: any = null;
  try {
    await args.page.keyboard.press('Control+s');
    const acknowledged = await args.waitFor(async () => {
      observed = await evaluateBrowserCode(args.page, `(key => {
        const spy = window[key], first = spy?.requests[0];
        return { requests: spy?.requests || [], replies: spy?.replies || [], reply: first ? spy.replies.find(item => item.id === first.id) : null };
      })(${JSON.stringify(key)})`);
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
    await evaluateBrowserCode(args.page, `(key => { const spy = window[key]; spy?.dispose?.(); delete window[key]; })(${JSON.stringify(key)})`).catch(() => {});
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
