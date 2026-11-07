/**
 * Работа документооборота с файлами на компьютере (docs/docflow-program.md, 4.1
 * и 7.3): где файл лежит относительно папок проекта, его отпечаток, перенос в
 * рабочую папку или папку возвратов. Всё идёт существующими командами моста,
 * переносы одной «группой» — Проводник отменяет их своим журналом отмены.
 */
import { windowsFilesRequest, type WindowsFilesResponse, type WindowsFileEntry, type WindowsFileRef, type WindowsLocationKeys } from './windowsFiles';
import { nearestBinding, type ProjectFolderBinding } from './projectFolderBindings';
import { relativeInBinding } from '../../shared/docflow/links';

export type ListPage = { entries: WindowsFileEntry[]; nextOffset: number | null };

export interface PlacedFile { binding: ProjectFolderBinding; depth: number; relativePath: string }

/** Цепочка ключей места файла (сам файл → родители → корень ресурса); null — не сетевое место. */
export async function chainOfRef(ref: WindowsFileRef): Promise<string[] | null> {
  const answer = await windowsFilesRequest<WindowsLocationKeys>({ action: 'locationKeys', refs: [ref] });
  const chain = answer.ok ? answer.data.chains[0] : null;
  return chain ? chain.map((index) => answer.ok ? answer.data.keys[index] : '') : null;
}

/** В какой привязанной папке проекта лежит файл и какой у него путь внутри неё. */
export async function placeInProject(ref: WindowsFileRef, bindings: ProjectFolderBinding[]): Promise<PlacedFile | null> {
  const chain = await chainOfRef(ref);
  const found = nearestBinding(bindings, chain);
  if (!found || found.depth < 1) return null;
  const relativePath = relativeInBinding(ref.relativePath, found.depth);
  return relativePath ? { binding: found.binding, depth: found.depth, relativePath } : null;
}

export async function describeFile(ref: WindowsFileRef): Promise<{ name: string; size: number; sha256: string } | null> {
  const [stat, hash] = await Promise.all([
    windowsFilesRequest<WindowsFileEntry>({ action: 'stat', ref }),
    windowsFilesRequest<{ sha256: string; size: number }>({ action: 'fileHash', ref }),
  ]);
  if (!stat.ok || !hash.ok || stat.data.kind !== 'file') return null;
  return { name: stat.data.name, size: hash.data.size, sha256: hash.data.sha256 };
}

/** Где на этом компьютере лежит привязанная папка: по переносимому месту из привязки. Null — не найдена среди корней. */
export async function folderOfBinding(binding: ProjectFolderBinding): Promise<WindowsFileRef | null> {
  if (!binding.locator) return null;
  const answer = await windowsFilesRequest<WindowsFileRef | null>({ action: 'resolvePortableFolder', locator: binding.locator });
  return answer.ok ? answer.data : null;
}

const join = (base: string, name: string) => [base, name].filter(Boolean).join('/');

/** Имя, свободное в папке, в стиле Windows: «Отчёт (2).pdf». */
export async function freeName(folder: WindowsFileRef, name: string): Promise<string> {
  const taken = new Set<string>();
  let offset: number | null = 0;
  while (offset !== null) {
    const answer: WindowsFilesResponse<ListPage> = await windowsFilesRequest<ListPage>({ action: 'list', ref: folder, offset, limit: 500 });
    if (!answer.ok) break;
    for (const entry of answer.data.entries) taken.add(entry.name.toLowerCase());
    offset = answer.data.nextOffset;
  }
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; n < 1000; n++) if (!taken.has(`${stem} (${n})${ext}`.toLowerCase())) return `${stem} (${n})${ext}`;
  return `${stem} (${Date.now()})${ext}`;
}

/** Подпапки по маске структуры внутри папки проекта; существующие не пересоздаются. */
export async function ensureFolders(base: WindowsFileRef, path: string, group: string): Promise<WindowsFileRef> {
  let current = base;
  for (const part of path.split('/').filter(Boolean)) {
    const next = { ...current, relativePath: join(current.relativePath, part) };
    const exists = await windowsFilesRequest<WindowsFileEntry>({ action: 'stat', ref: next });
    if (!exists.ok) {
      const made = await windowsFilesRequest({ action: 'mkdir', parent: current, name: part, group });
      if ('error' in made) throw new Error(made.error.message);
    } else if (exists.data.kind !== 'directory') throw new Error(`«${part}» — файл, а нужна папка`);
    current = next;
  }
  return current;
}

export interface MovePlan { target: WindowsFileRef; folderPath: string; name: string; renamed: boolean }

/** Перенос с проверкой отпечатка: файл изменили после выбора — перенос откажет, ничего не сломав. */
export async function moveFile(ref: WindowsFileRef, folder: WindowsFileRef, name: string, baseSha256: string, group: string): Promise<WindowsFileRef> {
  const answer = await windowsFilesRequest<{ ref?: WindowsFileRef }>({ action: 'move', ref, parent: folder, name, baseSha256, group });
  if ('error' in answer) throw new Error(answer.error.message);
  return answer.data.ref || { rootId: folder.rootId, relativePath: join(folder.relativePath, name) };
}

export async function renameFile(ref: WindowsFileRef, name: string, group: string): Promise<WindowsFileRef> {
  const answer = await windowsFilesRequest<{ ref: WindowsFileRef }>({ action: 'rename', ref, name, group });
  if ('error' in answer) throw new Error(answer.error.message);
  return answer.data.ref;
}

export const newGroup = (label: string) => `docflow-${label}-${Date.now().toString(36)}`;

/** Файл по связи на этом компьютере: привязанная папка + путь внутри неё. Null — папка не найдена среди корней. */
export async function refOfLink(link: { folderKey: string; relativePath: string }, bindings: ProjectFolderBinding[]): Promise<WindowsFileRef | null> {
  const binding = bindings.find((b) => b.locationKey === link.folderKey);
  const base = binding ? await folderOfBinding(binding) : null;
  return base ? { ...base, relativePath: join(base.relativePath, link.relativePath) } : null;
}

/** «Открыть» или «Показать в Проводнике»; причина отказа — готовым текстом для подсказки. */
export async function openLinked(link: { folderKey: string; relativePath: string }, bindings: ProjectFolderBinding[], how: 'open' | 'reveal'): Promise<string> {
  const ref = await refOfLink(link, bindings);
  if (!ref) return 'Папка проекта не найдена на этом компьютере: откройте её в Проводнике и привяжите заново.';
  const answer = await windowsFilesRequest({ action: how, ref });
  return 'error' in answer ? answer.error.message : '';
}
