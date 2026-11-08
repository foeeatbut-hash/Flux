import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsFilesService } from '../electron/filesystem/service';
import type { WindowsFilesRequest } from '../filesystem/contracts';
import type { CreateFileRow, FileCreatePlan } from '../src/lib/docflowCreateApi';
import { openCreateRow, prepareCreateFiles, prepareUndoCreateFiles, publishCreateFiles, removeCreatedFiles } from '../src/lib/docflowCreateDisk';

async function main() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-docflow-create-disk-'));
  const desktop = path.join(sandbox, 'desktop');
  const work = path.join(desktop, 'Проект');
  await fs.mkdir(work, { recursive: true });
  const opened: string[] = [];
  const service = await WindowsFilesService.create({
    userData: path.join(sandbox, 'data'), knownFolders: { desktop },
    trashItem: async filename => { await fs.rename(filename, `${filename}.trash-test`); },
    showItemInFolder: () => undefined,
    openPath: async filename => { opened.push(filename); return ''; },
  });
  try {
    const rootId = (await service.roots())[0].id;
    const calls: WindowsFilesRequest[] = [];
    (globalThis as any).window = { electron: { windowsFiles: {
      invoke: async (request: WindowsFilesRequest) => {
        calls.push(request);
        try {
          let data: unknown;
          switch (request.action) {
            case 'resolvePortableFolder': data = { rootId, relativePath: 'Проект' }; break;
            case 'resolveAddress': data = request.text === 'C:\\Шаблон.docx' ? { rootId, relativePath: 'Проект/Шаблон.docx' } : null; break;
            case 'stat': data = await service.entry(request.ref); break;
            case 'fileHash': data = await service.fileHash(request.ref); break;
            case 'read': data = await service.read(request.ref); break;
            case 'list': data = await service.list(request.ref, request.offset, request.limit); break;
            case 'mkdir': data = await service.mkdir(request.parent, request.name); break;
            case 'publish': data = await service.publish(request.parent, request.name, request.base64, request.draftId); break;
            case 'trash': data = await service.trash(request.ref, request.baseSha256); break;
            case 'open': data = await service.open(request.ref); break;
            default: throw new Error(`Неожиданный вызов файлового моста: ${request.action}`);
          }
          return { ok: true, data };
        } catch (error: any) { return { ok: false, error: { code: error.code || 'ERROR', message: error.message } }; }
      },
    } } };

    const binding = { id: 'binding', locationKey: 'work-key', projectId: 'project-1', label: 'Проект', actorId: 'admin', at: '', locator: { folderKey: 'work-key', anchors: [] } };
    const row = (itemId: string, name: string, template = ''): CreateFileRow => ({ itemId, revision: 'A', fileName: name, relativePath: name, folderKey: 'work-key', template, format: name.split('.').at(-1)!, action: 'create', link: null, binding });
    const plan = (id: string, rows: CreateFileRow[]): FileCreatePlan => ({ id, projectId: 'project-1', rows, workBinding: binding, expiresAt: '' });
    const exists = async (name: string) => fs.stat(path.join(work, name)).then(() => true, () => false);
    const mark = (label: string) => console.log(`✓ ${label}`);

    const first = plan('empty', [row('1', 'Пустой.docx')]);
    const empty = await prepareCreateFiles(first);
    assert.equal(await exists('Пустой.docx'), false);
    assert.equal(Buffer.from(empty[0].base64, 'base64').subarray(0, 2).toString(), 'PK');
    await publishCreateFiles(first, empty);
    const original = await fs.readFile(path.join(work, 'Пустой.docx'));
    assert.deepEqual(original, Buffer.from(empty[0].base64, 'base64'));
    await publishCreateFiles(first, empty);
    assert.deepEqual(await fs.readFile(path.join(work, 'Пустой.docx')), original);
    assert.equal((await fs.readdir(work)).filter(name => name === 'Пустой.docx').length, 1);
    const recovered = await prepareUndoCreateFiles(first, [{ itemId: '1', sha256: empty[0].sha256, size: empty[0].size }]);
    assert.equal(recovered[0].base64, '');
    await removeCreatedFiles(first, recovered);
    assert.equal(await exists('Пустой.docx'), false);
    mark('Пустой файл, идемпотентный повтор и отмена после восстановления');

    await fs.writeFile(path.join(work, 'Шаблон.docx'), 'исходные байты шаблона');
    const template = plan('template', [row('2', 'Копия.docx', 'Шаблон.docx')]);
    const copy = await prepareCreateFiles(template);
    assert.equal(await exists('Копия.docx'), false);
    await publishCreateFiles(template, copy);
    assert.deepEqual(await fs.readFile(path.join(work, 'Копия.docx')), await fs.readFile(path.join(work, 'Шаблон.docx')));
    const absolute = plan('absolute', [row('3', 'Абсолютный.docx', 'C:\\Шаблон.docx')]);
    await publishCreateFiles(absolute, await prepareCreateFiles(absolute));
    assert.deepEqual(await fs.readFile(path.join(work, 'Абсолютный.docx')), await fs.readFile(path.join(work, 'Шаблон.docx')));
    await assert.rejects(() => prepareCreateFiles(plan('escape', [row('4', 'Выход.docx', '../Шаблон.docx')])));
    mark('Относительный и абсолютный шаблоны копируются точно; выход из папки запрещён');

    await fs.writeFile(path.join(work, 'Занят.txt'), 'чужой файл');
    await assert.rejects(() => prepareCreateFiles(plan('occupied', [row('5', 'Занят.txt')])));
    assert.equal(await fs.readFile(path.join(work, 'Занят.txt'), 'utf8'), 'чужой файл');
    const racePlan = plan('race', [row('6', 'Гонка.txt')]);
    const race = await prepareCreateFiles(racePlan);
    await fs.writeFile(path.join(work, 'Гонка.txt'), 'чужая запись');
    await assert.rejects(() => publishCreateFiles(racePlan, race));
    assert.equal(await fs.readFile(path.join(work, 'Гонка.txt'), 'utf8'), 'чужая запись');
    mark('Занятое имя и гонка после подготовки не перезаписывают файл');

    const changed = plan('changed', [row('7', 'Первый.txt'), row('8', 'Второй.docx', 'Шаблон.docx')]);
    const changedFiles = await prepareCreateFiles(changed);
    await fs.writeFile(path.join(work, 'Шаблон.docx'), 'шаблон изменён');
    await assert.rejects(() => publishCreateFiles(changed, changedFiles));
    assert.equal(await exists('Первый.txt'), false);
    assert.equal(await exists('Второй.docx'), false);
    const blocked = plan('blocked', [row('12', 'Свободный.txt'), row('13', 'Занят.txt')]);
    await assert.rejects(() => prepareCreateFiles(blocked));
    assert.equal(await exists('Свободный.txt'), false);
    mark('Изменённый шаблон и занятое имя останавливают пакет до записи');

    const pair = plan('pair', [row('9', 'Удалить-1.txt'), row('10', 'Удалить-2.txt')]);
    const pairFiles = await prepareCreateFiles(pair);
    await publishCreateFiles(pair, pairFiles);
    await fs.writeFile(path.join(work, 'Удалить-2.txt'), 'новые правки');
    await assert.rejects(() => removeCreatedFiles(pair, pairFiles));
    assert.equal(await exists('Удалить-1.txt'), true);
    assert.equal(await fs.readFile(path.join(work, 'Удалить-2.txt'), 'utf8'), 'новые правки');
    await assert.rejects(() => prepareUndoCreateFiles(pair, pairFiles.map(file => ({ itemId: file.row.itemId, sha256: file.sha256, size: file.size }))));
    mark('Изменённый файл блокирует удаление пакета и восстановление отмены');

    const openRow = { ...row('11', 'Занят.txt'), action: 'open', link: { folderKey: 'work-key', relativePath: 'Занят.txt' } } as CreateFileRow;
    const openPlan = plan('open', [openRow]);
    const start = calls.length;
    assert.deepEqual(await prepareCreateFiles(openPlan), []);
    await openCreateRow(openRow);
    assert.equal(opened.length, 1);
    assert.equal(calls.slice(start).some(call => call.action === 'publish'), false);
    assert.equal(await fs.readFile(path.join(work, 'Занят.txt'), 'utf8'), 'чужой файл');
    mark('Связанный документ открывается без создания нового файла');
  } finally {
    service.close();
    delete (globalThis as any).window;
    await fs.rm(sandbox, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
