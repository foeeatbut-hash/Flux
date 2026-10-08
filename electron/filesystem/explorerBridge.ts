import type { WindowsFileRef, WindowsFilesRequest, WindowsSearchEvent } from '../../filesystem/contracts';
import { WindowsFilesError } from './paths';
import type { WindowsFilesService } from './service';
import { SearchRegistry } from './search';
import { listChildFolders } from './children';
import { ViewStateStore } from './viewState';
import { DropTickets, importDropped } from './importPaths';
import { planPublication } from './publishing';
import { undoLast, redoLast } from './undo';
import type { ShellCommands } from './shellCommands';

/**
 * Команды Проводника Windows 11 поверх службы файлов. ipc.ts передаёт сюда всё,
 * чего не знает сам; здесь же проверяется форма запроса — renderer не доверенный.
 *
 * Изменяющие команды перечислены отдельно: ipc.ts требует для них mayWrite.
 * Вид папки (viewState) к ним не относится — это настройка оформления, она
 * пишется только в userData и файлов не касается.
 */
export const EXPLORER_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'quickAccessPin', 'shellMenuInvoke', 'recycleBinRestore', 'recycleBinPurge', 'recycleBinEmpty',
  // Перетаскивание наружу: Windows-получатель сам решает, копировать или переносить, поэтому право на запись нужно и здесь.
  'startDrag', 'importPaths', 'undo', 'redo',
]);
const READ_ACTIONS = new Set(['search', 'searchCancel', 'children', 'quickAccess', 'cloudRoots', 'thumbnail', 'openWithList', 'openWith', 'shellMenu', 'shellMenuClose',
  'recycleBin', 'systemProperties', 'undoState', 'publishPlan', 'viewStateGet', 'viewStateSet', 'viewStateDelete']);
export const isExplorerAction = (action: string) => READ_ACTIONS.has(action) || EXPLORER_WRITE_ACTIONS.has(action);

export interface ExplorerBridgeDeps {
  service: WindowsFilesService;
  shell: ShellCommands;
  viewState: ViewStateStore;
  /** Доставка страницы поиска в окно owner. */
  emitSearch: (owner: number, event: WindowsSearchEvent) => void;
}

const ref = (value: unknown): WindowsFileRef => {
  const item = value as WindowsFileRef;
  if (!item || typeof item !== 'object' || typeof item.rootId !== 'string' || typeof item.relativePath !== 'string' || (item.draftId !== undefined && typeof item.draftId !== 'string')) throw new WindowsFilesError('INVALID_REQUEST', 'Не указан файл.');
  return item;
};
const refs = (value: unknown): WindowsFileRef[] => {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new WindowsFilesError('INVALID_REQUEST', 'Выберите от 1 до 100 объектов.');
  return value.map(ref);
};
const group = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[\w.:-]{1,64}$/u.test(value)) throw new WindowsFilesError('INVALID_REQUEST', 'Неверный номер группы отмены.');
  return value;
};

export class ExplorerBridge {
  readonly search = new SearchRegistry();
  readonly drops = new DropTickets();
  constructor(private deps: ExplorerBridgeDeps) {}

  /** preload → main: пути брошенных файлов. Вызывается только из канала, закрытого для страницы. */
  registerDrop(owner: number, ticket: unknown, paths: unknown) { this.drops.register(owner, ticket, paths); }
  closeOwner(owner: number) { this.search.closeOwner(owner); this.drops.closeOwner(owner); this.deps.shell.closeOwner(owner); }

  async handle(request: WindowsFilesRequest, owner: number): Promise<unknown> {
    const { service, shell, viewState } = this.deps;
    const r = request as any;
    switch (request.action) {
      case 'search': return this.search.start(service, owner, { ref: ref(r.ref), requestId: r.requestId, query: r.query, filters: r.filters, limits: r.limits }, this.deps.emitSearch);
      case 'searchCancel': return { canceled: this.search.cancel(owner, r.requestId) };
      case 'children': return listChildFolders(service, ref(r.ref), r.peek === true);
      case 'quickAccess': return shell.quickAccess();
      case 'quickAccessPin': return shell.pin(ref(r.ref), r.pinned);
      case 'cloudRoots': return shell.cloudRoots();
      case 'systemProperties': return shell.fileProperties(ref(r.ref));
      case 'thumbnail': return shell.thumbnail(ref(r.ref), r.size, r.thumbnailOnly === true);
      case 'openWithList': return shell.openWithList(owner, ref(r.ref));
      case 'openWith': return shell.openWith(owner, ref(r.ref), r.handlerId);
      case 'shellMenu': return shell.shellMenu(owner, refs(r.refs), r.extended === true);
      case 'shellMenuInvoke': return shell.shellMenuInvoke(owner, r.token, r.commandId, r.label);
      case 'shellMenuClose': return shell.shellMenuClose(owner, r.token);
      case 'recycleBin': return shell.recycleBin(owner);
      case 'recycleBinRestore': return shell.recycleBinRestore(owner, r.ids);
      case 'recycleBinPurge': return shell.recycleBinPurge(owner, r.ids);
      case 'recycleBinEmpty': return shell.recycleBinEmpty();
      case 'startDrag': return service.startDrag(owner, refs(r.refs));
      case 'importPaths': return importDropped(service, this.drops, owner, r.ticket, ref(r.parent), r.resolutions, group(r.group));
      case 'undoState': return service.journal.state();
      case 'undo': return undoLast(service);
      case 'redo': return redoLast(service);
      case 'publishPlan': return planPublication(service, ref(r.ref));
      case 'viewStateGet': return viewState.get(r.keys);
      case 'viewStateSet': return viewState.set(r.entries);
      case 'viewStateDelete': return viewState.delete(r.keys);
      default: throw new WindowsFilesError('INVALID_ACTION', 'Команда проводника неизвестна.');
    }
  }
}

/** Параметр group у существующих команд: проверяется здесь, чтобы ipc.ts не знал о журнале отмены. */
export const undoGroup = group;
