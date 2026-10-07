import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { WindowsFileChoice, WindowsFileRef, WindowsImportCollision, WindowsImportResult } from '../../filesystem/contracts';
import { WindowsFilesError, isContained, joinRelative, validateWindowsName } from './paths';
import { fingerprint } from './undo';
import { existingAt, freeNameIn, type Existing } from './publishing';
import { copyWindowsTree, inspectWindowsTree } from './tree';
import type { WindowsFilesService } from './service';

const TTL_MS = 5 * 60_000;
const MAX_PATHS = 500;
const MAX_TICKETS = 8;
const MAX_REPLACE_BYTES = 64 * 1024 * 1024;

interface Ticket { owner: number; at: number; paths: string[]; done: Set<number> }

/**
 * Билеты на файлы, брошенные в окно из Проводника Windows.
 *
 * Путь к брошенному файлу знает только preload: он видит настоящее событие
 * drop (isTrusted) и спрашивает путь у Electron. Страница получает билет и
 * имена, но не пути, и не может выдумать билет: для этого нужен настоящий
 * жест человека, а канал с путями ей не открыт. Иначе «импорт по пути» стал бы
 * копированием любого файла диска в читаемую папку.
 */
export class DropTickets {
  private tickets = new Map<string, Ticket>();
  constructor(private now: () => number = Date.now) {}
  register(owner: number, ticket: unknown, paths: unknown): void {
    if (typeof ticket !== 'string' || !/^[\w-]{8,64}$/u.test(ticket)) throw new WindowsFilesError('INVALID_REQUEST', 'Некорректный билет перетаскивания.');
    if (!Array.isArray(paths) || !paths.length || paths.length > MAX_PATHS) throw new WindowsFilesError('INVALID_REQUEST', 'Перетащите не больше 500 объектов за раз.');
    const clean = paths.map(item => {
      if (typeof item !== 'string' || !path.isAbsolute(item) || item.length > 32_767 || /[\u0000-\u001f]/u.test(item)) throw new WindowsFilesError('INVALID_REQUEST', 'Некорректный путь перетаскиваемого файла.');
      return item;
    });
    for (const [id, value] of this.tickets) if (this.now() - value.at > TTL_MS) this.tickets.delete(id);
    const own = [...this.tickets.entries()].filter(([, value]) => value.owner === owner);
    if (own.length >= MAX_TICKETS) this.tickets.delete(own[0][0]);
    this.tickets.set(ticket, { owner, at: this.now(), paths: clean, done: new Set() });
  }
  get(owner: number, ticket: unknown): Ticket {
    const found = typeof ticket === 'string' ? this.tickets.get(ticket) : undefined;
    if (!found || found.owner !== owner || this.now() - found.at > TTL_MS) throw new WindowsFilesError('DROP_EXPIRED', 'Перетаскивание устарело. Бросьте файлы в окно ещё раз.');
    return found;
  }
  consume(ticket: string) { this.tickets.delete(ticket); }
  closeOwner(owner: number) { for (const [id, value] of this.tickets) if (value.owner === owner) this.tickets.delete(id); }
}

const sameFile = async (a: string, b: string) => {
  const [first, second] = await Promise.all([fs.realpath(a), fs.realpath(b).catch(() => '')]);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
};

/**
 * Копирует брошенное в папку назначения. Совпадение имени ничего не заменяет
 * молча: объект уходит в список коллизий, а решение («Заменить», «Пропустить»,
 * «Оставить оба») приходит вторым вызовом с тем же билетом по номеру объекта.
 * Объекты без совпадений копируются сразу — как в Windows, где окно конфликтов
 * спрашивает только о спорном.
 */
