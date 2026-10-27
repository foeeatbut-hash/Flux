/** Уборка временных папок загрузки обновления: только свои, только старше суток, не та, из которой работает процесс. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanStaleUpdateFolders, removeUpdateFolder, STALE_UPDATE_FOLDER_MS } from '../electron/updateTemp';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-update-temp-fixture-'));
const day = STALE_UPDATE_FOLDER_MS;
const make = (name: string, ageMs: number, withFile = true) => {
  const dir = path.join(temp, name); fs.mkdirSync(dir);
  if (withFile) fs.writeFileSync(path.join(dir, 'Flux-2.0.0.exe'), 'MZ');
  const at = new Date(Date.now() - ageMs); fs.utimesSync(dir, at, at); return dir;
};
let checks = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); checks++; };
(async () => {
  const old = make('flux-update-AbC123', day + 3600000), fresh = make('flux-update-Zz9Yy8', 3600000);
  const running = make('flux-update-Run111', 10 * day), foreign = make('other-folder', 10 * day), lookalike = make('flux-update-x y', 10 * day);
  const notDirectory = path.join(temp, 'flux-update-File01'); fs.writeFileSync(notDirectory, 'x'); fs.utimesSync(notDirectory, new Date(0), new Date(0));
  const removed = await cleanStaleUpdateFolders(temp, [path.join(running, 'Flux-2.0.0.exe')]);
  ok('старая папка загрузки убрана', !fs.existsSync(old) && removed.length === 1);
  ok('свежая папка остаётся: из неё может работать помощник подмены', fs.existsSync(fresh));
  ok('папка, из которой запущен процесс, остаётся при любом возрасте', fs.existsSync(running));
  ok('чужие папки и файлы не трогаются', fs.existsSync(foreign) && fs.existsSync(lookalike) && fs.existsSync(notDirectory));
  ok('несуществующий каталог не роняет уборку', (await cleanStaleUpdateFolders(path.join(temp, 'нет'), [])).length === 0);

  ok('прежняя загрузка убирается по имени', await removeUpdateFolder(fresh, temp) && !fs.existsSync(fresh));
  ok('чужая папка по этому пути не удаляется', !(await removeUpdateFolder(foreign, temp)) && fs.existsSync(foreign));
  ok('папка вне временного каталога не удаляется', !(await removeUpdateFolder(path.join(temp, 'flux-update-Run111', '..', '..', 'flux-update-Zz9Yy8'), temp)));
  ok('пустое имя не удаляет ничего', !(await removeUpdateFolder('', temp)) && fs.existsSync(running));
  console.log(`${checks} проверок уборки временных папок обновления пройдено, 0 провалено`);
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
