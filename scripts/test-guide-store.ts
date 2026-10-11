import { useGuideStore } from '../src/guide/store';
import type { GuideMessage } from '../src/guide/types';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const project = (id: string, name = id) => ({ id, name });
const oldMessage: GuideMessage = { id: 'old', role: 'guide', text: 'Sensitive row', projectId: 'p1', context: { intent: 'equipment_list', label: 'Fans', projectId: 'p1' } };
let failed = 0;
const check = (condition: unknown, name: string) => condition ? console.log(`ok   ${name}`) : (failed++, console.error(`FAIL ${name}`));
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

async function main() {
  const originalFetch = globalThis.fetch;
  try {
    const store = useGuideStore;
    store.getState().setUserGetter(() => ({ id: 'store-test-user' }));
    store.setState({ projectId: 'p1', projectName: 'Project one', projects: [project('p1'), project('p2')], messages: [], chatId: null, lastResult: null, chatSaveState: 'idle', draftQuestions: '' });

    // A confirmed 403 drops already-rendered project rows and continuation state.
    globalThis.fetch = (async () => json({ error: 'no access', code: 'FORBIDDEN' }, 403)) as typeof fetch;
    store.setState({ messages: [oldMessage], lastResult: { intent: 'equipment_list', label: 'Fans', projectId: 'p1' } });
    await store.getState().ask('покажи все вентиляторы');
    check(store.getState().messages.every((m) => m.id !== 'old') && store.getState().lastResult === null, '403 clears prior project messages and continuation context');

    // Switching projects while a server response is pending stores it against
    // its original project and never appends it to the newly-selected chat.
    let resolveComponents!: (response: Response) => void;
    const delayedComponents = new Promise<Response>((resolve) => { resolveComponents = resolve; });
    let saved: any = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PUT') { saved = JSON.parse(String(init.body)); return json({ ok: true }); }
      if (url.includes('/components?')) return delayedComponents;
      return json({ chats: [] });
    }) as typeof fetch;
    store.setState({ projectId: 'p1', projectName: 'Project one', messages: [], chatId: null, lastResult: null, chatSaveState: 'idle' });
    const asking = store.getState().ask('покажи все вентиляторы');
    await pause();
    const switching = store.getState().setProject('p2', 'Project two');
    await pause();
    await switching;
    resolveComponents(json({ total: 1, items: [{ id: 'c1', name: 'Fan', itemCode: 'F-1', equipType: 'ВЕНТИЛЯТОР', role: '', systemName: 'P1', systemCategory: '', monoblockName: '', status: '', hasConflict: false, tags: [], specs: [], specsTotal: 0 }] }));
    await asking;
    await pause();
    check(store.getState().projectId === 'p2' && store.getState().messages.length === 0, 'late old-project answer does not enter the new project chat');
    check(saved?.projectId === 'p1' && saved.messages?.some((m: GuideMessage) => m.projectId === 'p1'), 'late answer is persisted to the captured original project');

    // Actor changes invalidate in-flight answers rather than mutating the next
    // account's chat or creating a cross-user save.
    let resolveUserComponents!: (response: Response) => void;
    const userComponents = new Promise<Response>((resolve) => { resolveUserComponents = resolve; });
    let puts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') { puts++; return json({ ok: true }); }
      if (String(input).includes('/components?')) return userComponents;
      return json({ chats: [] });
    }) as typeof fetch;
    store.getState().setUserGetter(() => ({ id: 'first-user' }));
    store.setState({ projectId: 'p1', projectName: 'Project one', messages: [], chatId: null, lastResult: null });
    const stale = store.getState().ask('покажи все вентиляторы');
    await pause();
    store.getState().setUserGetter(() => ({ id: 'second-user' }));
    resolveUserComponents(json({ total: 1, items: [] }));
    await stale;
    check(store.getState().messages.length === 0 && store.getState().projectId === null && puts === 0, 'old actor response cannot write into the next user state');

    let sessionUser: { id: string } | null = { id: 'dynamic-user-a' };
    const liveGetter = () => sessionUser;
    store.getState().setUserGetter(liveGetter);
    store.setState({ messages: [oldMessage], projectId: 'p1', projectName: 'Project one', lastResult: { intent: 'equipment_list', label: 'Fans', projectId: 'p1' } });
    sessionUser = { id: 'dynamic-user-b' };
    store.getState().setUserGetter(liveGetter);
    check(store.getState().messages.length === 0 && store.getState().lastResult === null && store.getState().projectId === null, 'live getter detects actor change and purges prior user data');

    // A transient save failure blocks project switching but preserves the
    // current unsaved conversation and its draft for retry.
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    store.setState({ projectId: 'p1', projectName: 'Project one', messages: [{ id: 'q', role: 'user', text: 'keep me' }], chatId: null, chatSaveState: 'error', chatSaveError: 'offline', draftQuestions: 'draft survives' });
    await store.getState().setProject('p2', 'Project two');
    check(store.getState().projectId === 'p1' && store.getState().messages[0]?.text === 'keep me' && store.getState().draftQuestions === 'draft survives', 'transient save failure preserves project, unsaved conversation, and draft');
  } finally { globalThis.fetch = originalFetch; }
  console.log(failed ? `\n${failed} Guide store check(s) failed` : '\nGuide store checks passed');
  process.exitCode = failed ? 1 : 0;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