export async function importDropped(service: WindowsFilesService, tickets: DropTickets, owner: number, ticketId: unknown, parent: WindowsFileRef,
  resolutions: unknown, group: string | undefined): Promise<WindowsImportResult> {
  const ticket = tickets.get(owner, ticketId);
  const choices: Record<string, WindowsFileChoice> = {};
  if (resolutions !== undefined) {
    if (!resolutions || typeof resolutions !== 'object' || Array.isArray(resolutions)) throw new WindowsFilesError('INVALID_REQUEST', 'Решения по совпадающим именам указаны неверно.');
    for (const [key, value] of Object.entries(resolutions as Record<string, unknown>)) {
      if (!/^\d{1,3}$/u.test(key) || (value !== 'replace' && value !== 'skip' && value !== 'keepBoth')) throw new WindowsFilesError('INVALID_REQUEST', 'Решения по совпадающим именам указаны неверно.');
      choices[key] = value;
    }
  }
  const destination = service.resolveRef(parent);
  if (destination.draftId) throw new WindowsFilesError('DRAFT_FOLDER_UNSUPPORTED', 'В папку Flux нельзя бросить файл из Windows. Сначала опубликуйте папку или бросьте файл в папку Windows.');
  const destinationName = await service.filename({ rootId: destination.rootId, relativePath: destination.relativePath });
  if (!(await fs.stat(destinationName)).isDirectory()) throw new WindowsFilesError('NOT_DIRECTORY', 'Бросьте файлы в папку.');
  const result: WindowsImportResult = { imported: [], collisions: [], skipped: [], failed: [], complete: false };

  for (let index = 0; index < ticket.paths.length; index++) {
    if (ticket.done.has(index)) continue;
    const source = ticket.paths[index]; const name = path.basename(source);
    const fail = (error: any) => { ticket.done.add(index); result.failed.push({ name, code: typeof error?.code === 'string' ? error.code : 'FILESYSTEM_ERROR', message: error instanceof WindowsFilesError ? error.message : 'Не удалось скопировать объект. Исходный файл не тронут.' }); };
    try {
      const stat = await fs.lstat(source);
      // Ссылка в дереве не обходится автоматически — то же правило, что у копирования внутри Flux.
      if (stat.isSymbolicLink()) throw new WindowsFilesError('LINK_BLOCKED', 'Ссылку или junction нельзя скопировать: подключите её папку отдельно.');
      const directory = stat.isDirectory();
      if (!directory && !stat.isFile()) throw new WindowsFilesError('UNSUPPORTED_ENTRY', 'Этот тип объекта копируется средствами Windows.');
      validateWindowsName(name);
      let targetName = name;
      let target: WindowsFileRef = { rootId: destination.rootId, relativePath: joinRelative(destination.relativePath, targetName) };
      const existing: Existing | null = await existingAt(service, target);
      let replace = false;
      if (existing) {
        const choice = choices[String(index)];
        if (!choice) {
          const collision: WindowsImportCollision = { index, name, kind: directory ? 'directory' : 'file',
            incoming: { size: stat.size, modifiedAt: stat.mtime.toISOString() }, existing: { size: existing.size, modifiedAt: existing.modifiedAt, kind: existing.kind === 'directory' ? 'directory' : 'file' } };
          result.collisions.push(collision); continue;
        }
        if (choice === 'skip') { ticket.done.add(index); result.skipped.push(name); continue; }
        if (choice === 'keepBoth') {
          targetName = await freeNameIn(service, destination, name, directory);
          target = { rootId: destination.rootId, relativePath: joinRelative(destination.relativePath, targetName) };
        } else {
          if (directory || existing.kind !== 'file') throw new WindowsFilesError('MERGE_UNSUPPORTED', 'Слияние папок при перетаскивании не поддерживается. Выберите «Оставить оба» или «Пропустить».');
          if (await sameFile(source, await service.filename(target))) { ticket.done.add(index); result.skipped.push(name); continue; }
          if (stat.size > MAX_REPLACE_BYTES) throw new WindowsFilesError('FILE_TOO_LARGE', 'Заменить можно файл до 64 МБ.');
          replace = true;
        }
      }
      if (replace) {
        // Замена — обычное сохранение с проверкой версии: прежнее содержимое остаётся в снимке восстановления.
        const current = await service.read(target);
        await service.write(target, (await fs.readFile(source)).toString('base64'), current.sha256);
        result.imported.push({ name: targetName, ref: target });
      } else {
        const targetFile = await service.filename(target, true);
        if (directory) {
          // Назначение уже канонично (realpath в resolveSafePath), путь брошенной папки — нет:
          // Windows отдаёт его и коротким именем 8.3 (RUNNER~1), и в другом регистре. Без
          // приведения обеих сторон «внутрь себя» не узнаётся, и папка копируется в саму себя
          if (isContained(await fs.realpath(source), targetFile)) throw new WindowsFilesError('RECURSIVE_TARGET', 'Нельзя скопировать папку внутрь неё самой.');
          await copyWindowsTree(source, targetFile, await inspectWindowsTree(source));
        } else await fs.copyFile(source, targetFile, constants.COPYFILE_EXCL);
        const entry = await service.entry(target);
        await service.state.history(entry.fileId, 'import', target.relativePath);
        await service.record(`Копирование «${targetName}» из Windows`, { kind: 'create', at: target, fingerprint: await fingerprint(service, target) }, group ? { group } : {});
        result.imported.push({ name: targetName, ref: target });
      }
      ticket.done.add(index);
    } catch (error) { fail(error); }
  }
  // Событие несёт папку объекта: хватает любого из скопированных.
  if (result.imported.length) service.changed(result.imported[0].ref);
  result.complete = !result.collisions.length;
  if (result.complete) tickets.consume(ticketId as string);
  return result;
}
