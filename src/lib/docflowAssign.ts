/**
 * Назначение файла строке ВДР: куда файл ляжет и как он туда попадёт
 * (docs/docflow-program.md, 4.1 и 7.3). Сначала план — что будет перемещено и
 * переименовано, показывается до подтверждения; потом исполнение одной
 * «группой» Проводника, которую его журнал отмены откатывает целиком.
 */
import type { DocflowConfig } from '../../shared/docflow/config';
import { purposeAllows, type FolderPurpose, type LinkRole } from '../../shared/docflow/links';
import { placementFolder, type RowForCheck } from '../../shared/docflow/nameMask';
import type { ProjectFolderBinding } from './projectFolderBindings';
import { windowsFilesRequest, type WindowsFilesResponse, type WindowsFileEntry, type WindowsFileRef } from './windowsFiles';
import { describeFile, ensureFolders, type ListPage, folderOfBinding, freeName, moveFile, placeInProject, renameFile, type PlacedFile } from './docflowFiles';

export const bindingsOfProject = (bindings: ProjectFolderBinding[], projectId: string) => bindings.filter((b) => b.projectId === projectId);
export const bindingFor = (bindings: ProjectFolderBinding[], projectId: string, purpose: FolderPurpose) => bindings.find((b) => b.projectId === projectId && b.purpose === purpose);

export interface FileSource { ref: WindowsFileRef; name: string; size: number; sha256: string; fileId: string; placed: PlacedFile | null }

/** Файл, выбранный человеком: отпечаток и место относительно папок проекта. */
export async function readSource(ref: WindowsFileRef, projectBindings: ProjectFolderBinding[]): Promise<FileSource | null> {
  const [info, stat, placed] = await Promise.all([
    describeFile(ref),
    windowsFilesRequest<WindowsFileEntry>({ action: 'stat', ref }),
    placeInProject(ref, projectBindings),
  ]);
  if (!info || !stat.ok) return null;
  return { ref, name: info.name, size: info.size, sha256: info.sha256, fileId: stat.data.fileId, placed };
}

/** После переименования вне Flux ссылка устарела: тот же файл находится по fileId в своей папке. */
export async function refindSource(source: FileSource): Promise<WindowsFileRef | null> {
  const parent = { ...source.ref, relativePath: source.ref.relativePath.split('/').slice(0, -1).join('/') };
  let offset: number | null = 0;
  while (offset !== null) {
    const answer: WindowsFilesResponse<ListPage> = await windowsFilesRequest<ListPage>({ action: 'list', ref: parent, offset, limit: 500 });
    if (!answer.ok) return null;
    const hit = answer.data.entries.find((e) => e.fileId === source.fileId && e.kind === 'file');
    if (hit) return { ...parent, relativePath: [parent.relativePath, hit.name].filter(Boolean).join('/') };
    offset = answer.data.nextOffset;
  }
  return null;
}

export interface PlacementPlan {
  /** Файл остаётся там, где лежит (уже в подходящей папке проекта). */
  inPlace: boolean;
  /** Привязанная папка, в которой файл окажется, и путь подпапки внутри неё. */
  binding: ProjectFolderBinding | null;
  folderPath: string;
  finalName: string;
  /** Переименовать до переноса (имя исправляется предложением ДО). */
  rename: boolean;
  error: string;
}

export function planPlacement(input: { source: FileSource; role: LinkRole; config: DocflowConfig; row: RowForCheck; revision: string; projectId: string; bindings: ProjectFolderBinding[]; finalName: string }): PlacementPlan {
  const { source, role, config, row, revision, projectId, bindings } = input;
  const rename = input.finalName !== source.name;
  const here = source.placed && source.placed.binding.projectId === projectId && purposeAllows(role, source.placed.binding.purpose) ? source.placed : null;
  if (role === 'file' && here) {
    const dir = here.relativePath.split('/').slice(0, -1).join('/');
    return { inPlace: true, binding: here.binding, folderPath: dir, finalName: input.finalName, rename, error: '' };
  }
  const purpose: FolderPurpose = role === 'remarks' ? 'returns' : 'work';
  const binding = bindingFor(bindings, projectId, purpose);
  if (!binding) return { inPlace: false, binding: null, folderPath: '', finalName: input.finalName, rename, error: `У проекта не назначена папка «${purpose === 'work' ? 'Рабочая' : 'Возвраты'}». В Проводнике: правой кнопкой по папке → «Привязать к проекту» → «Назначение».` };
  const folderPath = placementFolder(config, purpose, row, revision);
  if (role === 'remarks' && here?.binding.id === binding.id && source.placed) {
    // Файл уже в папке возвратов проекта — остаётся как есть
    return { inPlace: true, binding, folderPath: source.placed.relativePath.split('/').slice(0, -1).join('/'), finalName: input.finalName, rename: false, error: '' };
  }
  return { inPlace: false, binding, folderPath, finalName: input.finalName, rename, error: '' };
}

