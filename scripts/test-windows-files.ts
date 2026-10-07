import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WindowsFilesService, hashWindowsBytes } from '../electron/filesystem/service';
import { inspectWindowsTree, copyWindowsTree, cleanCreatedWindowsTree } from '../electron/filesystem/tree';
import { resolveSafePath, validateWindowsName } from '../electron/filesystem/paths';
import { SearchRegistry, type SearchParams } from '../electron/filesystem/search';
import { listChildFolders } from '../electron/filesystem/children';
import { ViewStateStore } from '../electron/filesystem/viewState';
import { undoLast, redoLast } from '../electron/filesystem/undo';
import { planPublication } from '../electron/filesystem/publishing';
import { DropTickets, importDropped } from '../electron/filesystem/importPaths';
import type { WindowsSearchEvent, WindowsSearchHit } from '../filesystem/contracts';


let passed = 0;
function check(condition: unknown, message: string) { assert.ok(condition, message); passed++; console.log(`✓ ${message}`); }
async function rejects(work: () => Promise<unknown>, code: string, message: string) {
  await assert.rejects(work, (error: any) => error.code === code); passed++; console.log(`✓ ${message}`);
}
async function main() {
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-windows-files-test-'));
let service: WindowsFilesService;
try {
  const desktop = path.join(sandbox, 'desktop'); const userData = path.join(sandbox, 'flux-data'); const outside = path.join(sandbox, 'outside');
  await fs.mkdir(desktop); await fs.mkdir(outside); await fs.mkdir(path.join(desktop, 'Проект'));
  await fs.writeFile(path.join(outside, 'private.txt'), 'секрет вне корня');
  await fs.writeFile(path.join(desktop, 'Проект', 'Исходный.md'), 'оригинал');
  const notifications: any[] = []; const trashed: string[] = []; const revealed: string[] = []; const opened: string[] = [];
  const deps = { userData, knownFolders: { desktop }, trashItem: async (filename: string) => { trashed.push(filename); await fs.rename(filename, `${filename}.trash-test`); }, showItemInFolder: (filename: string) => { revealed.push(filename); }, openPath: async (filename: string) => { opened.push(filename); return ''; }, onChanged: (event: any) => notifications.push(event) };
  service = await WindowsFilesService.create(deps);
  const roots = await service.roots(); const rootId = roots[0].id;
  check(roots.length === 1 && roots[0].kind === 'desktop' && !('path' in roots[0]), 'Корень отдаёт capability без абсолютного пути');
  const project = { rootId, relativePath: 'Проект' }; const original = { rootId, relativePath: 'Проект/Исходный.md' };
  // Windows разворачивает короткое имя TEMP (RUNNER~1) в канонический путь.
  const canonicalDesktop = await fs.realpath(desktop);
  check(await service.iconPath(original) === path.join(canonicalDesktop, 'Проект', 'Исходный.md'), 'Системный значок получает только проверенный путь оригинала');
  check(await service.iconPath(project) === path.join(canonicalDesktop, 'Проект'), 'Папка тоже получает настоящий системный значок');
  await rejects(() => service.iconPath({ rootId: 'unknown', relativePath: '' }), 'UNKNOWN_ROOT', 'Запрос значка не выдаёт доступ к неизвестному корню');
  await rejects(() => service.iconPath({ rootId, relativePath: '../outside/private.txt' }), 'INVALID_NAME', 'Запрос значка не обходит границу подключённой папки');
  const listing = await service.list(project); check(listing.entries[0].name === 'Исходный.md', 'Перечисляются реальные файлы с кириллицей');
  const read = await service.read(original); check(Buffer.from(read.base64, 'base64').toString() === 'оригинал', 'Чтение возвращает настоящие байты');
  await rejects(() => service.read({ rootId: 'unknown', relativePath: '' }), 'UNKNOWN_ROOT', 'Произвольный корень отклонён');
  await rejects(() => service.read({ rootId, relativePath: '../outside/private.txt' }), 'INVALID_NAME', 'Выход через .. отклонён');
  await rejects(() => service.read({ rootId, relativePath: '/etc/passwd' }), 'INVALID_PATH', 'Абсолютный путь отклонён');
  await rejects(() => service.read({ rootId, relativePath: 'Проект/Исходный.md:stream' }), 'INVALID_NAME', 'NTFS alternate stream отклонён');
  await rejects(() => service.read({ rootId, relativePath: '\\\\server\\share' }), 'INVALID_PATH', 'Неподключённый UNC отклонён');
  for (const name of ['CON', 'con.txt', 'COM1.txt', 'LPT9', 'NUL', 'bad.', 'bad ', 'a/b', 'a\\b', 'a:b', '..', '', 'a\u0000b']) { assert.throws(() => validateWindowsName(name)); passed++; }
  await fs.symlink(outside, path.join(desktop, 'link'), 'junction');
  await rejects(() => service.iconPath({ rootId, relativePath: 'link/private.txt' }), 'LINK_BLOCKED', 'Получение значка тоже отклоняет внешний junction');
  await rejects(() => service.read({ rootId, relativePath: 'link/private.txt' }), 'LINK_BLOCKED', 'Junction не даёт читать внешний файл');
  check((await service.list({ rootId, relativePath: '' })).entries.some(item => item.kind === 'link' && item.name === 'link'), 'Ссылка показана без обхода содержимого');
  const update = Buffer.from('новая версия').toString('base64');
  const concurrent = await Promise.allSettled([service.write(original, update, read.sha256), service.write(original, Buffer.from('параллельная версия').toString('base64'), read.sha256)]);
  if (concurrent.filter(item => item.status === 'fulfilled').length !== 1) console.error('CAS outcomes:', JSON.stringify(concurrent.map(item => item.status === 'fulfilled' ? { status: item.status, sha256: item.value.sha256 } : { status: item.status, code: item.reason?.code, message: item.reason?.message, nativeDiagnostic: item.reason?.nativeDiagnostic })));
  check(concurrent.filter(item => item.status === 'fulfilled').length === 1, 'При двух CAS-сохранениях одной версии записывает только один');
  check(concurrent.some(item => item.status === 'rejected' && item.reason.code === 'CONFLICT'), 'Второе CAS-сохранение получает конфликт');
  const fresh = await service.read(original); check(fresh.fileId === read.fileId, 'Атомарное сохранение сохраняет стабильный идентификатор');
  await fs.writeFile(path.join(desktop, 'Проект', 'Исходный.md'), 'правки Word');
  await rejects(() => service.write(original, update, fresh.sha256), 'CONFLICT', 'Внешние изменения Word не перезаписываются');
  check(await fs.readFile(path.join(desktop, 'Проект', 'Исходный.md'), 'utf8') === 'правки Word', 'После конфликта внешний оригинал сохранён');
  const properties = await service.setMetadata(original, { tags: ['AHU1', 'AHU1'], projectIds: ['project1'], revision: 'B', responsible: 'Инженер' });
  check(properties.tags.length === 1, 'Свойства Flux хранятся отдельно и удаляют дубли тегов');
  const moved = await service.rename(original, 'Переименованный.md'); check((await service.metadata(moved.ref)).revision === 'B', 'Переименование сохраняет ревизию и историю');
  check(moved.file.fileId === read.fileId, 'Переименование сохраняет идентичность');
  const copy = await service.copy(moved.ref, project, 'Копия.md'); check(copy.file.fileId !== moved.file.fileId && !(await service.metadata(copy.ref)).tags.length, 'Копия получает отдельную идентичность без молчаливого переноса тегов');
  await rejects(() => service.copy(moved.ref, project, 'Копия.md'), 'EEXIST', 'Копирование не перезаписывает существующую цель');
  await rejects(() => service.move(moved.ref, project, 'Копия.md'), 'EEXIST', 'Перенос не заменяет существующий файл');
  const content = Buffer.from('содержимое черновика').toString('base64');
  const published = await service.publish(project, 'Черновик.md', content, 'draft-1');
  check(published.file.sha256 === hashWindowsBytes(Buffer.from('содержимое черновика')), 'Черновик публикуется в запомненную папку');
  check((await service.publish(project, 'Другое имя.md', content, 'draft-1')).alreadyPublished, 'Повторная публикация не создаёт второй файл');
  await rejects(() => service.publish(project, 'Черновик.md', content, 'draft-2'), 'EEXIST', 'Новый черновик не заменяет существующий файл');
  await rejects(() => service.publish(project, 'Черновик.md', Buffer.from('другие правки').toString('base64'), 'draft-1'), 'ALREADY_PUBLISHED', 'После публикации нельзя обойти CAS другой версией черновика');
  const draft = await service.createDraft(project, 'Личный черновик.md', Buffer.from('локально').toString('base64'));
  check(draft.file.storage === 'flux' && draft.ref.draftId, 'Локальный черновик имеет отдельную идентичность и признак Flux');
  check(!(await fs.readdir(path.join(desktop, 'Проект'))).includes('Личный черновик.md'), 'Черновик не создаёт файл в Windows до публикации');
  check((await service.list(project)).entries.some(item => item.storage === 'flux' && item.draftId === draft.ref.draftId), 'Черновик виден рядом с настоящими файлами');
  const fluxTree = await service.createDraftFolder(project, 'Локальное дерево');
  await service.setMetadata(fluxTree.ref, { tags: ['TREE'], projectIds: ['project-tree'], revision: 'T', responsible: 'Автор дерева' });
  const fluxSubfolder = await service.createDraftFolder(fluxTree.ref, 'Вложенные документы');
  await service.setMetadata(fluxSubfolder.ref, { tags: ['FOLDER'], projectIds: [], revision: 'F', responsible: '' });
  const fluxDoc = await service.createDraft(fluxSubfolder.ref, 'Расчёт.txt', Buffer.from('данные Flux').toString('base64'));
  await service.setMetadata(fluxDoc.ref, { tags: ['DOC'], projectIds: ['project-doc'], revision: 'D', responsible: 'Автор файла' });
  check((await service.list(fluxTree.ref)).entries.some(item => item.name === 'Вложенные документы' && item.storage === 'flux'), 'Виртуальная папка показывает вложенный черновик');
  check((await service.list(fluxSubfolder.ref)).entries.some(item => item.name === 'Расчёт.txt' && item.storage === 'flux'), 'Вложенный документ остаётся локальным черновиком');
  const treePublished = await service.publishDraftTree(fluxTree.ref);
  check(treePublished.complete && treePublished.published === 2 && !treePublished.failed.length, 'Публикация рекурсивно создаёт папки и документы без повторного буфера дерева');
  check(await fs.readFile(path.join(desktop, 'Проект', 'Локальное дерево', 'Вложенные документы', 'Расчёт.txt'), 'utf8') === 'данные Flux', 'Вложенные байты опубликованы с исходным относительным путём');
  const publishedRootMeta = await service.metadata(treePublished.ref);
  const publishedFolderMeta = await service.metadata({ rootId, relativePath: 'Проект/Локальное дерево/Вложенные документы' });
  const publishedFileMeta = await service.metadata({ rootId, relativePath: 'Проект/Локальное дерево/Вложенные документы/Расчёт.txt' });
  check(publishedRootMeta.fileId === fluxTree.file.fileId && publishedRootMeta.revision === 'T' && publishedRootMeta.tags.includes('TREE')
    && publishedFolderMeta.fileId === fluxSubfolder.file.fileId && publishedFolderMeta.revision === 'F' && publishedFolderMeta.tags.includes('FOLDER')
    && publishedFileMeta.fileId === fluxDoc.file.fileId && publishedFileMeta.revision === 'D' && publishedFileMeta.tags.includes('DOC'), 'Рекурсивная публикация сохраняет идентичность, теги и ревизии корня, папок и файлов');
  check(!!service.state.data.drafts[fluxDoc.ref.draftId!], 'Исходные локальные данные остаются восстановимыми после публикации');
  const copySource = await service.createDraftFolder(project, 'Локальный источник');
  const copyNested = await service.createDraftFolder(copySource.ref, 'Вложенная');
  await service.createDraft(copyNested.ref, 'Файл.txt', Buffer.from('копируемый черновик').toString('base64'));
  await rejects(() => service.copy(copySource.ref, copyNested.ref, 'Цикл'), 'RECURSIVE_TARGET', 'Виртуальную папку нельзя копировать внутрь её потомка');
  await rejects(() => service.move(copySource.ref, copyNested.ref, 'Цикл'), 'RECURSIVE_TARGET', 'Виртуальную папку нельзя перемещать внутрь её потомка');
  const copiedDraftTree = await service.copy(copySource.ref, project, 'Копия чернового дерева');
  const copiedFolder = (await service.list(copiedDraftTree.ref)).entries.find(entry => entry.name === 'Вложенная');
  check(!!copiedFolder?.draftId && (await service.list({ rootId, relativePath: copiedFolder.relativePath, draftId: copiedFolder.draftId })).entries.some(entry => entry.name === 'Файл.txt' && entry.storage === 'flux'), 'Копирование виртуальной папки рекурсивно создаёт отдельные черновые вложения');
  await rejects(() => service.createDraftFolder(project, 'локальное дерево'), 'EEXIST', 'Виртуальные папки не перезаписывают существующие имена');
  const blockedTree = await service.createDraftFolder(project, 'Занятое имя');
  await fs.mkdir(path.join(desktop, 'Проект', 'Занятое имя'));
  await rejects(() => service.publishDraftTree(blockedTree.ref), 'EEXIST', 'Публикация папки отказывается заменять уже созданную Windows-папку');
  check(!!service.state.data.drafts[blockedTree.ref.draftId!], 'Конфликт имени оставляет исходную виртуальную папку Flux нетронутой');
  const unsafeTree = await service.createDraftFolder(project, 'Проверка ссылки');
  const unsafeFile = await service.createDraft(unsafeTree.ref, 'Секрет.txt', Buffer.from('это не должно попасть в Windows').toString('base64'));
  const draftStore = path.join(userData, 'windows-files-drafts', `${unsafeFile.ref.draftId}.bin`);
  await fs.unlink(draftStore); await fs.symlink(path.join(outside, 'private.txt'), draftStore);
  const unsafePublish = await service.publishDraftTree(unsafeTree.ref);
  check(!unsafePublish.complete && unsafePublish.failed.length === 1, 'Рекурсивная публикация сообщает частичный сбой при ссылке в черновике');
  check(!(await fs.readdir(path.join(desktop, 'Проект', 'Проверка ссылки'))).includes('Секрет.txt') && !!service.state.data.drafts[unsafeFile.ref.draftId!], 'Ссылка не копирует данные вне Flux, а черновик остаётся доступен');
  await rejects(() => service.createDraft(project, 'личный черновик.md', ''), 'EEXIST', 'Имена черновиков сравниваются без учёта регистра Windows');
  await rejects(() => service.open(draft.ref), 'DRAFT_NOT_PUBLISHED', 'Системная программа не получает внутренний файл черновика');
  const draftEdited = await service.write(draft.ref, Buffer.from('правки черновика').toString('base64'), draft.file.sha256);
  check(draftEdited.fileId === draft.file.fileId, 'CAS-сохранение черновика сохраняет идентичность');
  await service.setMetadata(draft.ref, { tags: ['AHU-2'], projectIds: ['project2'], revision: 'C', responsible: 'Автор' });
  const draftRenamed = await service.rename(draft.ref, 'Финальный черновик.md');
  check((await service.read(draft.ref)).name === 'Финальный черновик.md', 'Старая ссылка черновика следует за его переименованием');
  service.close(); service = await WindowsFilesService.create(deps);
  check(Buffer.from((await service.read(draft.ref)).base64, 'base64').toString() === 'правки черновика', 'Локальный черновик и его правки переживают перезапуск');
  const draftPublication = await service.publishDraft(draft.ref);
  check(draftPublication.ref.relativePath === 'Проект/Финальный черновик.md' && draftPublication.file.storage === 'windows', 'Публикация создаёт настоящий файл в сохранённом родителе');
  check(draftPublication.file.fileId === draft.file.fileId && (await service.metadata(draftPublication.ref)).revision === 'C', 'Публикация переносит идентичность, теги и ревизию черновика');
  check(!(await service.list(project)).entries.some(item => item.draftId === draft.ref.draftId), 'После публикации остаётся одна карточка файла');
  check((await service.publishDraft(draft.ref)).alreadyPublished, 'Повторная публикация существующего черновика идемпотентна');
  const afterPublish = await service.read(draft.ref);
  await service.write(draft.ref, Buffer.from('правки уже Windows-файла').toString('base64'), afterPublish.sha256);
  check(await fs.readFile(path.join(desktop, 'Проект', 'Финальный черновик.md'), 'utf8') === 'правки уже Windows-файла', 'Сохранение старой ссылки после публикации обновляет Windows-оригинал');
  const doomedDraft = await service.createDraft(project, 'Удаляемый.md', Buffer.from('не публиковать').toString('base64'));
  const trashCount = trashed.length; await service.trash(doomedDraft.ref);
  check(trashed.length === trashCount && !(await service.list(project)).entries.some(item => item.draftId === doomedDraft.ref.draftId), 'Удаление черновика не затрагивает корзину и файлы Windows');
  check((await service.draftTrash()).some(item => item.ref.draftId === doomedDraft.ref.draftId), 'Удалённый черновик доступен в локальной корзине Flux');
  const restoredDraft = await service.restoreDraft(doomedDraft.ref);
  const restoredBytes = await service.read(restoredDraft.ref);
  check(Buffer.from(restoredBytes.base64, 'base64').toString() === 'не публиковать' && restoredDraft.file.fileId === doomedDraft.file.fileId, 'Восстановление локальной корзины сохраняет байты и идентичность');
  await service.mkdir({ rootId, relativePath: '' }, 'Дерево');
  await service.mkdir({ rootId, relativePath: 'Дерево' }, 'Вложенная');
  await fs.writeFile(path.join(desktop, 'Дерево', 'Вложенная', 'Данные.txt'), 'дерево данных');
  const nestedRef = { rootId, relativePath: 'Дерево/Вложенная/Данные.txt' };
  await service.setMetadata(nestedRef, { tags: ['CHILD'], projectIds: [], revision: 'D', responsible: '' });
  const treeDraft = await service.createDraft({ rootId, relativePath: 'Дерево/Вложенная' }, 'Черновик дерева.md', Buffer.from('дочерний черновик').toString('base64'));
  const folderCopy = await service.copy({ rootId, relativePath: 'Дерево' }, { rootId, relativePath: '' }, 'Копия дерева');
  check(await fs.readFile(path.join(desktop, 'Копия дерева', 'Вложенная', 'Данные.txt'), 'utf8') === 'дерево данных', 'Копирование папки проверяет байты всего дерева');
  check((await service.list({ rootId, relativePath: 'Копия дерева/Вложенная' })).entries.some(entry => entry.storage === 'flux' && entry.name === 'Черновик дерева.md' && entry.draftId !== treeDraft.ref.draftId), 'Копирование папки сохраняет локальные черновики отдельными копиями');
  await rejects(() => service.copy({ rootId, relativePath: 'Дерево' }, { rootId, relativePath: 'Дерево/Вложенная' }, 'Рекурсия'), 'RECURSIVE_TARGET', 'Папка не копируется внутрь себя');
  await rejects(() => service.copy({ rootId, relativePath: 'Дерево' }, { rootId, relativePath: '' }, 'Копия дерева'), 'EEXIST', 'Копирование дерева не заменяет существующую папку');
  const folderMove = await service.rename({ rootId, relativePath: 'Дерево' }, 'Перенесённое дерево');
  check((await service.metadata({ rootId, relativePath: 'Перенесённое дерево/Вложенная/Данные.txt' })).revision === 'D', 'Перенос папки сохраняет свойства вложенных файлов');
  const remappedDraft = service.resolveRef(treeDraft.ref);
  check(remappedDraft.relativePath === 'Перенесённое дерево/Вложенная/Черновик дерева.md', 'Перенос папки меняет родителя локального черновика');
  check((await service.publishDraft(treeDraft.ref)).ref.relativePath === remappedDraft.relativePath, 'Черновик публикуется в папку после её переноса');
  await service.mkdir({ rootId, relativePath: '' }, 'Внешний родитель');
  const externallyMovedDraft = await service.createDraft({ rootId, relativePath: 'Внешний родитель' }, 'Внешний.md', Buffer.from('родитель из Windows').toString('base64'));
  await fs.rename(path.join(desktop, 'Внешний родитель'), path.join(desktop, 'Изменено в Windows'));
  check((await service.publishDraft(externallyMovedDraft.ref)).ref.relativePath === 'Изменено в Windows/Внешний.md', 'Публикация находит родителя по идентичности после переименования из Windows');
  await fs.symlink(outside, path.join(desktop, 'Копия дерева', 'junction'), 'junction');
  await rejects(() => service.copy(folderCopy.ref, { rootId, relativePath: '' }, 'Опасная копия'), 'LINK_BLOCKED', 'Предпроверка дерева запрещает junction и не создаёт частичную копию');
  const interruptedRef = { rootId, relativePath: 'Проект/После прерывания.md' };
  await fs.writeFile(path.join(desktop, 'Проект', 'После прерывания.md'), 'готовые байты');
  const interruptedContent = await service.read(interruptedRef);
  service.state.data.publications['interrupted-complete'] = { ref: interruptedRef, sha256: interruptedContent.sha256, fileId: interruptedContent.fileId, status: 'pending' };
  await service.state.save(); service.close(); service = await WindowsFilesService.create(deps);
  check((await service.publish(project, 'После прерывания.md', interruptedContent.base64, 'interrupted-complete')).alreadyPublished, 'Журнал завершает публикацию после сбоя между записью байтов и отметкой результата');
  const partialRef = { rootId, relativePath: 'Проект/Частичный.md' };
  await fs.writeFile(path.join(desktop, 'Проект', 'Частичный.md'), 'часть');
  const partialFile = await service.read(partialRef);
  service.state.data.publications['interrupted-partial'] = { ref: partialRef, sha256: hashWindowsBytes(Buffer.from('полная версия')), fileId: partialFile.fileId, status: 'pending' };
  await service.state.save();
  await rejects(() => service.publish(project, 'Частичный.md', Buffer.from('полная версия').toString('base64'), 'interrupted-partial'), 'PUBLICATION_INCOMPLETE', 'Частичная публикация сообщает явную ошибку и не заменяет файл');
  check(await fs.readFile(path.join(desktop, 'Проект', 'Частичный.md'), 'utf8') === 'часть', 'Частично записанный файл сохранён для разбирательства');
  service.state.data.publications['interrupted-before-create'] = { ref: { rootId, relativePath: 'Проект/Ещё не создан.md' }, sha256: hashWindowsBytes(Buffer.from('после рестарта')), fileId: '', status: 'pending' };
  await service.state.save();
  check(!(await service.publish(project, 'Ещё не создан.md', Buffer.from('после рестарта').toString('base64'), 'interrupted-before-create')).alreadyPublished, 'Публикация возобновляется после сбоя до создания физического файла');
  await service.reveal(published.ref); await service.open(published.ref); check(revealed.length === 1 && opened.length === 1, 'Открытие и показ используют настоящий исходный путь');
  await service.watch(project, 7); await service.watch(project, 8); await service.unwatch(project, 7);
  await fs.writeFile(path.join(desktop, 'Проект', 'Из Windows.txt'), 'внешняя запись');
  await new Promise(resolve => setTimeout(resolve, 250));
  check(notifications.some(event => event.relativePath === 'Проект' && event.rescan), 'Наблюдатель сообщает сверку папки после внешней записи');
  service.closeOwner(8); service.close();
  service = await WindowsFilesService.create(deps);
  check((await service.roots())[0].id === rootId, 'Capability корня сохраняется после перезапуска');
  check((await service.metadata(moved.ref)).revision === 'B', 'Ревизия сохраняется после перезапуска');
  check((await service.publish(project, 'Черновик.md', content, 'draft-1')).alreadyPublished, 'Журнал публикации сохраняется после перезапуска');
  await service.trash(copy.ref); check(trashed.length >= 1 && (await service.metadata(moved.ref)).revision === 'B', 'Удаление использует корзину и не удаляет чужую историю');
  await rejects(() => service.trash({ rootId, relativePath: '' }), 'ROOT_OPERATION', 'Корень подключённой папки нельзя удалить');
  check((await fs.readdir(path.join(userData, 'windows-files-recovery'))).length > 0, 'Перед заменой сохранён восстановимый снимок');
  const cleanupSource = path.join(sandbox, 'cleanup-source'); const cleanupTarget = path.join(sandbox, 'cleanup-target');
  await fs.mkdir(cleanupSource); await fs.writeFile(path.join(cleanupSource, 'own.txt'), 'создано операцией');
  const cleanupCreated = await copyWindowsTree(cleanupSource, cleanupTarget, await inspectWindowsTree(cleanupSource));
  await fs.writeFile(path.join(cleanupTarget, 'foreign.txt'), 'новый файл пользователя');
  await cleanCreatedWindowsTree(cleanupCreated);
  check(await fs.readFile(path.join(cleanupTarget, 'foreign.txt'), 'utf8') === 'новый файл пользователя', 'Откат копирования не удаляет новые чужие файлы в папке назначения');
  const racingDraft = await service.createDraft(project, 'Параллельная публикация.md', Buffer.from('начальная версия').toString('base64'));
  const raceResults = await Promise.all([service.publishDraft(racingDraft.ref), service.write(racingDraft.ref, Buffer.from('сохранено параллельно публикации').toString('base64'), racingDraft.file.sha256)]);
  check(await fs.readFile(path.join(desktop, 'Проект', 'Параллельная публикация.md'), 'utf8') === 'сохранено параллельно публикации', 'Параллельное сохранение черновика после публикации изменяет физический оригинал');
  const temporaryRoot = path.join(sandbox, 'temporary-root'); await fs.mkdir(temporaryRoot);
  const connectedTemporary = await service.addRoot(temporaryRoot);
  await fs.rename(temporaryRoot, `${temporaryRoot}-moved`); await fs.symlink(outside, temporaryRoot, 'junction');
  await rejects(() => service.list({ rootId: connectedTemporary.id, relativePath: '' }), 'ROOT_CHANGED', 'Подмена подключённого корня ссылкой не расширяет capability');
  console.log(`ALL TESTS PASSED (${passed})`);
} finally { service?.close(); await fs.rm(sandbox, { recursive: true, force: true }); }

}
// ---------------------------------------------------------------------------
// Команды Проводника Windows 11 (этап A): всё, что проверяется без Windows.
// Свой каталог и своя служба: сценарии выше не должны зависеть от этих файлов.
// ---------------------------------------------------------------------------
async function explorerScenarios() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-windows-explorer-test-'));
  let service: WindowsFilesService | undefined;
  try {
    const desktop = path.join(sandbox, 'desktop'); const userData = path.join(sandbox, 'flux-data'); const outside = path.join(sandbox, 'outside');
    await fs.mkdir(path.join(desktop, 'Проект', 'Вложенная', 'Глубже'), { recursive: true }); await fs.mkdir(path.join(desktop, 'Другое'), { recursive: true }); await fs.mkdir(outside);
    const put = (relative: string, content: string) => fs.writeFile(path.join(desktop, ...relative.split('/')), content);
    await put('Проект/Отчёт 2026.docx', 'отчёт'); await put('Проект/Вложенная/Схема.pdf', 'схема-схема'); await put('Проект/Вложенная/Глубже/отчёт-итог.txt', 'итог');
    await put('Другое/readme.md', 'readme'); await fs.writeFile(path.join(outside, 'секрет отчёт.txt'), 'за пределами корня');
    await fs.symlink(outside, path.join(desktop, 'Проект', 'ссылка'), 'junction');
    const trashed: string[] = []; const dragged: { owner: number; files: string[] }[] = [];
    // «Корзина» проверки: файл уезжает рядом и возвращается по исходному пути, но не поверх занятого места.
    const bin = path.join(sandbox, 'bin'); await fs.mkdir(bin);
    const deps = {
      userData, knownFolders: { desktop },
      trashItem: async (filename: string) => { const stored = path.join(bin, `${trashed.length}-${path.basename(filename)}`); trashed.push(filename); await fs.rename(filename, stored); },
      showItemInFolder: () => undefined, openPath: async () => '',
      restoreFromTrash: async (info: { path: string; size: number | null; name: string }) => {
        const index = trashed.lastIndexOf(info.path); if (index < 0) throw Object.assign(new Error('нет в корзине'), { code: 'NATIVE_BIN_ITEM_NOT_FOUND' });
        await fs.access(info.path).then(() => { throw Object.assign(new Error('занято'), { code: 'EEXIST' }); }, () => undefined);
        await fs.rename(path.join(bin, `${index}-${path.basename(info.path)}`), info.path);
      },
      startDrag: async (owner: number, files: string[]) => { dragged.push({ owner, files }); },
    };
    service = await WindowsFilesService.create(deps);
    const svc = service;
    const rootId = (await svc.roots())[0].id; const project = { rootId, relativePath: 'Проект' }; const root = { rootId, relativePath: '' };
    const real = await fs.realpath(desktop);
    const text = (value: string) => Buffer.from(value).toString('base64');
    const read = async (relative: string) => fs.readFile(path.join(desktop, ...relative.split('/')), 'utf8');
    const exists = (relative: string) => fs.access(path.join(desktop, ...relative.split('/'))).then(() => true, () => false);

    // ---- search: рекурсивный поиск потоком страниц
    const registry = new SearchRegistry();
    const run = (params: Partial<SearchParams> & { query: string }, owner = 1, onPage?: (event: WindowsSearchEvent) => void) => new Promise<{ hits: WindowsSearchHit[]; last: WindowsSearchEvent; pages: number }>((resolve, reject) => {
      const hits: WindowsSearchHit[] = []; let pages = 0;
      try {
        registry.start(svc, owner, { ref: root, requestId: `r${Math.random().toString(36).slice(2, 10)}`, ...params }, (_owner, event) => {
          if (event.hits.length) { pages++; hits.push(...event.hits); }
          onPage?.(event);
          if (event.done) resolve({ hits, last: event, pages });
        });
      } catch (error) { reject(error); }
    });
    const draftFile = await svc.createDraft(project, 'Отчёт черновик.md', text('локальный'));
    const found = await run({ query: 'отчет' });
    const names = found.hits.map(hit => hit.name).sort();
    check(JSON.stringify(names) === JSON.stringify(['Отчёт 2026.docx', 'Отчёт черновик.md', 'отчёт-итог.txt']), 'Поиск находит файлы всех уровней и черновики Flux; «ё» и «е» не различаются');
    check(found.last.reason === 'complete' && found.last.done && found.last.scanned >= 6, 'Поиск завершается событием done с причиной complete и числом просмотренного');
    check(found.hits.every(hit => !('path' in hit) && !JSON.stringify(hit).includes(real)), 'Результаты поиска несут capability и относительный путь, а не абсолютный путь');
    check(found.hits.find(hit => hit.name === 'отчёт-итог.txt')?.parentPath === 'Проект/Вложенная/Глубже' && found.hits.find(hit => hit.draftId)?.storage === 'flux', 'У результата есть папка расположения, а у черновика — признак Flux');
    check(!found.hits.some(hit => hit.name.includes('секрет')), 'Поиск не заходит по ссылке (junction) за пределы подключённой папки');
    check((await run({ query: 'ОТЧЁТ*.DOCX' })).hits.map(hit => hit.name).join() === 'Отчёт 2026.docx', 'Слово с * — маска имени целиком, без учёта регистра');
    check((await run({ query: 'отчёт итог' })).hits.length === 1 && (await run({ query: 'итог отчёт' })).hits.length === 1 && (await run({ query: 'отчёт схема' })).hits.length === 0, 'Слова запроса обязательны все, порядок не важен');
    check((await run({ query: '', filters: { extensions: ['pdf'] } })).hits.map(hit => hit.name).join() === 'Схема.pdf', 'Фильтр по расширению работает и без текста запроса');
    check((await run({ query: 'вложенная', filters: { kind: 'directory' } })).hits.every(hit => hit.kind === 'directory') && (await run({ query: 'вложенная', filters: { kind: 'file' } })).hits.length === 0, 'Фильтр типа отделяет папки от файлов');
    check((await run({ query: '', filters: { sizeMin: 20, kind: 'file' } })).hits.map(hit => hit.name).join() === 'Схема.pdf', 'Фильтр по размеру оставляет файлы не меньше заданного');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    check((await run({ query: 'отчёт', filters: { modifiedFrom: future } })).hits.length === 0 && (await run({ query: 'отчёт', filters: { modifiedTo: future } })).hits.length === 3, 'Фильтр по дате изменения отсекает по обе стороны');
    await svc.setMetadata({ rootId, relativePath: 'Проект/Отчёт 2026.docx' }, { tags: ['Рабочий'], projectIds: ['p1'], revision: 'C', responsible: '' });
    check((await run({ query: '', filters: { tag: 'рабочий' } })).hits.map(hit => hit.name).join() === 'Отчёт 2026.docx' && (await run({ query: '', filters: { revision: 'c', projectId: 'P1' } })).hits.length === 1, 'Свойства Flux (тег, проект, ревизия) участвуют в поиске');
    check((await run({ query: 'отчёт', filters: { onlyDrafts: true } })).hits.map(hit => hit.name).join() === 'Отчёт черновик.md', '«Только черновики» ищет лишь среди неопубликованного');
    const shallow = await run({ query: 'итог', limits: { depth: 1 } });
    check(shallow.hits.length === 0 && (shallow.last.depthSkipped ?? 0) > 0, 'Предел глубины: глубокие папки не просматриваются и это сообщается');
    check((await run({ query: 'о', limits: { hits: 1 } })).last.reason === 'limit-hits' && (await run({ query: 'о', limits: { objects: 2 } })).last.reason === 'limit-objects', 'Пределы числа результатов и числа объектов останавливают поиск с названной причиной');
    check((await run({ query: 'отчёт', limits: { hits: 10 ** 9 } })).last.reason === 'complete', 'Просьба о слишком большом пределе обрезается потолком, а не отклоняется');
    await fs.mkdir(path.join(desktop, 'Много'));
    for (let i = 0; i < 400; i++) await fs.writeFile(path.join(desktop, 'Много', `файл-${i}.txt`), 'x');
    const pagesSeen: number[] = []; let stopper: (() => void) | undefined;
    const canceled = await run({ query: 'файл', requestId: 'cancel-me' }, 1, event => { if (event.hits.length) { pagesSeen.push(event.hits.length); stopper ??= () => registry.cancel(1, 'cancel-me'); stopper(); } });
    check(canceled.last.reason === 'canceled' && canceled.hits.length < 400 && pagesSeen[0] === 100, 'Отмена по номеру запроса останавливает поиск после первой страницы из 100 результатов');
    check(!registry.cancel(2, 'cancel-me') && !registry.cancel(1, 'cancel-me'), 'Отменить чужой или уже завершённый поиск нельзя');
    check((await run({ query: 'файл' })).pages >= 4, 'Результаты приходят страницами по мере нахождения, а не одним куском');
    await rejects(async () => run({ query: 'x', ref: { rootId: 'нет такого', relativePath: '' } }), 'UNKNOWN_ROOT', 'Поиск в неизвестном корне отклоняется сразу ответом');
    await rejects(async () => run({ query: '   ' }), 'INVALID_REQUEST', 'Пустой запрос без условий не запускает обход всего диска');
    await rejects(async () => run({ query: 'x', requestId: 'плохой номер!' }), 'INVALID_REQUEST', 'Номер запроса проверяется');
    await rejects(async () => run({ query: 'x', filters: { extensions: ['../x'] } }), 'INVALID_REQUEST', 'Расширения проверяются');
    const slow: string[] = [];
    for (let i = 0; i < 4; i++) registry.start(svc, 9, { ref: root, requestId: `slow${i}`, query: 'файл' }, () => undefined) && slow.push(`slow${i}`);
    await rejects(async () => registry.start(svc, 9, { ref: root, requestId: 'slow5', query: 'файл' }, () => undefined), 'TOO_MANY_SEARCHES', 'Число одновременных поисков одного окна ограничено');
    registry.closeOwner(9);
    const outsideSearch = await run({ query: 'x', ref: { rootId, relativePath: '../outside' } }).then(result => result.last, error => ({ error: { code: error.code } }));
    check((outsideSearch as any).error?.code === 'INVALID_NAME' || (outsideSearch as any).reason === 'error', 'Поиск не начинается вне подключённой папки');
    await fs.rm(path.join(desktop, 'Много'), { recursive: true });

    // ---- children: подпапки для дерева
    const draftFolder = await svc.createDraftFolder(project, 'Черновая папка');
    await svc.createDraftFolder(draftFolder.ref, 'Внутренняя черновая');
    const top = await listChildFolders(svc, project, true);
    check(top.folders.map(item => item.name).join() === 'Вложенная,Черновая папка', 'Дерево получает только подпапки: файлы и ссылки не попадают в список');
    check(top.folders.find(item => item.name === 'Вложенная')?.hasChildren === true && top.folders.find(item => item.name === 'Черновая папка')?.storage === 'flux' && top.folders.find(item => item.name === 'Черновая папка')?.hasChildren === true, 'Папки-черновики — ветви дерева; подсказка «есть вложенные» считается для обоих видов');
    check(!top.folders.some(item => 'size' in item || 'fileId' in item), 'Запись дерева не несёт размеров и идентичности файлов');
    check((await listChildFolders(svc, root, true)).folders.find(item => item.name === 'Другое')?.hasChildren === false, 'У папки без подпапок нет стрелки раскрытия');
    check((await listChildFolders(svc, draftFolder.ref)).folders.map(item => item.name).join() === 'Внутренняя черновая', 'Подпапки черновой папки читаются без обращения к диску');
    await rejects(() => listChildFolders(svc, { rootId, relativePath: '../outside' }), 'INVALID_NAME', 'Дерево не выходит за пределы подключённой папки');
    await rejects(() => listChildFolders(svc, { rootId, relativePath: 'Проект/ссылка' }), 'LINK_BLOCKED', 'Дерево не раскрывает junction');
    await rejects(() => listChildFolders(svc, { rootId, relativePath: 'Проект/Отчёт 2026.docx' }), 'NOT_DIRECTORY', 'Раскрыть можно только папку');

    // ---- viewState: вид папки и вкладки
    const views = await ViewStateStore.load(userData);
    await views.set({ [`folder:${rootId}:Проект`]: { mode: 'tiles', sort: ['name', 'asc'] }, tabs: [{ id: 1, title: 'Главная' }] });
    check(JSON.stringify(views.get([`folder:${rootId}:Проект`, 'tabs', 'нет'])) === JSON.stringify({ [`folder:${rootId}:Проект`]: { mode: 'tiles', sort: ['name', 'asc'] }, tabs: [{ id: 1, title: 'Главная' }] }), 'Вид папки и вкладки записываются и читаются; отсутствующий ключ не возвращается');
    check(JSON.stringify((await ViewStateStore.load(userData)).get(['tabs'])) === JSON.stringify({ tabs: [{ id: 1, title: 'Главная' }] }), 'Вид переживает перезапуск');
    await rejects(() => views.set({ огромный: 'x'.repeat(70_000) }), 'VIEW_STATE_TOO_LARGE', 'Значение вида больше 64 КБ отклоняется');
    await rejects(() => views.set({ ['a'.repeat(301)]: 1 }), 'INVALID_REQUEST', 'Слишком длинный ключ вида отклоняется');
    await rejects(() => views.set({ 'плохой\nключ': 1 }), 'INVALID_REQUEST', 'Ключ с управляющими знаками отклоняется');
    await rejects(async () => views.get('не массив'), 'INVALID_REQUEST', 'Ключи читаются массивом');
    check((await views.delete(['tabs', 'нет'])).deleted === 1 && Object.keys(views.get(['tabs'])).length === 0, 'Удаление ключей вида возвращает, сколько удалено');
    for (let batch = 0; batch < 90; batch++) await views.set(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${batch}-${i}`, i])));
    const fresh = await ViewStateStore.load(userData);
    check(Object.keys(fresh.get(Array.from({ length: 90 }, (_, b) => `k${b}-0`))).length > 70 && fresh.get(['k0-0'])['k0-0'] === undefined && fresh.get(['k89-49'])['k89-49'] === 49, 'Больше 4000 ключей: вытесняются самые давние, свежие остаются');
    await fs.writeFile(path.join(userData, 'windows-files-view-state.json'), '{повреждён');
    check(Object.keys((await ViewStateStore.load(userData)).get(['k89-49'])).length === 0 && (await fs.readdir(userData)).some(name => name.includes('view-state.json.broken-')), 'Повреждённый файл вида не мешает запуску и откладывается для разбора');

    // ---- copy: перенос тегов и проекта
    const tagged = { rootId, relativePath: 'Проект/Отчёт 2026.docx' };
    await svc.setMetadata(tagged, { tags: ['Рабочий', 'AHU1'], projectIds: ['p1', 'p2'], revision: 'C', responsible: 'Автор' });
    const plainCopy = await svc.copy(tagged, project, 'Копия без тегов.docx');
    const carried = await svc.copy(tagged, project, 'Копия с тегами.docx', { carryMeta: true });
    const carriedMeta = await svc.metadata(carried.ref);
    check((await svc.metadata(plainCopy.ref)).tags.length === 0, 'Без carryMeta копия не получает теги, как и раньше');
    check(carriedMeta.tags.join() === 'Рабочий,AHU1' && carriedMeta.projectIds.join() === 'p1,p2' && carriedMeta.revision === '' && carriedMeta.responsible === '' && carriedMeta.fileId !== (await svc.metadata(tagged)).fileId, 'С carryMeta копия получает теги и проекты, но не ревизию и ответственного, и остаётся отдельным файлом');
    check((await svc.metadata(tagged)).tags.join() === 'Рабочий,AHU1' && (await svc.metadata(tagged)).revision === 'C', 'Свойства оригинала при копировании не меняются');
    await fs.mkdir(path.join(desktop, 'Папка с тегами', 'Вложенная'), { recursive: true }); await put('Папка с тегами/a.txt', 'a'); await put('Папка с тегами/Вложенная/b.txt', 'b');
    await svc.setMetadata({ rootId, relativePath: 'Папка с тегами/Вложенная/b.txt' }, { tags: ['Вложенный'], projectIds: ['p3'], revision: '', responsible: '' });
    await svc.setMetadata({ rootId, relativePath: 'Папка с тегами' }, { tags: ['Папка'], projectIds: [], revision: '', responsible: '' });
    const folderCopy = await svc.copy({ rootId, relativePath: 'Папка с тегами' }, root, 'Копия папки', { carryMeta: true });
    check((await svc.metadata(folderCopy.ref)).tags.join() === 'Папка' && (await svc.metadata({ rootId, relativePath: 'Копия папки/Вложенная/b.txt' })).projectIds.join() === 'p3' && (await svc.metadata({ rootId, relativePath: 'Копия папки/a.txt' })).tags.length === 0, 'Копия папки переносит теги на неё и на вложенные файлы, а у файлов без тегов ничего не заводит');
    const taggedDraft = await svc.createDraft(project, 'Тегированный.md', text('д'));
    await svc.setMetadata(taggedDraft.ref, { tags: ['Д'], projectIds: ['pd'], revision: 'R', responsible: '' });
    const draftCopy = await svc.copy(taggedDraft.ref, project, 'Копия черновика.md', { carryMeta: true });
    check((await svc.metadata(draftCopy.ref)).tags.join() === 'Д' && (await svc.metadata(draftCopy.ref)).revision === '', 'Копия черновика переносит теги и проект, ревизию — нет');
    for (const name of ['Копия без тегов.docx', 'Копия с тегами.docx']) await fs.rm(path.join(desktop, 'Проект', name));
    await fs.rm(path.join(desktop, 'Копия папки'), { recursive: true }); await fs.rm(path.join(desktop, 'Папка с тегами'), { recursive: true });
    await svc.journal.save();

    // ---- undo: журнал операций на диске. Свой каталог данных: журнал после копирования выше не должен мешать.
    svc.close();
    const undoData = path.join(sandbox, 'undo-data');
    service = await WindowsFilesService.create({ ...deps, userData: undoData });
    const u = service; const uRoot = (await u.roots())[0].id;
    const U = (relative: string) => ({ rootId: uRoot, relativePath: relative }); const uProject = U('Проект'); const uTop = U('');
    await rejects(() => undoLast(u), 'NOTHING_TO_UNDO', 'Пустой журнал честно отвечает, что отменять нечего');
    await rejects(() => redoLast(u), 'NOTHING_TO_REDO', 'Нечего и повторять');
    await u.rename(U('Проект/Отчёт 2026.docx'), 'Отчёт v2.docx');
    check(u.journal.state().undo?.label.includes('Переименование') === true, 'Переименование попадает в журнал с понятной подписью');
    const undone = await undoLast(u);
    check(await exists('Проект/Отчёт 2026.docx') && !(await exists('Проект/Отчёт v2.docx')) && undone.state.redo?.label === undone.label, 'Отмена возвращает прежнее имя и открывает повтор');
    await redoLast(u);
    check(await exists('Проект/Отчёт v2.docx') && !(await exists('Проект/Отчёт 2026.docx')), 'Повтор снова переименовывает');
    await fs.writeFile(path.join(desktop, 'Проект', 'Отчёт v2.docx'), 'правки пользователя');
    await undoLast(u);
    check(await read('Проект/Отчёт 2026.docx') === 'правки пользователя', 'Правки содержимого не мешают отменить переименование: возвращается имя, а не старые данные');
    await u.move(U('Проект/Отчёт 2026.docx'), U('Другое'), 'Перенесённый.docx');
    check(await exists('Другое/Перенесённый.docx'), 'Перенос выполнен');
    await undoLast(u);
    check(await exists('Проект/Отчёт 2026.docx') && !(await exists('Другое/Перенесённый.docx')), 'Отмена переноса возвращает файл на прежнее место');
    await u.move(U('Проект/Отчёт 2026.docx'), U('Другое'), 'Подвижный.docx');
    await put('Проект/Отчёт 2026.docx', 'новый файл с тем же именем');
    await rejects(() => undoLast(u), 'UNDO_BLOCKED', 'Отмена переноса отказывает, если прежнее имя уже занято, и ничего не затирает');
    check(await read('Проект/Отчёт 2026.docx') === 'новый файл с тем же именем' && await exists('Другое/Подвижный.docx'), 'После отказа оба файла на месте');
    await fs.rm(path.join(desktop, 'Проект', 'Отчёт 2026.docx'));
    await undoLast(u);
    check(await read('Проект/Отчёт 2026.docx') === 'правки пользователя', 'Когда место освободили, отмена переноса проходит');
    await u.rename(U('Проект/Отчёт 2026.docx'), 'Исчезнет.docx');
    await fs.rm(path.join(desktop, 'Проект', 'Исчезнет.docx'));
    await rejects(() => undoLast(u), 'UNDO_MISSING', 'Если объект удалён снаружи, отмена переименования честно отказывает');
    check(u.journal.state().undo?.label.includes('Исчезнет') !== true, 'Отказавшая запись убирается из журнала, чтобы не загораживать более ранние');
    await put('Проект/Отчёт 2026.docx', 'отчёт');
    const made = await u.mkdir(uProject, 'Новая папка');
    await undoLast(u);
    check(!(await exists('Проект/Новая папка')) && trashed.some(item => item.endsWith('Новая папка')), 'Отмена создания папки отправляет её в корзину, а не стирает');
    await redoLast(u);
    check(await exists('Проект/Новая папка') && made.kind === 'directory', 'Повтор создания возвращает папку из корзины');
    await put('Проект/Новая папка/чужой.txt', 'положено позже');
    await rejects(() => undoLast(u), 'UNDO_CHANGED', 'Отмена создания отказывает, если в папку что-то положили: данные не уходят в корзину молча');
    check(await read('Проект/Новая папка/чужой.txt') === 'положено позже', 'Отказ оставляет папку со вложенным файлом');
    await u.copy(U('Проект/Вложенная/Схема.pdf'), uProject, 'Схема копия.pdf');
    await fs.writeFile(path.join(desktop, 'Проект', 'Схема копия.pdf'), 'правки копии');
    await rejects(() => undoLast(u), 'UNDO_CHANGED', 'Отмена копирования отказывает, если копию уже правили');
    check(await read('Проект/Схема копия.pdf') === 'правки копии', 'Правленая копия не тронута');
    await put('Проект/Удаляемый.txt', 'удалить и вернуть');
    await u.trash(U('Проект/Удаляемый.txt'));
    check(!(await exists('Проект/Удаляемый.txt')), 'Удаление ушло в корзину');
    await undoLast(u);
    check(await read('Проект/Удаляемый.txt') === 'удалить и вернуть', 'Отмена удаления возвращает файл из корзины с прежним содержимым');
    await redoLast(u);
    check(!(await exists('Проект/Удаляемый.txt')), 'Повтор удаляет снова');
    await put('Проект/Удаляемый.txt', 'новый с тем же именем');
    await rejects(() => undoLast(u), 'UNDO_BLOCKED', 'Отмена удаления не затирает новый файл с тем же именем: корзина откажет');
    check(await read('Проект/Удаляемый.txt') === 'новый с тем же именем', 'Новый файл не тронут отказом');
    await fs.rm(path.join(desktop, 'Проект', 'Удаляемый.txt'));
    await undoLast(u);
    check(await read('Проект/Удаляемый.txt') === 'удалить и вернуть', 'Когда место свободно, отмена удаления проходит');
    const noRestore = await WindowsFilesService.create({ ...deps, userData: path.join(sandbox, 'no-restore'), restoreFromTrash: undefined });
    await put('Проект/Без возврата.txt', 'x'); const noRestoreRoot = (await noRestore.roots())[0].id;
    await noRestore.trash({ rootId: noRestoreRoot, relativePath: 'Проект/Без возврата.txt' });
    await rejects(() => undoLast(noRestore), 'UNDO_UNAVAILABLE', 'Без возврата из корзины отмена удаления честно отказывает');
    check(!!noRestore.journal.state().undo, 'Отказ из-за недоступной корзины не стирает запись журнала');
    noRestore.close();

    // пакет: вставка нескольких файлов отменяется одним действием
    for (const name of ['A.txt', 'B.txt', 'C.txt']) { await put(`Другое/${name}`, name); await u.copy(U(`Другое/${name}`), uProject, `Вставка ${name}`, { group: 'paste-1' }); }
    const groupUndo = await undoLast(u);
    check(!(await exists('Проект/Вставка A.txt')) && !(await exists('Проект/Вставка B.txt')) && !(await exists('Проект/Вставка C.txt')) && groupUndo.state.redo !== null, 'Пакет из трёх копий отменяется одним действием');
    await redoLast(u);
    check(await exists('Проект/Вставка A.txt') && await exists('Проект/Вставка C.txt'), 'Пакет повторяется целиком');
    await undoLast(u);
    await u.mkdir(uProject, 'После отмены');
    check(u.journal.state().redo === null, 'Новое действие обрывает цепочку повтора');
    await rejects(() => redoLast(u), 'NOTHING_TO_REDO', 'Нечего повторять после нового действия');

    // черновики в журнале
    const journalDraft = await u.createDraft(uProject, 'Журнал.md', text('черновик'));
    await undoLast(u);
    check((await u.draftTrash()).some(item => item.name === 'Журнал.md'), 'Отмена создания черновика переносит его в локальную корзину Flux');
    await redoLast(u);
    check((await u.list(uProject)).entries.some(item => item.name === 'Журнал.md' && item.storage === 'flux'), 'Повтор возвращает черновик из корзины Flux');
    await u.rename(journalDraft.ref, 'Журнал 2.md'); await undoLast(u);
    check((await u.list(uProject)).entries.some(item => item.name === 'Журнал.md'), 'Отмена переименования черновика возвращает имя');
    await u.move(journalDraft.ref, uTop, 'Журнал.md'); await undoLast(u);
    check((await u.list(uProject)).entries.some(item => item.name === 'Журнал.md'), 'Отмена переноса черновика возвращает его в прежнюю папку');
    await u.trash(journalDraft.ref); await undoLast(u);
    check((await u.list(uProject)).entries.some(item => item.name === 'Журнал.md'), 'Отмена удаления черновика возвращает его');

    // перезапуск: журнал лежит на диске
    await u.rename(U('Проект/Схема копия.pdf'), 'Схема после перезапуска.pdf');
    u.close();
    service = await WindowsFilesService.create({ ...deps, userData: undoData });
    check(service.journal.state().undo?.label.includes('Схема после перезапуска.pdf') === true, 'Журнал отмены переживает перезапуск');
    await undoLast(service);
    check(await exists('Проект/Схема копия.pdf'), 'После перезапуска отмена работает');
    service.close();
    await fs.writeFile(path.join(undoData, 'windows-files-undo.json'), '{ не json');
    service = await WindowsFilesService.create({ ...deps, userData: undoData });
    check(service.journal.state().undo === null && (await fs.readdir(undoData)).some(name => name.includes('undo.json.broken-')), 'Повреждённый журнал не мешает запуску и откладывается для разбора');
    // ---- publishPlan и выбор «заменить / пропустить / оставить оба»
    const live = service; const L = (relative: string) => ({ rootId: (liveRoot), relativePath: relative });
    const liveRoot = (await live.roots())[0].id; const lProject = L('Проект');
    // Имя занимается в Windows уже после создания черновика: так совпадение и бывает на деле.
    const doc = await live.createDraft(lProject, 'Док.docx', text('из черновика'));
    await live.setMetadata(doc.ref, { tags: ['Черновой тег'], projectIds: [], revision: '', responsible: '' });
    await put('Проект/Док.docx', 'существующий'); await put('Проект/Док (2).docx', 'вторая занята');
    const before = (await fs.readdir(path.join(desktop, 'Проект'))).sort().join('|');
    const plan = await planPublication(live, doc.ref);
    check(plan.collisions === 1 && plan.items[0].status === 'collision' && plan.items[0].suggestedName === 'Док (3).docx' && plan.items[0].replaceable === true && plan.items[0].existing?.kind === 'file', 'План показывает совпадение имени и предлагает свободное «Док (3).docx», как Windows');
    check((await fs.readdir(path.join(desktop, 'Проект'))).sort().join('|') === before, 'План ничего не записывает');
    await rejects(() => live.publishDraft(doc.ref), 'EEXIST', 'Без выбора публикация по-прежнему отказывает при занятом имени');
    check(JSON.stringify(await live.publishDraft(doc.ref, { [doc.ref.draftId!]: 'skip' })) === JSON.stringify({ skipped: true, draftId: doc.ref.draftId }) && await read('Проект/Док.docx') === 'существующий', '«Пропустить» ничего не публикует и оставляет черновик');
    await rejects(() => live.publishDraft(doc.ref, { [doc.ref.draftId!]: 'перезаписать' as any }), 'INVALID_REQUEST', 'Неизвестный выбор отклоняется');
    const both = await live.publishDraft(doc.ref, { [doc.ref.draftId!]: 'keepBoth' }) as any;
    check(both.ref.relativePath === 'Проект/Док (3).docx' && await read('Проект/Док (3).docx') === 'из черновика' && await read('Проект/Док.docx') === 'существующий', '«Оставить оба» публикует под свободным именем и не трогает существующий файл');
    check((await live.list(lProject)).entries.filter(item => item.name.startsWith('Док')).every(item => item.storage === 'windows'), 'После «оставить оба» в списке нет дубля-черновика');
    const rep = await live.createDraft(lProject, 'Заменяемый.docx', text('новое содержимое'));
    await put('Проект/Заменяемый.docx', 'старое содержимое');
    const oldMeta = await live.setMetadata({ rootId: liveRoot, relativePath: 'Проект/Заменяемый.docx' }, { tags: ['старый тег'], projectIds: [], revision: 'Старая', responsible: '' });
    await live.setMetadata(rep.ref, { tags: ['новый тег'], projectIds: ['pz'], revision: 'Новая', responsible: '' });
    const replaced = await live.publishDraft(rep.ref, { [rep.ref.draftId!]: 'replace' }) as any;
    const mergedMeta = await live.metadata({ rootId: liveRoot, relativePath: 'Проект/Заменяемый.docx' });
    check(replaced.replaced === true && await read('Проект/Заменяемый.docx') === 'новое содержимое', '«Заменить» записывает содержимое черновика поверх существующего файла');
    check(mergedMeta.fileId === oldMeta.fileId && mergedMeta.tags.includes('старый тег') && mergedMeta.tags.includes('новый тег') && mergedMeta.projectIds.includes('pz') && mergedMeta.revision === 'Старая', 'При замене файл остаётся тем же: теги объединяются, ревизия существующего сохраняется');
    check((await fs.readdir(path.join(undoData, 'windows-files-recovery'))).length > 0 && (await live.list(lProject)).entries.find(item => item.name === 'Заменяемый.docx')?.storage === 'windows', 'Прежнее содержимое сохранено в снимке восстановления; черновик стал опубликованным файлом');
    const kind = await live.createDraft(lProject, 'Папка-б.txt', text('x')); await fs.mkdir(path.join(desktop, 'Проект', 'Папка-б.txt'));
    await rejects(() => live.publishDraft(kind.ref, { [kind.ref.draftId!]: 'replace' }), 'KIND_MISMATCH', 'Файл нельзя «заменить» на месте папки');
    check((await planPublication(live, kind.ref)).items[0].replaceable === false, 'План помечает такую замену как невозможную');

    // дерево: слияние папок и выбор по каждому объекту
    const tree = await live.createDraftFolder(lProject, 'Пакет');
    const treeA = await live.createDraft(tree.ref, 'a.txt', text('новый a')); const treeB = await live.createDraft(tree.ref, 'b.txt', text('новый b'));
    const treeSub = await live.createDraftFolder(tree.ref, 'Вложенная'); const treeC = await live.createDraft(treeSub.ref, 'c.txt', text('новый c'));
    await fs.mkdir(path.join(desktop, 'Проект', 'Пакет', 'Вложенная'), { recursive: true });
    await put('Проект/Пакет/a.txt', 'старый a'); await put('Проект/Пакет/z.txt', 'только в Windows'); await put('Проект/Пакет/Вложенная/c.txt', 'старый c');
    const treePlan = await planPublication(live, tree.ref);
    const planOf = (id?: string) => treePlan.items.find(item => item.draftId === id)!;
    check(planOf(tree.ref.draftId).status === 'collision' && planOf(tree.ref.draftId).replaceable && planOf(treeA.ref.draftId).status === 'collision' && planOf(treeA.ref.draftId).underMergedFolder === true && planOf(treeB.ref.draftId).status === 'free' && planOf(treeC.ref.draftId).status === 'collision', 'План дерева: папка совпала, внутри отмечены совпавшие файлы и свободные; результат проверяется как при слиянии');
    check(treePlan.collisions === 4 && planOf(treeSub.ref.draftId).status === 'collision' && planOf(treeA.ref.draftId).suggestedName === 'a (2).txt', 'Для каждого совпадения предложено своё свободное имя');
    await rejects(() => live.publishDraftTree(tree.ref), 'EEXIST', 'Дерево без выбора по-прежнему отказывает при занятой папке');
    const merged = await live.publishDraftTree(tree.ref, { [tree.ref.draftId!]: 'replace', [treeA.ref.draftId!]: 'keepBoth', [treeSub.ref.draftId!]: 'replace', [treeC.ref.draftId!]: 'skip' }) as any;
    check(merged.complete && merged.skipped === 1 && merged.published >= 2, 'Дерево публикуется со слиянием: пропущенное считается, а не ошибкой');
    check(await read('Проект/Пакет/a.txt') === 'старый a' && await read('Проект/Пакет/a (2).txt') === 'новый a' && await read('Проект/Пакет/b.txt') === 'новый b' && await read('Проект/Пакет/z.txt') === 'только в Windows' && await read('Проект/Пакет/Вложенная/c.txt') === 'старый c', 'Слияние: чужое осталось, «оставить оба» дало вторую копию, «пропустить» не тронуло файл, новое добавилось');
    check(!!(await live.list(lProject)).entries.find(item => item.name === 'Пакет' && item.storage === 'windows'), 'Папка-черновик после публикации — обычная папка Windows');
    const tree2 = await live.createDraftFolder(lProject, 'Пакет 2'); const tree2File = await live.createDraft(tree2.ref, 'файл.txt', text('в новую'));
    await fs.mkdir(path.join(desktop, 'Проект', 'Пакет 2')); await put('Проект/Пакет 2/файл.txt', 'прежний');
    const withReplace = await live.publishDraftTree(tree2.ref, { [tree2.ref.draftId!]: 'replace', [tree2File.ref.draftId!]: 'replace' }) as any;
    check(withReplace.complete && await read('Проект/Пакет 2/файл.txt') === 'в новую', '«Заменить» для файла в слитой папке заменяет содержимое через обычное сохранение');
    const tree3 = await live.createDraftFolder(lProject, 'Пакет 3'); await live.createDraft(tree3.ref, 'x.txt', text('x'));
    await fs.mkdir(path.join(desktop, 'Проект', 'Пакет 3'));
    const keepFolder = await live.publishDraftTree(tree3.ref, { [tree3.ref.draftId!]: 'keepBoth' }) as any;
    check(keepFolder.ref.relativePath === 'Проект/Пакет 3 (2)' && await read('Проект/Пакет 3 (2)/x.txt') === 'x' && (await fs.readdir(path.join(desktop, 'Проект', 'Пакет 3'))).length === 0, '«Оставить оба» для папки создаёт «Пакет 3 (2)» и не вмешивается в существующую');
    const tree4 = await live.createDraftFolder(lProject, 'Пакет 4'); await fs.mkdir(path.join(desktop, 'Проект', 'Пакет 4'));
    const skipTree = await live.publishDraftTree(tree4.ref, { [tree4.ref.draftId!]: 'skip' }) as any;
    check(skipTree.skipped === 1 && skipTree.published === 0 && !!live.state.data.drafts[tree4.ref.draftId!] && !live.state.data.drafts[tree4.ref.draftId!].publishedRef, '«Пропустить» для папки оставляет черновую папку нетронутой');
    // недоступные пути в плане
    const orphanParent = await live.createDraftFolder(lProject, 'Родитель'); const orphan = await live.createDraft(orphanParent.ref, 'ребёнок.txt', text('р'));
    const orphanPlan = await planPublication(live, orphan.ref);
    check(orphanPlan.blocked === 1 && orphanPlan.items[0].status === 'blocked' && /родительскую папку/u.test(orphanPlan.items[0].reason!), 'Ребёнок неопубликованной папки: в плане «недоступно», причина названа');
    const lost = await live.createDraftFolder(lProject, 'Потеряется'); await fs.mkdir(path.join(desktop, 'Временная'));
    const lostDraft = await live.createDraft({ rootId: liveRoot, relativePath: 'Временная' }, 'нигде.txt', text('н'));
    await fs.rm(path.join(desktop, 'Временная'), { recursive: true });
    const lostPlan = await planPublication(live, lostDraft.ref);
    check(lostPlan.blocked === 1 && lostPlan.items[0].status === 'blocked' && lostPlan.items[0].reason!.length > 0, 'Если папка назначения исчезла, план называет это недоступным путём'); void lost;
    // ---- importPaths: файлы, брошенные из Проводника Windows
    const external = path.join(sandbox, 'из проводника'); await fs.mkdir(path.join(external, 'Папка', 'Вложенная'), { recursive: true });
    await fs.writeFile(path.join(external, 'внешний.txt'), 'внешний файл'); await fs.writeFile(path.join(external, 'второй.txt'), 'второй');
    await fs.writeFile(path.join(external, 'Папка', 'в папке.txt'), 'в папке'); await fs.writeFile(path.join(external, 'Папка', 'Вложенная', 'глубоко.txt'), 'глубоко');
    await fs.mkdir(path.join(desktop, 'Приём')); const intake = L('Приём');
    const tickets = new DropTickets();
    const dropped = [path.join(external, 'внешний.txt'), path.join(external, 'Папка'), path.join(external, 'второй.txt')];
    await rejects(async () => tickets.register(1, 'короткий', dropped), 'INVALID_REQUEST', 'Билет перетаскивания проверяется по форме');
    await rejects(async () => tickets.register(1, 'ticket-relative', ['относительный/путь.txt']), 'INVALID_REQUEST', 'Относительный путь в билет не принимается');
    await rejects(() => importDropped(live, tickets, 1, 'ticket-unknown', intake, undefined, undefined), 'DROP_EXPIRED', 'Без настоящего билета копировать нечего: страница не может сама назвать путь');
    tickets.register(1, 'ticket-one-0001', dropped);
    await rejects(() => importDropped(live, tickets, 2, 'ticket-one-0001', intake, undefined, undefined), 'DROP_EXPIRED', 'Билет другого окна не принимается');
    const first = await importDropped(live, tickets, 1, 'ticket-one-0001', intake, undefined, 'drop-1');
    check(first.complete && first.imported.length === 3 && !first.collisions.length && await read('Приём/внешний.txt') === 'внешний файл' && await read('Приём/Папка/Вложенная/глубоко.txt') === 'глубоко', 'Файлы и папка копируются в папку назначения целиком');
    check(await fs.readFile(path.join(external, 'внешний.txt'), 'utf8') === 'внешний файл', 'Исходные файлы остаются на месте: это копия, а не перенос');
    check(first.imported.every(item => item.ref.relativePath.startsWith('Приём/')) && !JSON.stringify(first).includes(external), 'Ответ несёт capability, а не пути брошенных файлов');
    await rejects(() => importDropped(live, tickets, 1, 'ticket-one-0001', intake, undefined, undefined), 'DROP_EXPIRED', 'Погашенный билет повторно не работает');
    await undoLast(live);
    check(!(await exists('Приём/внешний.txt')) && !(await exists('Приём/Папка')) && !(await exists('Приём/второй.txt')), 'Импорт из трёх объектов отменяется одним Ctrl+Z');
    await redoLast(live);
    check(await exists('Приём/Папка/в папке.txt'), 'И повторяется целиком');
    // коллизии: ничего не заменяется молча
    await fs.writeFile(path.join(external, 'внешний.txt'), 'ДРУГОЕ содержимое внешнего'); await fs.writeFile(path.join(external, 'свежий.txt'), 'свежий');
    tickets.register(1, 'ticket-two-0002', [path.join(external, 'внешний.txt'), path.join(external, 'Папка'), path.join(external, 'свежий.txt')]);
    const second = await importDropped(live, tickets, 1, 'ticket-two-0002', intake, undefined, undefined);
    check(!second.complete && second.collisions.map(item => `${item.index}:${item.name}:${item.kind}`).join() === '0:внешний.txt:file,1:Папка:directory' && second.imported.map(item => item.name).join() === 'свежий.txt', 'Свободные объекты копируются сразу, совпавшие возвращаются списком коллизий');
    check(second.collisions[0].incoming.size === Buffer.byteLength('ДРУГОЕ содержимое внешнего') && second.collisions[0].existing.size === Buffer.byteLength('внешний файл') && await read('Приём/внешний.txt') === 'внешний файл', 'В коллизии видны размер и дата обеих сторон, а существующий файл не тронут');
    const resolved = await importDropped(live, tickets, 1, 'ticket-two-0002', intake, { 0: 'replace', 1: 'replace' }, undefined);
    check(resolved.complete && resolved.imported.map(item => item.name).join() === 'внешний.txt' && resolved.failed.length === 1 && resolved.failed[0].code === 'MERGE_UNSUPPORTED', '«Заменить» заменяет файл, а слияние папок честно не поддерживается и названо ошибкой, не молчанием');
    check(await read('Приём/внешний.txt') === 'ДРУГОЕ содержимое внешнего' && (await fs.readdir(path.join(undoData, 'windows-files-recovery'))).length >= 2, 'Замена идёт обычным сохранением: прежнее содержимое осталось в снимке восстановления');
    tickets.register(1, 'ticket-three-003', [path.join(external, 'внешний.txt'), path.join(external, 'Папка')]);
    await importDropped(live, tickets, 1, 'ticket-three-003', intake, undefined, undefined);
    const keep = await importDropped(live, tickets, 1, 'ticket-three-003', intake, { 0: 'keepBoth', 1: 'skip' }, undefined);
    check(keep.complete && keep.imported[0].name === 'внешний (2).txt' && keep.skipped.join() === 'Папка' && await read('Приём/внешний (2).txt') === 'ДРУГОЕ содержимое внешнего', '«Оставить оба» даёт «внешний (2).txt», «Пропустить» не копирует');
    await rejects(() => importDropped(live, tickets, 1, 'ticket-three-003', intake, { x: 'skip' } as any, undefined), 'DROP_EXPIRED', 'Погашенный билет не принимает и новых решений');
    tickets.register(1, 'ticket-four-0004', [path.join(external, 'внешний.txt')]);
    await rejects(() => importDropped(live, tickets, 1, 'ticket-four-0004', intake, { x: 'skip' } as any, undefined), 'INVALID_REQUEST', 'Решения по коллизиям проверяются по форме');
    // Файловая символьная ссылка в Windows требует права SeCreateSymbolicLink: без него проверка названа пропущенной, а не пройденной.
    let fileLink = true;
    try { await fs.symlink(path.join(outside, 'секрет отчёт.txt'), path.join(external, 'ссылка.txt')); }
    catch (error: any) { if (error.code !== 'EPERM') throw error; fileLink = false; console.log('SKIP ссылка среди брошенных файлов: у этой учётной записи нет права создавать символьные ссылки'); }
    tickets.register(1, 'ticket-five-0005', [...(fileLink ? [path.join(external, 'ссылка.txt')] : []), path.join(sandbox, 'не существует.txt')]);
    const linked = await importDropped(live, tickets, 1, 'ticket-five-0005', intake, undefined, undefined);
    check(linked.complete && linked.imported.length === 0 && linked.failed.map(item => item.code).join() === (fileLink ? 'LINK_BLOCKED,ENOENT' : 'ENOENT') && !(await exists('Приём/ссылка.txt')), 'Ссылка и исчезнувший файл — отказы по объектам, остальное не страдает');
    tickets.register(1, 'ticket-six-0006', [path.join(external, 'внешний.txt')]);
    await rejects(() => importDropped(live, tickets, 1, 'ticket-six-0006', { rootId: liveRoot, relativePath: '../outside' }, undefined, undefined), 'INVALID_NAME', 'Назначение вне подключённой папки отклоняется');
    const virtualTarget = await live.createDraftFolder(lProject, 'Черновая цель');
    await rejects(() => importDropped(live, tickets, 1, 'ticket-six-0006', virtualTarget.ref, undefined, undefined), 'DRAFT_FOLDER_UNSUPPORTED', 'В папку-черновик бросить файл из Windows нельзя');
    tickets.register(1, 'ticket-seven-007', [path.join(desktop, 'Приём')]);
    const itself = await importDropped(live, tickets, 1, 'ticket-seven-007', intake, undefined, undefined);
    check(itself.failed[0]?.code === 'RECURSIVE_TARGET' && !(await exists('Приём/Приём')), 'Папка не копируется внутрь себя');
    const stale = new DropTickets(); stale.register(1, 'ticket-late-0008', dropped);
    check(stale.get(1, 'ticket-late-0008').paths.length === 3, 'Свежий билет читается');
    await rejects(async () => { const clock = { now: Date.now() }; const aging = new DropTickets(() => clock.now); aging.register(1, 'ticket-aged-0009', dropped); clock.now += 6 * 60_000; aging.get(1, 'ticket-aged-0009'); }, 'DROP_EXPIRED', 'Билет живёт пять минут');

    // ---- startDrag: наружу уходит только опубликованное
    const draggable = await live.createDraft(lProject, 'Тащить.md', text('черновик для drag'));
    await rejects(() => live.startDrag(7, [draggable.ref]), 'DRAFT_NOT_PUBLISHED', 'Черновик наружу не вытаскивается: ошибка DRAFT_NOT_PUBLISHED');
    await rejects(() => live.startDrag(7, [L('Проект/Док.docx'), draggable.ref]), 'DRAFT_NOT_PUBLISHED', 'Смесь с черновиком отклоняется целиком');
    check(dragged.length === 0, 'При отказе перетаскивание не начинается вообще');
    const out = await live.startDrag(7, [L('Проект/Док.docx'), L('Приём')]);
    check(out.count === 2 && dragged.length === 1 && dragged[0].owner === 7 && dragged[0].files[0] === path.join(await fs.realpath(desktop), 'Проект', 'Док.docx') && out.dragging === true, 'Опубликованные файл и папка передаются перетаскиванию с настоящими путями — только main-процессу');
    await live.publishDraft(draggable.ref);
    check((await live.startDrag(7, [draggable.ref])).count === 1, 'Опубликованный черновик перетаскивается как обычный файл');
    await rejects(() => live.startDrag(7, []), 'INVALID_REQUEST', 'Пустой набор не перетаскивается');
    await rejects(() => live.startDrag(7, [L('Проект/ссылка')]), 'LINK_BLOCKED', 'Ссылка наружу не вытаскивается');
    const mute = await WindowsFilesService.create({ ...deps, userData: path.join(sandbox, 'mute'), startDrag: undefined });
    const muteRoot = (await mute.roots())[0].id;
    await rejects(() => mute.startDrag(1, [{ rootId: muteRoot, relativePath: 'Проект' }]), 'NOT_SUPPORTED', 'Без поддержки окна команда честно отвечает «не поддерживается»');
    mute.close();
  } finally { service?.close(); await fs.rm(sandbox, { recursive: true, force: true }); }
}

main().then(explorerScenarios).then(() => console.log(`EXPLORER SCENARIOS PASSED (${passed})`)).catch(error => { console.error(error); process.exitCode = 1; });
