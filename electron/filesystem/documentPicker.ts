import path from 'node:path';
import type { WindowsFileRef } from '../../filesystem/contracts';

export interface DocumentPickerService {
  refForShellPath(filename: string): Promise<WindowsFileRef | null>;
  addRoot(filename: string, name?: string): Promise<{ id: string }>;
}

/**
 * Выбранный в системном окне файл документа → ссылка моста. Файл лежит где угодно
 * (например, в «Загрузках»), поэтому, если его папки ещё нет среди корней,
 * корнем становится его папка: путь диска наружу не уходит, страница получает
 * только ссылку и имя. Документооборот переносит такой файл в рабочую папку проекта.
 */
export async function resolveDocumentFile(service: DocumentPickerService, filename: string): Promise<{ ref: WindowsFileRef; name: string }> {
  const direct = await service.refForShellPath(filename);
  if (direct) return { ref: direct, name: path.basename(filename) };
  const folder = path.dirname(filename);
  const known = await service.refForShellPath(folder);
  const parent = known || { rootId: (await service.addRoot(folder, path.basename(folder) || folder)).id, relativePath: '' };
  return { ref: { rootId: parent.rootId, relativePath: [parent.relativePath, path.basename(filename)].filter(Boolean).join('/') }, name: path.basename(filename) };
}
