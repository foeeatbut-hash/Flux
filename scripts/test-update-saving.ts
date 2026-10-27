import assert from 'node:assert/strict';
import { guardClose, clearGuards } from '../src/lib/closeGuard';
import { useUpdateStore } from '../src/store/updateStore';
async function run() {
  let quits = 0;
  (globalThis as any).window = { electron: { quitAndInstall: async () => { quits++; return { success: true }; } } };
  const ready = () => useUpdateStore.setState({ phase: 'ready', current: '1.0.0', latest: { version: '2.0.0', signature: 'test', changelog: '', fileUrl: '/api/updates/download/2.0.0' }, error: '' });
  try {
    ready();
    guardClose('document', () => false);
    await useUpdateStore.getState().install('campaign');
    assert.equal(quits, 0);
    assert.equal(useUpdateStore.getState().phase, 'ready');
    assert.match(useUpdateStore.getState().error, /сохранить/);
    clearGuards(); ready();
    guardClose('document', () => { throw Error('write failed'); });
    await useUpdateStore.getState().install('campaign');
    assert.equal(quits, 0);
    assert.equal(useUpdateStore.getState().phase, 'ready');
    clearGuards(); ready();
    guardClose('document', async () => true);
    await useUpdateStore.getState().install('campaign');
    assert.equal(quits, 1);
    assert.equal(useUpdateStore.getState().phase, 'installing');
    clearGuards(); ready();
    let downloads = 0, attempts = 0;
    (globalThis as any).window.location = { origin: 'http://localhost:3000' };
    (globalThis as any).window.electron = {
      startDownload: async () => { downloads++; },
      quitAndInstall: async () => ++attempts === 1 ? { success: false, error: 'Проверка публикации временно недоступна' } : { success: true },
    };
    useUpdateStore.setState({ packaged: true, portable: true });
    await useUpdateStore.getState().install();
    assert.equal(useUpdateStore.getState().phase, 'failed');
    await useUpdateStore.getState().install();
    assert.equal(downloads, 1);
    assert.equal(attempts, 2);
    assert.equal(useUpdateStore.getState().phase, 'installing');
    // D2: отказ закрыть программу (несохранённая правка) не сбрасывает «файл готов»
    // и не отправляет кампанию качать ~150 МБ заново каждую минуту
    clearGuards(); ready(); downloads = 0; attempts = 0;
    (globalThis as any).window.electron.quitAndInstall = async () => ++attempts < 3
      ? { success: false, deferred: true, error: 'Обновление отложено: сохраните изменения в открытых окнах.' } : { success: true };
    await useUpdateStore.getState().install('campaign');
    assert.equal(useUpdateStore.getState().phase, 'ready');
    assert.match(useUpdateStore.getState().error, /отложено/);
    await useUpdateStore.getState().install('campaign');
    assert.equal(useUpdateStore.getState().phase, 'ready');
    assert.equal(await useUpdateStore.getState().prepare(), true);
    await useUpdateStore.getState().install('campaign');
    assert.equal(downloads, 0, 'после отложенной установки файл не скачивается заново');
    assert.equal(useUpdateStore.getState().phase, 'installing');
    console.log('17 проверок сохранения и повтора обновления пройдено, 0 провалено');
  } finally { clearGuards(); delete (globalThis as any).window; }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
