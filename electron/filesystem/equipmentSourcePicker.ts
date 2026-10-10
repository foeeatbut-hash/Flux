import path from 'node:path';
import type { WindowsFileRef } from '../../filesystem/contracts';

export interface EquipmentSourceRootProvider {
  refForShellPath(filename: string): Promise<WindowsFileRef | null>;
  addRoot(filename: string, name?: string): Promise<{ id: string }>;
}

export interface EquipmentSourceSelection {
  selectedFile: { ref: WindowsFileRef; name: string };
  sourceFolder: WindowsFileRef;
}

/** Выбранный файл превращается в ограниченные ссылки; имя диска не уходит в renderer. */
export async function resolveEquipmentSourceSelection(service: EquipmentSourceRootProvider, filename: string): Promise<EquipmentSourceSelection> {
  if (path.extname(filename).toLocaleLowerCase() !== '.xml') throw Object.assign(new Error('Выберите XML-файл оборудования.'), { code: 'INVALID_REQUEST' });
  const revisionFolder = path.dirname(filename);
  const sourceFolder = /^[A-Z]$/iu.test(path.basename(revisionFolder)) ? path.dirname(revisionFolder) : revisionFolder;
  let sourceFolderRef = await service.refForShellPath(sourceFolder);
  if (!sourceFolderRef) {
    const root = await service.addRoot(sourceFolder, path.basename(sourceFolder));
    sourceFolderRef = { rootId: root.id, relativePath: '' };
  }
  const relativeFile = path.relative(sourceFolder, filename).split(path.sep).join('/');
  if (relativeFile.startsWith('../') || path.isAbsolute(relativeFile)) throw Object.assign(new Error('Выбранный XML находится вне папки источника.'), { code: 'INVALID_REQUEST' });
  return {
    selectedFile: { ref: { rootId: sourceFolderRef.rootId, relativePath: [sourceFolderRef.relativePath, relativeFile].filter(Boolean).join('/') }, name: path.basename(filename) },
    sourceFolder: sourceFolderRef,
  };
}

/** Повторная привязка выдаёт корень ровно выбранной папки, если её ещё нет в мосте. */
export async function resolveEquipmentSourceFolder(service: EquipmentSourceRootProvider, folder: string): Promise<WindowsFileRef> {
  const existing = await service.refForShellPath(folder);
  if (existing) return existing;
  const root = await service.addRoot(folder, path.basename(folder));
  return { rootId: root.id, relativePath: '' };
}
