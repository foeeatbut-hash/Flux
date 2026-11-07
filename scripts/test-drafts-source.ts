import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsFilesService } from '../electron/filesystem/service';
import { listDrafts, unpublishedDrafts } from '../electron/filesystem/draftIndex';

let completed = false;
process.on('beforeExit', () => {
  if (!completed) { console.error('Тест источника черновиков не завершился'); process.exitCode = 1; }
});

async function main() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-drafts-source-'));
  let service: WindowsFilesService | undefined;
  try {
    const desktop = path.join(sandbox, 'desktop');
    await fs.mkdir(desktop);
    await fs.mkdir(path.join(desktop, 'Проект'));
    service = await WindowsFilesService.create({
      userData: path.join(sandbox, 'data'), knownFolders: { desktop },
      trashItem: async () => {}, showItemInFolder: () => {}, openPath: async () => '',
    });
    const rootId = (await service.roots())[0].id;
    const parent = { rootId, relativePath: 'Проект' };
    const content = Buffer.from('содержимое').toString('base64');
    const first = await service.createDraft(parent, 'Первый.txt', content);
    const second = await service.createDraft(parent, 'Второй.txt', content);
    const third = await service.createDraft(parent, 'Третий.txt', content);
    const removed = await service.createDraft(parent, 'Удалённый.txt', content);
    const published = await service.createDraft(parent, 'Опубликованный.txt', content);
    await service.trash(removed.ref);
    await service.publishDraft(published.ref);
    const registry = service.state.data.drafts;
    assert.equal(registry[removed.ref.draftId!].trashed, true);
    assert.ok(registry[published.ref.draftId!].publishedRef);
    console.log('✓ Реестр сохраняет удалённый и опубликованный черновики');

    const expected = [first, second, third].map(item => item.ref.draftId!).sort();
    const active = unpublishedDrafts(service);
    assert.deepEqual(active.map(item => item.id).sort(), expected);
    console.log('✓ Источник исключает удалённые и опубликованные записи');

    const all = await listDrafts(service);
    assert.deepEqual(all.entries.map(item => item.draftId).sort(), expected);
    assert.equal(all.total, 3);
    assert.equal(all.unreadableCount, 0);
    assert.equal(all.nextOffset, null);
    for (const entry of all.entries) {
      assert.equal(entry.rootId, rootId);
      assert.deepEqual(entry.parent, parent);
    }
    console.log('✓ Список возвращает те же записи и их родительские пути');

    const page1 = await listDrafts(service, 0, 2);
    assert.equal(page1.total, 3);
    assert.equal(page1.entries.length, 2);
    assert.equal(page1.nextOffset, 2);
    const page2 = await listDrafts(service, page1.nextOffset!, 2);
    assert.equal(page2.total, 3);
    assert.equal(page2.entries.length, 1);
    assert.equal(page2.nextOffset, null);
    assert.deepEqual([...page1.entries, ...page2.entries].map(item => item.draftId).sort(), expected);
    console.log('✓ Страницы покрывают все записи без повторов');

    const renamed = await service.rename(first.ref, 'Переименованный.txt');
    const fresh = await listDrafts(service);
    const changed = fresh.entries.find(item => item.draftId === first.ref.draftId)!;
    assert.equal(changed.name, 'Переименованный.txt');
    assert.equal(changed.relativePath, 'Проект/Переименованный.txt');
    assert.equal('metadata' in changed, false, 'удалённые свойства не возвращаются в источник черновиков');
    console.log('✓ Переименование видно при следующем запросе без локальных свойств');

    assert.ok(service.state.data.metadata[changed.fileId].history.length > 0);
    assert.equal('history' in changed, false);
    console.log('✓ История не передаётся в списке');

    const folder = await service.createDraftFolder(parent, 'Папка');
    const nested = await service.createDraft(folder.ref, 'Вложенный.txt', content);
    assert.ok(unpublishedDrafts(service).some(item => item.id === nested.ref.draftId));
    await service.trash(folder.ref);
    assert.ok(!unpublishedDrafts(service).some(item => item.id === nested.ref.draftId || item.id === folder.ref.draftId), 'содержимое папки в корзине не считается живым черновиком');
    assert.ok(!(await listDrafts(service)).entries.some(item => item.draftId === nested.ref.draftId));
    console.log('✓ Содержимое папки-черновика в корзине не попадает в источник');

    const originalEntry = service.entry.bind(service);
    (service as any).entry = async (ref: any, allowLink?: boolean) => {
      if (ref.draftId === second.ref.draftId) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return originalEntry(ref, allowLink);
    };
    try {
      const partial = await listDrafts(service);
      assert.equal(partial.unreadableCount, 1);
      assert.deepEqual(partial.entries.map(item => item.draftId).sort(), [first.ref.draftId!, third.ref.draftId!].sort());
      console.log('✓ Недоступная запись учитывается, доступные остаются в списке');
    } finally { delete (service as any).entry; }
  } finally {
    service?.close();
    await fs.rm(sandbox, { recursive: true, force: true });
  }
}

main().then(() => { completed = true; console.log('DRAFTS SOURCE PASSED'); }).catch(error => { completed = true; console.error(error); process.exitCode = 1; });
