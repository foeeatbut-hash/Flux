/**
 * Блокировка файлов, связанных со строками документооборота, в файловом мосте
 * (docs/docflow-program.md, 3.7): запись, замена, переименование, перенос, удаление
 * и открытие на правку над заблокированным файлом отклоняются, копирование и чтение
 * работают, папка с заблокированными файлами не переносится, замок снимается и
 * файлу возвращается запись. Настоящая файловая система во временной папке.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WindowsFilesService } from '../electron/filesystem/service';
import { LinkLocks, lockKeyOf } from '../electron/filesystem/linkLocks';
import { collectServerLocks } from '../electron/filesystem/lockSync';
import { EXPLORER_WRITE_ACTIONS, isExplorerAction } from '../electron/filesystem/explorerBridge';

let passed = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); passed++; console.log(`✓ ${message}`); };
const rejectsLocked = async (work: () => Promise<unknown>, message: string, action?: RegExp) => {
  await assert.rejects(work, (error: any) => error.code === 'LINK_LOCKED' && /заблокирован|заблокированные/.test(error.message) && (!action || action.test(error.message))); passed++; console.log(`✓ ${message}`);
};

async function main() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-link-locks-'));
  try {
    const desktop = path.join(sandbox, 'desktop'); const userData = path.join(sandbox, 'data');
    await fs.mkdir(path.join(desktop, 'E02'), { recursive: true });
    await fs.writeFile(path.join(desktop, 'E02', 'Locked.pdf'), 'original');
    await fs.writeFile(path.join(desktop, 'E02', 'Free.pdf'), 'free');
    const opened: string[] = []; const trashed: string[] = [];
    const service = await WindowsFilesService.create({ userData, knownFolders: { desktop }, trashItem: async (name: string) => { trashed.push(name); await fs.rm(name, { recursive: true }); },
      showItemInFolder: () => undefined, openPath: async (name: string) => { opened.push(name); return ''; } });
    const rootId = (await service.roots())[0].id;
    const locked = { rootId, relativePath: 'E02/Locked.pdf' }; const free = { rootId, relativePath: 'E02/Free.pdf' }; const folder = { rootId, relativePath: 'E02' };
    const sha = (await service.read(locked)).sha256;

    const keys = new LinkLocks();
    keys.replace([path.join(sandbox, 'A', 'f.pdf')]);
    check(keys.has(path.join(sandbox, 'A', '..', 'A', 'f.pdf')) && keys.inside(path.join(sandbox, 'A')) && !keys.inside(path.join(sandbox, 'AB')) && lockKeyOf('x') === lockKeyOf('./x'), 'ключ пути приводится к одному виду, папка с замком определяется точно');

    // До блокировки всё работает
    check((await service.write(free, Buffer.from('free2').toString('base64'), (await service.read(free)).sha256)).name === 'Free.pdf', 'свободный файл записывается');

    const result = await service.applyLinkLocks([locked]);
    check(result.locked === 1 && result.protectedFiles === 1, 'список замков принят, файлу поставлен атрибут «только чтение»');
    check(((await fs.stat(path.join(desktop, 'E02', 'Locked.pdf'))).mode & 0o222) === 0, 'атрибут «только чтение» виден на диске');

    await rejectsLocked(() => service.write(locked, Buffer.from('edited').toString('base64'), sha), 'запись в заблокированный файл отклонена');
    await rejectsLocked(() => service.replaceFromFile(locked, path.join(desktop, 'E02', 'Free.pdf'), sha), 'замена заблокированного файла отклонена');
    await rejectsLocked(() => service.rename(locked, 'Renamed.pdf'), 'переименование отклонено, причина названа', /переименовать/);
    await rejectsLocked(() => service.move(locked, { rootId, relativePath: '' }, 'Locked.pdf'), 'перенос и перетаскивание отклонены');
    await rejectsLocked(() => service.trash(locked), 'удаление в корзину отклонено');
    await rejectsLocked(() => service.permanentDelete(locked), 'безвозвратное удаление отклонено');
    await rejectsLocked(() => service.open(locked), 'открытие во внешней программе (на правку) отклонено');
    await rejectsLocked(() => service.startDrag(1, [locked]), 'перетаскивание наружу отклонено');
    await rejectsLocked(() => service.assertNotLinkLocked(locked, 'вырезать'), 'вырезание проверяется той же проверкой');
    await rejectsLocked(() => service.rename(folder, 'E03'), 'папка с заблокированным файлом не переименовывается');
    await rejectsLocked(() => service.trash(folder), 'папка с заблокированным файлом не удаляется');
    check(opened.length === 0 && trashed.length === 0, 'ни одна внешняя программа и корзина не запущены');
    check((await fs.readFile(path.join(desktop, 'E02', 'Locked.pdf'), 'utf8')) === 'original', 'содержимое файла не изменилось');

    // Что остаётся доступным
    check((await service.read(locked)).sha256 === sha && (await service.fileHash(locked)).sha256 === sha, 'чтение и отпечаток работают');
    const copy = await service.copy(locked, folder, 'Copy.pdf');
    check(copy.file.name === 'Copy.pdf' && (await fs.readFile(path.join(desktop, 'E02', 'Copy.pdf'), 'utf8')) === 'original', 'копирование как нового файла разрешено');
    check((await service.rename(free, 'Free2.pdf')).file.name === 'Free2.pdf', 'другие файлы папки переименовываются свободно');
    check((await service.rename({ rootId, relativePath: 'E02/Copy.pdf' }, 'Copy2.pdf')).file.name === 'Copy2.pdf', 'копия заблокированного файла — обычный файл');

    // Новый список снимает замок и возвращает запись
    const freed = await service.applyLinkLocks([]);
    check(freed.locked === 0 && freed.released === 1, 'пустой список снимает замок и «только чтение»');
    check(((await fs.stat(path.join(desktop, 'E02', 'Locked.pdf'))).mode & 0o200) !== 0, 'файл снова доступен для записи');
    check((await service.rename(locked, 'Renamed.pdf')).file.name === 'Renamed.pdf', 'снятый замок разрешает переименование');

    // Явное освобождение (отмена создания файла)
    await service.applyLinkLocks([{ rootId, relativePath: 'E02/Renamed.pdf' }]);
    await rejectsLocked(() => service.trash({ rootId, relativePath: 'E02/Renamed.pdf' }), 'после нового списка файл снова защищён');
    check((await service.releaseLinkLocks([{ rootId, relativePath: 'E02/Renamed.pdf' }])).released === 1 && (await service.trash({ rootId, relativePath: 'E02/Renamed.pdf' })).trashed === true, 'явное освобождение позволяет удалить файл');
    check((await service.applyLinkLocks([{ rootId, relativePath: 'E02/нет.pdf' }])).locked === 0, 'несуществующий файл в списке не ломает приём');

    // ── Прежний атрибут «только чтение» не сбрасывается ──
    const mine = path.join(desktop, 'E02', 'AlreadyReadOnly.pdf');
    await fs.writeFile(mine, 'ro'); await fs.chmod(mine, 0o444);
    const roRef = { rootId, relativePath: 'E02/AlreadyReadOnly.pdf' };
    await service.applyLinkLocks([roRef]);
    await service.applyLinkLocks([]);
    check(((await fs.stat(mine)).mode & 0o222) === 0, 'файл, который был «только чтение» до блокировки, остаётся таким после снятия замка');

    // ── Замок снят на другом компьютере или до перезапуска: атрибут уходит при ближайшей сверке ──
    const away = path.join(desktop, 'E02', 'Away.pdf');
    await fs.writeFile(away, 'away');
    const awayRef = { rootId, relativePath: 'E02/Away.pdf' };
    await service.applyLinkLocks([awayRef]);
    check(((await fs.stat(away)).mode & 0o222) === 0, 'новый замок ставит «только чтение»');
    const restarted = await WindowsFilesService.create({ userData, knownFolders: { desktop }, trashItem: async () => undefined, showItemInFolder: () => undefined, openPath: async () => '' });
    const restartedRoot = (await restarted.roots())[0].id;
    check((await restarted.applyLinkLocks([])).released === 1 && ((await fs.stat(away)).mode & 0o200) !== 0, 'после перезапуска список сервера без файла снимает «только чтение», поставленное прежним сеансом');
    void restartedRoot;

    // ── Список замков main берёт у сервера сам; страница его не диктует ──
    const asked: string[] = [];
    const serverJson = async (route: string) => {
      asked.push(route);
      if (route === '/api/explorer/project-bindings') return { bindings: [{ locationKey: 'k1', locator: { folderKey: 'k1', anchors: [] } }, { locationKey: 'k2' }] };
      return { links: [{ folderKey: 'k1', relativePath: 'E02/Locked.pdf' }, { folderKey: 'k2', relativePath: 'x.pdf' }, { folderKey: 'k3', relativePath: 'y.pdf' }, { relativePath: 'bad' }] };
    };
    const found = await collectServerLocks({ serverJson, resolveFolder: async () => ({ rootId: 'r', relativePath: 'Проекты' }) });
    check(asked.includes('/api/docflow/locks') && asked.includes('/api/explorer/project-bindings'), 'main запрашивает у сервера привязки и замки сам');
    check(found.length === 1 && found[0].rootId === 'r' && found[0].relativePath === 'Проекты/E02/Locked.pdf', 'путь собирается из привязанной папки на этом компьютере; папки без привязки и мусор пропускаются');
    check((await collectServerLocks({ serverJson: async () => ({}), resolveFolder: async () => null })).length === 0, 'пустой ответ сервера — пустой список');

    // ── Команды замков — записывающие: без права записи недоступны ──
    check(EXPLORER_WRITE_ACTIONS.has('syncLinkLocks') && EXPLORER_WRITE_ACTIONS.has('releaseLinkLocks') && isExplorerAction('syncLinkLocks'), 'syncLinkLocks и releaseLinkLocks требуют права записи, а не читают');
  } finally { await fs.rm(sandbox, { recursive: true, force: true }); }
  console.log(`windows-files-link-locks: ${passed} проверок прошли`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