export interface PlacementResult { folderKey: string; relativePath: string; ref: WindowsFileRef; sha256: string; size: number; moved: boolean; finalName: string }

const joinPath = (a: string, b: string) => [a, b].filter(Boolean).join('/');

/** Исполнение плана: переименовать, создать подпапки, перенести. Любой отказ — исключение с понятным текстом, начатое откатывается журналом Проводника. */
export async function executePlacement(plan: PlacementPlan, source: FileSource, role: LinkRole, group: string): Promise<PlacementResult> {
  if (plan.error || !plan.binding) throw new Error(plan.error || 'Папка проекта не назначена');
  let ref = source.ref;
  if (plan.rename) ref = await renameFile(ref, plan.finalName, group);
  if (plan.inPlace) {
    const stored = source.placed!;
    const dir = stored.relativePath.split('/').slice(0, -1).join('/');
    const after = await describeFile(ref);
    return { folderKey: plan.binding.locationKey, relativePath: joinPath(dir, plan.finalName), ref, sha256: after?.sha256 || source.sha256, size: after?.size ?? source.size, moved: false, finalName: plan.finalName };
  }
  const base = await folderOfBinding(plan.binding);
  if (!base) throw new Error(`Папка «${plan.binding.label}» не найдена среди папок этого компьютера. Откройте её в Проводнике и привяжите заново (так сохранится её место).`);
  const folder = await ensureFolders(base, plan.folderPath, group);
  const name = role === 'remarks' ? await freeName(folder, plan.finalName) : plan.finalName;
  if (role === 'file' && name !== (await freeName(folder, name))) throw new Error(`В папке «${plan.folderPath || plan.binding.label}» уже есть файл «${name}». Он не заменён.`);
  const moved = await moveFile(ref, folder, name, source.sha256, group);
  const after = await describeFile(moved);
  return { folderKey: plan.binding.locationKey, relativePath: joinPath(plan.folderPath, name), ref: moved, sha256: after?.sha256 || source.sha256, size: after?.size ?? source.size, moved: true, finalName: name };
}

/** Файлы папки, включая подпапки, для сверки; предел защищает от обхода огромных деревьев. */
export async function scanFolder(root: WindowsFileRef, limit = 5000): Promise<{ files: Array<{ relativePath: string; name: string; size: number; fileId: string }>; truncated: boolean }> {
  const files: Array<{ relativePath: string; name: string; size: number; fileId: string }> = [];
  const queue: Array<{ ref: WindowsFileRef; rel: string }> = [{ ref: root, rel: '' }];
  let truncated = false;
  while (queue.length) {
    const { ref, rel } = queue.shift()!;
    let offset: number | null = 0;
    while (offset !== null) {
      const answer: WindowsFilesResponse<ListPage> = await windowsFilesRequest<ListPage>({ action: 'list', ref, offset, limit: 500 });
      if ('error' in answer) throw new Error(answer.error.message || 'Не удалось прочитать папку');
      for (const entry of answer.data.entries) {
        const path = joinPath(rel, entry.name);
        if (entry.kind === 'directory') queue.push({ ref: { ...ref, relativePath: joinPath(ref.relativePath, entry.name) }, rel: path });
        else if (entry.kind === 'file') {
          if (files.length >= limit) { truncated = true; break; }
          files.push({ relativePath: path, name: entry.name, size: entry.size, fileId: entry.fileId });
        }
      }
      if (truncated) return { files, truncated };
      offset = answer.data.nextOffset;
    }
  }
  return { files, truncated };
}
