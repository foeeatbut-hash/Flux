type TraceController = {
  mark: (point: string) => Promise<void>;
  emit: () => Promise<void>;
};

const evaluateRaw = async (target: any, source: string) => target.locator('body').evaluate((_body: HTMLElement, code: string) => (0, eval)(code), source);

/** Passive, bounded trace for the native Sheets bind/undo path. */
export async function installNativeUndoDiagnostics(frame: any): Promise<TraceController> {
  const source = String.raw`(() => {
    const key = '__nativeSheetsUndoTrace';
    const targetTitle = 'Flux Office — Таблица';
    let root;
    try {
      root = window === window.parent ? window : window.parent;
      if (root.location.origin !== window.location.origin) return;
    } catch { return; }
    const initializeRoot = () => {
      if (root[key]) return root[key];
      const ids = new WeakMap();
      let nextId = 1;
      const objectId = (value) => {
        if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
        if (!ids.has(value)) ids.set(value, 'o' + nextId++);
        return ids.get(value);
      };
      const bounded = (value, depth = 0, budget = { left: 2400 }, seen = new WeakSet()) => {
        if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value ?? null;
        if (typeof value === 'string') {
          const clipped = value.length > 400 ? value.slice(0, 400) + '…' : value;
          budget.left -= clipped.length;
          return clipped;
        }
        if (typeof value !== 'object') return String(value);
        if (value instanceof ArrayBuffer) return { type: 'ArrayBuffer', byteLength: value.byteLength };
        if (ArrayBuffer.isView(value)) return { type: value.constructor?.name || 'TypedArray', byteLength: value.byteLength };
        if (typeof Blob !== 'undefined' && value instanceof Blob) return { type: 'Blob', size: value.size };
        if (depth > 5 || budget.left <= 0) return '[bounded]';
        if (seen.has(value)) return '[circular]';
        seen.add(value);
        if (Array.isArray(value)) {
          const result = value.slice(0, 16).map((item) => bounded(item, depth + 1, budget, seen));
          if (value.length > 16) result.push('[+' + (value.length - 16) + ' items]');
          return result;
        }
        const out = {};
        for (const [name, item] of Object.entries(value).slice(0, 32)) {
          if (/^(?:bytes|buffer|body|fileBytes|arrayBuffer)$/i.test(name) && item && typeof item === 'object') {
            out[name] = { type: item.constructor?.name || typeof item, byteLength: item.byteLength ?? item.length ?? item.size ?? null };
          } else out[name] = bounded(item, depth + 1, budget, seen);
          if (budget.left <= 0) { out.__bounded = true; break; }
        }
        return out;
      };
      const state = { snapshots: [], commands: [], ipc: [], attachments: [], errors: [], cleanups: [], requests: new Map(), disposed: false };
      const push = (list, item, max) => { list.push(item); if (list.length > max) list.splice(0, list.length - max); };
      const frameFor = (source) => [...root.document.querySelectorAll('iframe')].find((item) => item.title === targetTitle && item.contentWindow === source) || null;
      const snapshotFor = (source, point) => {
        try { return source?.__nativeSheetsUndoChild?.snapshot?.(point) ?? { point, at: Date.now(), missingChildObserver: true }; }
        catch (error) { return { point, at: Date.now(), snapshotError: String(error?.stack || error) }; }
      };
      const channelOf = (message) => message?.payload?.channel ?? message?.channel ?? message?.event ?? null;
      const ipcFilter = (channel) => /^(?:workbook:(?:open|select|save)|flux:.*(?:config|history)|flux:x-config)$/i.test(String(channel || ''));
      const recordMessage = (direction, event, snapshotSource) => {
        try {
          const message = event?.data;
          if (!message || message.flux !== 'office') return;
          let channel = channelOf(message);
          if (message.op === 'ipc' && message.id !== undefined && ipcFilter(channel)) state.requests.set(String(message.id), channel);
          const replyId = message.reply === undefined || message.reply === null ? null : String(message.reply);
          if (!ipcFilter(channel) && !(replyId && state.requests.has(replyId))) return;
          if (!ipcFilter(channel) && replyId) channel = state.requests.get(replyId);
          push(state.ipc, {
            direction, at: Date.now(), perf: Math.round(performance.now() * 10) / 10,
            op: message.op ?? null, channel, id: message.id ?? null, reply: message.reply ?? null,
            error: message.error ? String(message.error).slice(0, 300) : null,
            metadata: bounded(message.payload ?? message.result ?? message.args),
            current: snapshotFor(snapshotSource || event.source, 'ipc-' + direction),
          }, 40);
          if (replyId) state.requests.delete(replyId);
        } catch (error) { push(state.errors, 'ipc: ' + String(error?.stack || error), 8); }
      };
      const onParentMessage = (event) => {
        if (event.origin !== root.location.origin || !frameFor(event.source)) return;
        recordMessage('sheets-to-parent', event);
      };
      const stateObject = {
        snapshots: state.snapshots, commands: state.commands, ipc: state.ipc,
        attachments: state.attachments, errors: state.errors, cleanups: state.cleanups,
        objectId, bounded, push, frameFor, snapshotFor, recordMessage,
        initializeChild: null,
        mark(point) {
          try {
            const frame = root.document.querySelector('iframe[title="Flux Office — Таблица"]');
            const child = frame?.contentWindow;
            child?.__nativeSheetsUndoChild?.attachHooks?.();
            push(state.snapshots, snapshotFor(child, String(point).slice(0, 80)), 12);
          } catch (error) { push(state.errors, 'mark: ' + String(error?.stack || error), 8); }
        },
        emit() {
          if (state.disposed) return;
          state.disposed = true;
          root.removeEventListener('message', onParentMessage, true);
          for (const cleanup of state.cleanups.splice(0)) { try { cleanup(); } catch {} }
          console.log('NATIVE_SHEETS_UNDO_TRACE', JSON.stringify({ snapshots: state.snapshots, commands: state.commands, ipc: state.ipc, attachments: state.attachments, errors: state.errors }));
        },
      };
      root[key] = stateObject;
      root.addEventListener('message', onParentMessage, true);
      return stateObject;
    };
    const state = initializeRoot();
    if (window === root) return;
    try {
      if (window.frameElement?.title !== targetTitle || window.__nativeSheetsUndoChild) return;
      const runtimeNow = () => window.__fluxSheets?.univerRef?.current;
      const snapshot = (point) => {
        try {
          const runtime = runtimeNow();
          const api = runtime?.univerAPI;
          const wb = api?.getActiveWorkbook?.();
          const sheet = wb?.getSheets?.()?.find((item) => item.getSheetName?.() === 'Перечень') || wb?.getActiveSheet?.();
          const lazy = window.__fluxSheets?.lazyWorkbookRef?.current;
          const sheetId = sheet?.getSheetId?.() ?? null;
          const ranges = lazy?.loadedRanges ?? lazy?.loadedRangesMap;
          let loadedRange = null;
          try { loadedRange = ranges instanceof Map ? ranges.get(sheetId) ?? null : ranges?.[sheetId] ?? null; } catch {}
          let activeRange = null;
          try { activeRange = sheet?.getActiveRange?.()?.getA1Notation?.() ?? null; } catch {}
          let a1 = null;
          try { a1 = sheet?.getRange?.('A1')?.getValues?.()?.[0]?.[0] ?? null; } catch {}
          return {
            point, at: Date.now(), perf: Math.round(performance.now() * 10) / 10, timeOrigin: performance.timeOrigin,
            href: location.href, windowId: state.objectId(window), documentId: state.objectId(document),
            runtimeId: state.objectId(runtime), apiId: state.objectId(api), workbookObjectId: state.objectId(wb),
            workbookId: wb?.getId?.() ?? wb?.getWorkbookId?.() ?? null,
            sheetId, sheetName: sheet?.getSheetName?.() ?? null, a1, activeRange,
            preloadComplete: lazy?.flags?.preloadComplete ?? null, loadedRange: state.bounded(loadedRange),
          };
        } catch (error) { return { point, at: Date.now(), snapshotError: String(error?.stack || error) }; }
      };
      const commandFilter = /undo|redo|set-range-values|mutation/i;
      const commandRecord = (phase, wb, command) => {
        try {
          if (!commandFilter.test(String(command?.id || ''))) return;
          state.push(state.commands, {
            phase, at: Date.now(), perf: Math.round(performance.now() * 10) / 10,
            hookedWorkbookId: wb?.getId?.() ?? null, commandId: String(command?.id || ''),
            type: command?.type ?? null, params: state.bounded(command?.params),
            current: snapshot('command-' + phase),
          }, 36);
        } catch (error) { state.push(state.errors, String(error?.stack || error), 8); }
      };
      const attachments = new Map();
      const attachHooks = () => {
        try {
          const runtime = runtimeNow();
          const api = runtime?.univerAPI;
          const wb = api?.getActiveWorkbook?.();
          if (!wb) return;
          const keyId = state.objectId(runtime) + ':' + String(wb.getId?.() ?? wb.getWorkbookId?.() ?? 'unknown');
          if (attachments.has(keyId)) return;
          const available = { before: typeof wb.onBeforeCommandExecute === 'function', after: typeof wb.onCommandExecuted === 'function' };
          const dispose = [];
          if (available.before) {
            try { const subscription = wb.onBeforeCommandExecute((command) => commandRecord('before', wb, command)); if (typeof subscription?.dispose === 'function') dispose.push(() => subscription.dispose()); else if (typeof subscription === 'function') dispose.push(subscription); } catch (error) { state.push(state.errors, 'before hook: ' + String(error?.stack || error), 8); }
          }
          if (available.after) {
            try { const subscription = wb.onCommandExecuted((command) => commandRecord('after', wb, command)); if (typeof subscription?.dispose === 'function') dispose.push(() => subscription.dispose()); else if (typeof subscription === 'function') dispose.push(subscription); } catch (error) { state.push(state.errors, 'after hook: ' + String(error?.stack || error), 8); }
          }
          attachments.set(keyId, { wb, dispose });
          state.cleanups.push(() => { for (const fn of dispose) { try { fn(); } catch {} } });
          state.push(state.attachments, { at: Date.now(), keyId, workbookId: wb.getId?.() ?? null, runtimeId: state.objectId(runtime), available }, 12);
        } catch (error) { state.push(state.errors, 'attach: ' + String(error?.stack || error), 8); }
      };
      const onChildMessage = (event) => {
        if (event.source !== root || event.origin !== root.location.origin) return;
        state.recordMessage('parent-to-sheets', event, window);
        attachHooks();
      };
      const childObserver = { snapshot, attachHooks };
      window.__nativeSheetsUndoChild = childObserver;
      window.addEventListener('message', onChildMessage, true);
      const timer = setInterval(attachHooks, 100);
      state.cleanups.push(() => { clearInterval(timer); window.removeEventListener('message', onChildMessage, true); });
      state.push(state.attachments, { at: Date.now(), childWindowId: state.objectId(window), documentId: state.objectId(document), title: targetTitle, observerInstalled: true }, 12);
      attachHooks();
    } catch (error) { state.push(state.errors, 'child install: ' + String(error?.stack || error), 8); }
  })()`;
  try {
    const page = frame.page();
    await page.addInitScript(source);
    await evaluateRaw(page, source);
    await evaluateRaw(frame, source);
  } catch (error) {
    console.error('NATIVE_SHEETS_UNDO_TRACE_INSTALL_ERROR', String((error as any)?.stack || error));
  }
  return {
    mark: async (point) => { try { await evaluateRaw(frame.page(), `window.__nativeSheetsUndoTrace?.mark?.(\${JSON.stringify(point)});`); } catch (error) { console.error('NATIVE_SHEETS_UNDO_TRACE_MARK_ERROR', String((error as any)?.stack || error)); } },
    emit: async () => { try { await evaluateRaw(frame.page(), 'window.__nativeSheetsUndoTrace?.emit?.();'); } catch (error) { console.error('NATIVE_SHEETS_UNDO_TRACE_EMIT_ERROR', String((error as any)?.stack || error)); } },
  };
}
