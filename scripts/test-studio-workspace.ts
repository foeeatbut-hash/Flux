/**
 * Проект-папка в Studio: безопасные пути, правила исключения, слежение за изменениями снаружи, перенос прежних черновиков.
 *
 * Что доказывается (каждая проверка падает при мутации соответствующей защиты):
 * - выход за папку: `..`, абсолютный путь, обратная косая, ссылка и junction наружу, ссылка-файл — отвергаются;
 * - служебные каталоги (.git, node_modules) не открываются, сборочные и .fluxignore не попадают в пакет, пределы размера и числа файлов;
 * - добавление, правка, удаление и переименование снаружи видны через FolderWatcher (опрос — запасной путь без fs.watch);
 * - правка снаружи при несохранённой правке даёт вопрос, а не тихую потерю (reconcile);
 * - «Открыть папку как проект» читает manifest.json; удаление из списка не удаляет папку; прежний черновик переносится копией.
 *
 * Запуск: npx tsx scripts/test-studio-workspace.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Drafts, DraftFailure } from '../studio/shared/drafts';
import { reconcile } from '../studio/shared/conflict';
import { FolderWatcher, Workspace, WorkspaceFailure, parseIgnore } from '../studio/shared/workspace';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const throwsAs = (fn: () => unknown, kind: new (...a: any[]) => Error) => { try { fn(); return false; } catch (e) { return e instanceof kind; } };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-workspace-'));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const manifest = (id: string) => JSON.stringify({ id, name: `Программа ${id}`, version: '0.1.0', language: 'typescript' });

async function main() {
  console.log('Пути: выход за папку отвергается');
  const dir = path.join(temp, 'proj'), outside = path.join(temp, 'outside');
  fs.mkdirSync(dir); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'секрет');
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifest('demo'));
  const space = new Workspace(dir);
  for (const bad of ['../outside/secret.txt', 'a/../../x.txt', '/etc/passwd', 'C:/Windows/x.txt', 'a\\b.txt', '', 'a/./b.txt', 'a/b\0.txt', '.git/config', 'node_modules/x/index.js']) {
    ok(`отвергнут путь «${bad.replace('\0', '\\0')}»`, throwsAs(() => space.resolve(bad), WorkspaceFailure));
  }
  let linked = true;
  try { fs.symlinkSync(outside, path.join(dir, 'link'), 'junction'); fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'secret-link.txt')); } catch { linked = false; }
  if (linked) {
    ok('каталог-ссылка (junction) наружу не пройдёт на чтение', throwsAs(() => space.read('link/secret.txt'), WorkspaceFailure));
    ok('запись через ссылку наружу не пройдёт', throwsAs(() => space.write('link/new.txt', 'x'), WorkspaceFailure) && !fs.existsSync(path.join(outside, 'new.txt')));
    ok('файл-ссылка не открывается', throwsAs(() => space.read('secret-link.txt'), WorkspaceFailure));
    ok('ссылки не попадают ни в дерево, ни в пакет', !space.tree().some(e => e.path.startsWith('link') || e.path === 'secret-link.txt') && !('secret-link.txt' in space.pack()));
  } else console.log('  (ссылки в этой среде не создаются: проверки ссылок пропущены)');

  console.log('Правила исключения и пределы');
  fs.mkdirSync(path.join(dir, 'node_modules/x'), { recursive: true }); fs.writeFileSync(path.join(dir, 'node_modules/x/i.js'), '1');
  fs.mkdirSync(path.join(dir, '.git')); fs.writeFileSync(path.join(dir, '.git/HEAD'), 'ref');
  fs.mkdirSync(path.join(dir, 'build')); fs.writeFileSync(path.join(dir, 'build/runtime.js'), '1');
  fs.mkdirSync(path.join(dir, 'dist')); fs.writeFileSync(path.join(dir, 'dist/a.js'), '1');
  fs.writeFileSync(path.join(dir, 'notes.log'), 'x'); fs.writeFileSync(path.join(dir, 'Thumbs.db'), 'x');
  fs.mkdirSync(path.join(dir, 'drafts')); fs.writeFileSync(path.join(dir, 'drafts/old.txt'), 'x'); fs.writeFileSync(path.join(dir, 'secret.key'), 'x');
  fs.writeFileSync(path.join(dir, '.fluxignore'), '# мои правила\ndrafts/\n*.key\n');
  fs.mkdirSync(path.join(dir, 'ui')); fs.writeFileSync(path.join(dir, 'ui/index.html'), '<p>hi</p>');
  const packed = Object.keys(space.pack());
  ok('в пакете только нужное', packed.sort().join() === 'manifest.json,ui/index.html');
  ok('.git и node_modules не видны в дереве', !space.tree().some(e => /^(\.git|node_modules)/.test(e.path)));
  ok('исключённое помечено в дереве', space.tree().find(e => e.path === 'drafts/old.txt')?.ignored === true && space.tree().find(e => e.path === 'ui/index.html')?.ignored === false);
  ok('разбор .fluxignore', parseIgnore('*.key\nbuild/\n#c\n').length === 2);
  fs.writeFileSync(path.join(dir, 'ui/big.bin'), Buffer.alloc(33 * 1024 * 1024));
  ok('предел размера пакета', throwsAs(() => space.pack(), WorkspaceFailure));
  fs.rmSync(path.join(dir, 'ui/big.bin'));
  fs.mkdirSync(path.join(dir, 'many'));
  for (let i = 0; i < 401; i++) fs.writeFileSync(path.join(dir, 'many', `f${i}.txt`), 'x');
  ok('предел числа файлов пакета', throwsAs(() => space.pack(), WorkspaceFailure));
  fs.rmSync(path.join(dir, 'many'), { recursive: true });

  console.log('Слежение: изменения снаружи');
  const seen: string[] = [];
  const watcher = new FolderWatcher(space, changes => seen.push(...changes.map(c => `${c.kind}:${c.path}`)), 50);
  fs.writeFileSync(path.join(dir, 'ui/new.js'), '1');
  ok('добавление снаружи (опрос)', watcher.scan().some(c => c.kind === 'added' && c.path === 'ui/new.js'));
  await sleep(20); fs.writeFileSync(path.join(dir, 'ui/new.js'), '12345');
  ok('правка снаружи', watcher.scan().some(c => c.kind === 'changed' && c.path === 'ui/new.js'));
  fs.renameSync(path.join(dir, 'ui/new.js'), path.join(dir, 'ui/moved.js'));
  const renamed = watcher.scan();
  ok('переименование снаружи = удаление и добавление', renamed.some(c => c.kind === 'removed' && c.path === 'ui/new.js') && renamed.some(c => c.kind === 'added' && c.path === 'ui/moved.js'));
  fs.rmSync(path.join(dir, 'ui/moved.js'));
  ok('удаление снаружи', watcher.scan().some(c => c.kind === 'removed' && c.path === 'ui/moved.js'));
  ok('изменение в .git не шумит', (() => { fs.writeFileSync(path.join(dir, '.git/HEAD'), 'ref2'); return watcher.scan().length === 0; })());
  watcher.start();
  seen.length = 0;
  fs.writeFileSync(path.join(dir, 'ui/auto.js'), '1');
  for (let i = 0; i < 60 && !seen.some(x => x === 'added:ui/auto.js'); i++) await sleep(50);
  ok('само по таймеру/событию без ручной проверки', seen.includes('added:ui/auto.js'));
  watcher.stop();

  console.log('Несохранённые правки и внешние изменения');
  ok('диск не менялся — ничего', reconcile('a', 'b', 'a') === 'same');
  ok('своих правок нет — тихо перечитать', reconcile('a', 'a', 'c') === 'reload');
  ok('несохранённое и диск изменился — вопрос', reconcile('a', 'b', 'c') === 'ask');
  ok('файл удалён снаружи', reconcile('a', 'b', null) === 'removed');

  console.log('Проекты: открыть папку, удалить из списка, перенос прежних черновиков');
  const data = path.join(temp, 'data'), home = path.join(temp, 'home');
  const drafts = new Drafts(data, home);
  const opened = drafts.openFolder(dir);
  ok('папка открыта как проект по manifest.json', opened.id === 'demo' && opened.fresh && drafts.list()[0].folder === fs.realpathSync(dir));
  ok('повторное открытие той же папки — тот же проект', !drafts.openFolder(dir).fresh);
  const second = path.join(temp, 'proj2'); fs.mkdirSync(second); fs.writeFileSync(path.join(second, 'manifest.json'), manifest('demo'));
  ok('тот же идентификатор из другой папки отвергнут понятно', throwsAs(() => drafts.openFolder(second), DraftFailure));
  const empty = path.join(temp, 'empty'); fs.mkdirSync(empty);
  ok('в папке без manifest.json — понятный отказ', throwsAs(() => drafts.openFolder(empty), DraftFailure));
  drafts.writeFile('demo', 'ui/saved.js', 'console.log(1)');
  ok('сохранение из Studio — сразу файл в папке', fs.readFileSync(path.join(dir, 'ui/saved.js'), 'utf8') === 'console.log(1)');
  drafts.makeDir('demo', 'sub/deep'); drafts.rename('demo', 'ui/saved.js', 'sub/deep/saved.js');
  ok('папка создана, файл перенесён', fs.existsSync(path.join(dir, 'sub/deep/saved.js')) && !fs.existsSync(path.join(dir, 'ui/saved.js')));
  ok('перенос поверх существующего отвергнут', throwsAs(() => drafts.rename('demo', 'sub/deep/saved.js', 'manifest.json'), DraftFailure));
  ok('manifest.json не переименовать и не удалить', throwsAs(() => drafts.rename('demo', 'manifest.json', 'x.json'), DraftFailure) && throwsAs(() => drafts.deleteFile('demo', 'manifest.json'), DraftFailure));
  ok('папка с содержимым удаляется целиком', (() => { drafts.deleteFile('demo', 'sub'); return !fs.existsSync(path.join(dir, 'sub')); })());
  ok('поиск по проекту', drafts.search('demo', 'Программа').some(h => h.path === 'manifest.json' && h.line === 1));
  ok('в папку с файлами новый проект не создаётся', throwsAs(() => drafts.create('other', {}, { template: 'x' }, dir), DraftFailure));
  drafts.remove('demo');
  ok('удаление из списка не трогает папку пользователя', fs.existsSync(path.join(dir, 'manifest.json')) && drafts.list().length === 0);

  const legacy = path.join(data, 'drafts', 'old-one', 'project');
  fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, 'manifest.json'), manifest('old-one'));
  fs.writeFileSync(path.join(data, 'drafts', 'old-one', 'state.json'), JSON.stringify({ parentRequest: null, baseRelease: null, changelog: 'x', comment: '', channel: 'test', template: 'typescript', createdAt: 1, updatedAt: 2 }));
  ok('прежний черновик открывается как раньше', drafts.list()[0]?.id === 'old-one' && Object.keys(drafts.files('old-one')).join() === 'manifest.json');
  const moved = drafts.migrate();
  ok('перенос копией в папку', moved.join() === 'old-one' && fs.existsSync(path.join(home, 'old-one/manifest.json')) && fs.existsSync(path.join(legacy, 'manifest.json')));
  ok('после переноса проект живёт в новой папке, состояние цело', drafts.list()[0].folder === fs.realpathSync(path.join(home, 'old-one')) && drafts.state('old-one').changelog === 'x');
  ok('повторный перенос ничего не делает', drafts.migrate().length === 0);

  fs.rmSync(temp, { recursive: true, force: true });
  console.log(`\nStudio: проект-папка — ${passed} проверок пройдено`);
}
main().catch(e => { console.error(e); fs.rmSync(temp, { recursive: true, force: true }); process.exit(1); });
