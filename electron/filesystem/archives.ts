import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { path7z } from '7zip-bin-full';
import type { WindowsFilesRequest } from '../../filesystem/contracts';
import type { WindowsFilesService } from './service';
import { WindowsFilesError, validateWindowsName, joinRelative } from './paths';
import { inspectWindowsTree, copyWindowsTree } from './tree';
import { existingAt } from './publishing';
import { fingerprint } from './undo';

const runFile = promisify(execFile);

/** Архиватор читает проверенную копию дерева: junction, появившийся в исходной папке, не выводит его за capability. */
export async function createArchive(service: WindowsFilesService, request: Extract<WindowsFilesRequest, { action: 'archive' }>, binary = path7z) {
  validateWindowsName(request.name);
  if (!/\.zip$/iu.test(request.name)) throw new WindowsFilesError('INVALID_NAME', 'Имя архива должно заканчиваться на .zip.');
  if (!Array.isArray(request.refs) || !request.refs.length || request.refs.length > 100 || request.parent.draftId || request.refs.some(ref => ref.draftId)) throw new WindowsFilesError('INVALID_REQUEST', 'Выберите от 1 до 100 опубликованных объектов в папке Windows.');
  const parent = service.resolveRef(request.parent);
  const target = { rootId: parent.rootId, relativePath: joinRelative(parent.relativePath, request.name) };
  return service.locked(`archive:${target.rootId}:${target.relativePath}`, async () => {
    if (await existingAt(service, target) || service.draftsIn(parent).some(d => d.name.toLocaleLowerCase() === request.name.toLocaleLowerCase())) throw new WindowsFilesError('EEXIST', 'Архив с таким именем уже существует.');
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-archive-'));
    try {
      const input = path.join(folder, 'input'); await fs.mkdir(input);
      const names = new Set<string>();
      for (const ref of request.refs) {
        const source = await service.filename(ref); const name = path.basename(source); validateWindowsName(name);
        if (names.has(name.toLocaleLowerCase())) throw new WindowsFilesError('EEXIST', 'Для архива выбраны объекты с одинаковыми именами.');
        names.add(name.toLocaleLowerCase());
        const plan = await inspectWindowsTree(source);
        await copyWindowsTree(source, path.join(input, name), plan);
      }
      const archive = path.join(folder, 'result.zip');
      await runFile(binary, ['a', '-tzip', '-mx=5', '-y', archive, '--', ...await fs.readdir(input)], { cwd: input, windowsHide: true, timeout: 300_000, maxBuffer: 256 * 1024 });
      const filename = await service.filename(target, true);
      await fs.copyFile(archive, filename, constants.COPYFILE_EXCL);
      const file = await service.entry(target);
      await service.record(`Архив «${request.name}»`, { kind: 'create', at: target, fingerprint: await fingerprint(service, target) }, { group: request.group });
      service.changed(target); return { ref: target, file };
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  });
}
