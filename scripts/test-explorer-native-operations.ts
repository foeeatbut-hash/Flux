import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { path7z } from '7zip-bin-full';
import { WindowsFilesService } from '../electron/filesystem/service';
import { replaceCopy } from '../electron/filesystem/replacementCopy';
import { createArchive } from '../electron/filesystem/archives';
import { undoLast, redoLast } from '../electron/filesystem/undo';
import { folderViewStorageKey } from '../src/components/files/useFolderView';
import { ViewStateStore } from '../electron/filesystem/viewState';

let passed = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); passed++; };
const runFile = promisify(execFile);

async function main() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-explorer-final-'));
  const root = path.join(sandbox, 'desktop'); const userData = path.join(sandbox, 'data'); const bin = path.join(sandbox, 'bin');
  await fs.mkdir(root); await fs.mkdir(bin);
  const moved = new Map<string, string>();
  const service = await WindowsFilesService.create({
    userData, knownFolders: { desktop: root }, showItemInFolder: () => undefined, openPath: async () => '',
    trashItem: async filename => { const target = path.join(bin, `object-${moved.size}`); await fs.rename(filename, target); moved.set(filename, target); },
    restoreFromTrash: async info => { const target = moved.get(info.path); assert.ok(target); await fs.rename(target, info.path); moved.delete(info.path); },
  });
  try {
    const rootId = (await service.roots())[0].id;
    const ref = (name: string) => ({ rootId, relativePath: name }); const parent = ref('');
    const write = (name: string, text: string) => fs.writeFile(path.join(root, name), text);
    const read = (name: string) => fs.readFile(path.join(root, name), 'utf8');
    await write('source.txt', 'новое содержимое'); await write('target.txt', 'старое содержимое');
    await service.setMetadata(ref('source.txt'), { tags: ['AHU-01'], projectIds: ['project'], revision: '2', responsible: 'Автор' });
    await service.setMetadata(ref('target.txt'), { tags: ['OLD'], projectIds: [], revision: '1', responsible: 'Редактор' });
    const old = await service.fileHash(ref('target.txt'));
    await replaceCopy(service, { action: 'replaceCopy', ref: ref('source.txt'), parent, name: 'target.txt', targetSha256: old.sha256, carryMeta: true }, 'copy-group');
    check('Замена записывает выбранную версию и сохраняет источник', await read('target.txt') === 'новое содержимое' && await read('source.txt') === 'новое содержимое');
    const copiedMeta = await service.metadata(ref('target.txt'));
    check('На копию переходят теги и проект, ревизия начинается заново', copiedMeta.tags.join() === 'AHU-01' && copiedMeta.projectIds.join() === 'project' && copiedMeta.revision === '');
    await undoLast(service);
    check('Отмена замены возвращает реальные прежние байты', await read('target.txt') === 'старое содержимое');
    check('Отмена замены возвращает прежние свойства', (await service.metadata(ref('target.txt'))).revision === '1');
    await redoLast(service);
    check('Повтор после отмены заново записывает выбранные байты', await read('target.txt') === 'новое содержимое');
    await write('target.txt', 'внешняя правка');
    await assert.rejects(() => undoLast(service), (e: any) => e.code === 'CONFLICT');
    check('Отмена не затирает внешнюю правку', await read('target.txt') === 'внешняя правка');
    await assert.rejects(() => replaceCopy(service, { action: 'replaceCopy', ref: ref('source.txt'), parent, name: 'target.txt', targetSha256: old.sha256 }), (e: any) => e.code === 'CONFLICT');
    check('Устаревший план замены сохраняет обе стороны', await read('target.txt') === 'внешняя правка' && await read('source.txt') === 'новое содержимое');

    await write('move-source.txt', 'перенос'); await write('move-target.txt', 'прежний файл');
    await replaceCopy(service, { action: 'replaceCopy', ref: ref('move-source.txt'), parent, name: 'move-target.txt', targetSha256: (await service.fileHash(ref('move-target.txt'))).sha256, move: true }, 'move-group');
    check('Перенос с заменой убирает источник после записи назначения', !await fs.stat(path.join(root, 'move-source.txt')).then(() => true).catch(() => false) && await read('move-target.txt') === 'перенос');
    await undoLast(service);
    check('Одно Ctrl+Z возвращает источник и прежнее назначение группы', await read('move-source.txt') === 'перенос' && await read('move-target.txt') === 'прежний файл');
    await redoLast(service);
    check('Повтор всей группы возвращает результат переноса', await read('move-target.txt') === 'перенос' && !await fs.stat(path.join(root, 'move-source.txt')).then(() => true).catch(() => false));

    await fs.mkdir(path.join(root, 'Folder')); await write('Folder/nested.txt', 'вложенный текст');
    const archive = await createArchive(service, { action: 'archive', refs: [ref('source.txt'), ref('Folder')], parent, name: 'Проверка.zip' });
    const extracted = path.join(sandbox, 'extracted');
    await runFile(path7z, ['x', path.join(root, 'Проверка.zip'), `-o${extracted}`, '-y']);
    check('ZIP открывается независимым архиватором с файлами и вложенными папками', await fs.readFile(path.join(extracted, 'source.txt'), 'utf8') === 'новое содержимое' && await fs.readFile(path.join(extracted, 'Folder', 'nested.txt'), 'utf8') === 'вложенный текст');
    await assert.rejects(() => createArchive(service, { action: 'archive', refs: [ref('source.txt')], parent, name: 'Проверка.zip' }), (e: any) => e.code === 'EEXIST');
    check('Архив с занятым именем остаётся прежней версии', (await service.entry(archive.ref)).size === archive.file.size);

    await write('.hidden.txt', 'скрыто');
    const entry = await service.entry(ref('.hidden.txt'));
    check('Сведения об объекте доступны без загрузки его страницы и содержимого', entry.name === '.hidden.txt' && !!entry.createdAt && entry.hidden === (process.platform !== 'win32'));
    await assert.rejects(() => service.permanentDelete(parent), (e: any) => e.code === 'ROOT_OPERATION');
    check('Shift+Delete не удаляет подключённый корень', (await fs.stat(root)).isDirectory());
    await service.permanentDelete(ref('.hidden.txt'));
    check('Shift+Delete удаляет файл без помещения в корзину', !await fs.stat(path.join(root, '.hidden.txt')).then(() => true).catch(() => false) && !moved.has(path.join(root, '.hidden.txt')));
    const draft = await service.createDraftFolder(parent, 'Черновая папка');
    const child = await service.createDraft(draft.ref, 'Локальный.txt', Buffer.from('черновик').toString('base64'));
    await service.trash(draft.ref); await service.purgeDraft(draft.ref);
    check('Очистка корзины черновиков удаляет поддерево и его локальные байты', !service.state.data.drafts[draft.ref.draftId!] && !service.state.data.drafts[child.ref.draftId!] && !await fs.stat(path.join(userData, 'windows-files-drafts', `${child.ref.draftId}.bin`)).then(() => true).catch(() => false));

    const largeSource = path.join(root, 'large.bin'); const largeTarget = path.join(root, 'large-target.bin');
    await fs.writeFile(largeSource, 'начало'); await fs.truncate(largeSource, 64 * 1024 * 1024 + 1); await fs.writeFile(largeTarget, 'раньше');
    await replaceCopy(service, { action: 'replaceCopy', ref: ref('large.bin'), parent, name: 'large-target.bin', targetSha256: (await service.fileHash(ref('large-target.bin'))).sha256 });
    check('Замена файла больше 64 МБ не использует лимит редактора', (await fs.stat(largeTarget)).size === 64 * 1024 * 1024 + 1 && (await service.fileHash(ref('large-target.bin'))).sha256 === (await service.fileHash(ref('large.bin'))).sha256);
    await undoLast(service);
    check('Потоковая отмена большого файла восстанавливает малый оригинал', await read('large-target.bin') === 'раньше');
    const store = await ViewStateStore.load(userData);
    for (const scope of [`${rootId}\0Папка\0`, 'длинный путь'.repeat(300)]) {
      const key = folderViewStorageKey(scope); await store.set({ [key]: { layout: 'large' } });
      const reopened = await ViewStateStore.load(userData);
      check('Вид сохраняется и повторно читается для разделителей и длинного пути', (reopened.get([key])[key] as any).layout === 'large');
    }
    console.log(`EXPLORER NATIVE OPERATIONS PASSED (${passed}) — реальная файловая система; корзина Windows подменена`);
  } finally { service.close(); await fs.rm(sandbox, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
