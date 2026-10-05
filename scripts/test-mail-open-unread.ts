import assert from 'node:assert/strict';
import { mailService, type MailThread, type MailThreadState } from '../src/services/mailService';
import { selectOpenMailThread, useMailStore } from '../src/store/mailStore';

const thread: MailThread = {
  threadKey: 'fixture-thread', count: 1, unread: true, flagged: false, hasFiles: false,
  answered: false, subject: 'Synthetic unread thread', snippet: 'Synthetic fixture',
  sentAt: '2026-10-04T00:00:00.000Z', from: [], lastId: 'fixture-message', ids: ['fixture-message'],
};

const originalFlag = mailService.flag;
const originalFolders = mailService.folders;
const originalThreads = mailService.threads;
const originalClaim = mailService.claim;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const emptyState: MailThreadState = {
  status: 'NEW', claimedById: '', claimedByName: '', claimedAt: null,
  repliedById: '', repliedByName: '', repliedAt: null,
};

async function main() {
  let seen = false;
  mailService.flag = async (ids, flag, on) => {
    assert.deepEqual(ids, ['fixture-message']);
    assert.equal(flag, 'seen');
    seen = on;
    return { ok: true, changed: ids.length };
  };
  mailService.folders = async () => ({ folders: [{ id: 'inbox', name: 'Входящие', kind: 'INBOX', unread: seen ? 0 : 1 } as any], shared: true });
  mailService.threads = async ({ unread }) => ({ threads: unread && seen ? [] : [thread], total: unread && seen ? 0 : 1, shared: true });

  useMailStore.setState({
    accountId: 'fixture-account', folderId: 'inbox', filter: 'unread', threads: [thread],
    openKey: '', activeThread: null, picked: [],
  });
  useMailStore.getState().open(thread.threadKey);
  assert.equal(selectOpenMailThread(useMailStore.getState().threads, thread.threadKey, useMailStore.getState().activeThread)?.subject, thread.subject);

  await useMailStore.getState().markSeen(thread.ids, true);
  const state = useMailStore.getState();
  assert.equal(seen, true, 'opening an unread message should persist the read marker');
  assert.equal(state.threads.length, 0, 'the unread filter should remove the now-read row');
  assert.equal(state.openKey, thread.threadKey, 'refreshing the unread filter must not close the active thread');
  assert.equal(state.activeThread?.unread, false, 'the retained thread snapshot should reflect the new read state');
  assert.equal(selectOpenMailThread(state.threads, state.openKey, state.activeThread)?.subject, thread.subject,
    'the active thread should remain renderable after its row leaves the unread list');

  useMailStore.getState().open('');
  assert.equal(useMailStore.getState().activeThread, null, 'explicitly closing the thread should discard its snapshot');
  assert.equal(selectOpenMailThread(useMailStore.getState().threads, '', useMailStore.getState().activeThread), null);

  // A slow response from the old account must not repopulate its thread after
  // the user has switched accounts and the new account has already loaded.
  const staleThreads = deferred<{ threads: MailThread[]; total: number; shared: boolean }>();
  const accountBThread: MailThread = { ...thread, threadKey: 'account-b-thread', ids: ['account-b-message'] };
  mailService.threads = async ({ accountId }) => accountId === 'account-a'
    ? staleThreads.promise
    : { threads: [accountBThread], total: 1, shared: false };
  mailService.folders = async (accountId) => ({ folders: [{ id: `${accountId}-inbox`, name: 'Входящие', kind: 'INBOX', unread: 0 } as any], shared: false });
  useMailStore.setState({ accountId: 'account-a', folderId: 'account-a-inbox', query: '', filter: 'all', threads: [thread], openKey: thread.threadKey, activeThread: thread });
  const oldAccountRequest = useMailStore.getState().loadThreads();
  await useMailStore.getState().chooseAccount('account-b');
  staleThreads.resolve({ threads: [thread], total: 1, shared: true });
  await oldAccountRequest;
  assert.equal(useMailStore.getState().accountId, 'account-b');
  assert.deepEqual(useMailStore.getState().threads.map((item) => item.threadKey), [accountBThread.threadKey],
    'a late response from the previous account must not replace the new account list');
  assert.equal(useMailStore.getState().activeThread, null, 'the previous account preview must not cross account boundaries');

  // Mutations may finish after an account switch; their responses must not
  // refresh the new account or write into its active thread snapshot.
  let folderReads = 0;
  const flagGate = deferred<{ ok: boolean; changed: number }>();
  mailService.flag = async () => flagGate.promise;
  mailService.folders = async (accountId) => {
    folderReads++;
    return { folders: [{ id: `${accountId}-inbox`, name: 'Входящие', kind: 'INBOX', unread: 0 } as any], shared: false };
  };
  mailService.threads = async () => ({ threads: [accountBThread], total: 1, shared: false });
  useMailStore.setState({ accountId: 'account-a', folderId: 'account-a-inbox', query: '', filter: 'all', threads: [thread], openKey: thread.threadKey, activeThread: thread });
  const oldSeenRequest = useMailStore.getState().markSeen(thread.ids, true);
  await useMailStore.getState().chooseAccount('account-b');
  const readsAfterSwitch = folderReads;
  const activeBThread = { ...accountBThread, state: emptyState };
  useMailStore.setState({ openKey: activeBThread.threadKey, activeThread: activeBThread });
  flagGate.resolve({ ok: true, changed: 1 });
  await oldSeenRequest;
  assert.equal(folderReads, readsAfterSwitch, 'a stale read response must not refresh folders for the new account');
  assert.equal(useMailStore.getState().activeThread?.threadKey, activeBThread.threadKey,
    'a stale read response must not alter the new account preview');

  const claimGate = deferred<{ state: MailThreadState }>();
  mailService.claim = async () => claimGate.promise;
  useMailStore.setState({ accountId: 'account-a', folderId: 'account-a-inbox', threads: [thread], openKey: thread.threadKey, activeThread: thread });
  const oldClaimRequest = useMailStore.getState().claim(thread.threadKey, true);
  await useMailStore.getState().chooseAccount('account-b');
  useMailStore.setState({ openKey: activeBThread.threadKey, activeThread: activeBThread });
  claimGate.resolve({ state: { ...emptyState, status: 'IN_PROGRESS', claimedById: 'old-account-user' } });
  await oldClaimRequest;
  assert.equal(useMailStore.getState().activeThread?.state?.claimedById, '',
    'a stale claim response must not write into another account thread snapshot');
  assert.equal(useMailStore.getState().threads.some((item) => item.threadKey === thread.threadKey), false,
    'a stale claim response must not insert an old account thread');

  console.log(JSON.stringify({ result: 'passed', suite: 'mail-open-unread-store', assertions: 14 }));
}

void main().finally(() => {
  mailService.flag = originalFlag;
  mailService.folders = originalFolders;
  mailService.threads = originalThreads;
  mailService.claim = originalClaim;
});
