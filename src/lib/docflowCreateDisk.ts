import type { FileCreatePlan, CreateFileRow } from './docflowCreateApi';
import { relativePathProblem } from '../../shared/docflow/links';
import { windowsFilesRequest, bytesToBase64, type WindowsFileRef, type WindowsFileContent, type WindowsFileEntry } from './windowsFiles';
import { folderOfBinding, ensureFolders, describeFile, openLinked } from './docflowFiles';
import { emptyDocflowFile, type DocflowEmptyFormat } from './docflowEmptyFile';
import { sha256Hex } from './officeBridge';

export interface PreparedCreateFile {
  row: CreateFileRow; ref: WindowsFileRef; base: WindowsFileRef; base64: string; sha256: string; size: number;
  source?: { ref: WindowsFileRef; sha256: string }; created: boolean; removed?: boolean;
}
const join = (...parts: string[]) => parts.filter(Boolean).join('/');
const MAX_FILE = 50 * 1024 * 1024;
const MAX_BATCH = 100 * 1024 * 1024;

/** Сначала весь пакет проверяется и читается. До подтверждения здесь нет mkdir/publish. */
export async function prepareCreateFiles(plan: FileCreatePlan): Promise<PreparedCreateFile[]> {
  if (!plan.rows.length || plan.rows.length > 100) throw new Error('Выберите от 1 до 100 строк');
  const prepared: PreparedCreateFile[] = [];
  for (const row of plan.rows.filter(row => row.action === 'create')) {
    if (!row.binding || row.binding.projectId !== plan.projectId || row.binding.locationKey !== row.folderKey) throw new Error('Рабочая папка не принадлежит проекту плана');
    const problem = relativePathProblem(row.relativePath, row.fileName);
    if (problem) throw new Error(problem);
    const base = await folderOfBinding(row.binding);
    if (!base) throw new Error('Рабочая папка не найдена на этом компьютере. Откройте её в Проводнике и проверьте привязку.');
    const ref = { rootId: base.rootId, relativePath: join(base.relativePath, row.relativePath) };
    const existing = await windowsFilesRequest<WindowsFileEntry>({ action: 'stat', ref });
    if (!('error' in existing)) throw new Error(`Имя «${row.fileName}» уже занято на диске. Файл не перезаписывается. Проверьте его и назначьте вручную, если это нужный документ.`);
    if (!['ENOENT', 'NOT_FOUND'].includes(existing.error.code)) throw new Error(existing.error.message);
    prepared.push({ row, ref, base, base64: '', sha256: '', size: 0, created: false });
  }
  const contents = new Map<string, { base64: string; sha256: string; size: number; source?: { ref: WindowsFileRef; sha256: string } }>();
  let total = 0;
  for (const file of prepared) {
    const key = file.row.template ? `template:${file.row.template}` : `empty:${file.row.format}`;
    let data = contents.get(key);
    if (!data) {
      if (file.row.template) {
        const found = await windowsFilesRequest<WindowsFileRef | null>({ action: 'resolveAddress', text: file.row.template });
        let source = found.ok ? found.data : null;
        // Относительный путь в настройках переносится вместе с рабочей папкой проекта.
        if (!source && !/^(?:[a-z]:|[\\/]{1,2})/i.test(file.row.template)) {
          const relative = file.row.template.replaceAll('\\', '/');
          const problem = relativePathProblem(relative, relative.split('/').pop() || '');
          if (problem) throw new Error(problem);
          source = { rootId: file.base.rootId, relativePath: join(file.base.relativePath, relative) };
        }
        if (!source) throw new Error(`Шаблон не найден: ${file.row.template}`);
        const stat = await windowsFilesRequest<WindowsFileEntry>({ action: 'stat', ref: source });
        if (!stat.ok || stat.data.kind !== 'file' || stat.data.size > MAX_FILE) throw new Error('Шаблон недоступен или больше 50 МБ');
        const read = await windowsFilesRequest<WindowsFileContent>({ action: 'read', ref: source });
        if ('error' in read) throw new Error(read.error.message);
        if (read.data.size > MAX_FILE) throw new Error('Шаблон больше 50 МБ');
        data = { base64: read.data.base64, sha256: read.data.sha256, size: read.data.size, source: { ref: source, sha256: read.data.sha256 } };
      } else {
        const bytes = await emptyDocflowFile(file.row.format as DocflowEmptyFormat);
        data = { base64: bytesToBase64(bytes), sha256: await sha256Hex(bytes.slice().buffer as ArrayBuffer), size: bytes.byteLength };
      }
      contents.set(key, data);
    }
    total += data.size;
    if (total > MAX_BATCH) throw new Error('Общий размер пакета превышает 100 МБ. Выберите меньше строк.');
    Object.assign(file, data);
  }
  return prepared;
}

/** Нативная публикация использует wx и ключ повтора: занятое имя не заменяется. */
export async function publishCreateFiles(plan: FileCreatePlan, prepared: PreparedCreateFile[]): Promise<void> {
  for (const file of prepared) if (file.source) {
    const actual = await describeFile(file.source.ref);
    if (!actual || actual.sha256 !== file.source.sha256) throw new Error('Шаблон изменён после предпросмотра. Постройте план заново.');
  }
  for (const file of prepared) {
    const path = file.row.relativePath.split('/').slice(0, -1).join('/');
    const parent = await ensureFolders(file.base, path, `docflow-create-${plan.id}`);
    const published = await windowsFilesRequest<{ ref: WindowsFileRef; file: WindowsFileContent }>({ action: 'publish', parent, name: file.row.fileName, base64: file.base64, draftId: `docflow:${plan.id}:${file.row.itemId}` });
    if ('error' in published) throw new Error(published.error.message);
    file.ref = published.data.ref; file.created = true;
    if (published.data.file.sha256 !== file.sha256) throw new Error('Созданный файл уже изменён. Он сохранён, связь не подтверждена. Проверьте его перед повтором.');
  }
  for (const file of prepared) {
    const actual = await describeFile(file.ref);
    if (!actual || actual.sha256 !== file.sha256) throw new Error('Файл изменён во время создания пакета. Проверьте его перед подтверждением связи.');
  }
}

/** Проверяем весь пакет до удаления; нативный мост повторно сверяет хеш каждого файла. */
export async function removeCreatedFiles(plan: FileCreatePlan, prepared: PreparedCreateFile[]): Promise<void> {
  const files = prepared.filter(file => file.created && !file.removed);
  for (const file of files) {
    const actual = await describeFile(file.ref);
    if (!actual || actual.sha256 !== file.sha256) throw new Error('Один из созданных файлов изменён или перенесён. Отмена сохраняет новые данные.');
  }
  for (const file of files) {
    // Только что созданный и связанный файл заблокирован; отмена создания — единственное, что вправе его убрать
    await windowsFilesRequest({ action: 'releaseLinkLocks', refs: [file.ref] });
    const answer = await windowsFilesRequest({ action: 'trash', ref: file.ref, baseSha256: file.sha256, group: `docflow-create-undo-${plan.id}` });
    if ('error' in answer) throw new Error(`Отмена файлов не завершена: ${answer.error.message}. Уже удалённые файлы можно вернуть журналом Проводника.`);
    file.removed = true;
  }
}

/** После закрытия окна восстанавливаем только адреса созданных им файлов, без содержимого. */
export async function prepareUndoCreateFiles(plan: FileCreatePlan, links: Array<{ itemId: string; sha256: string; size: number }>) {
  const prepared: PreparedCreateFile[] = [];
  for (const link of links) {
    const row = plan.rows.find(row => row.itemId === link.itemId && row.action === 'create');
    if (!row?.binding || row.binding.projectId !== plan.projectId) throw new Error('Исходная рабочая папка недоступна для отмены');
    const base = await folderOfBinding(row.binding);
    if (!base) throw new Error('Рабочая папка не найдена на этом компьютере');
    const ref = { rootId: base.rootId, relativePath: join(base.relativePath, row.relativePath) };
    const current = await describeFile(ref);
    if (!current || current.sha256 !== link.sha256) throw new Error('Файл изменён или перенесён. Отмена сохраняет новые данные.');
    prepared.push({ row, base, ref, base64: '', sha256: link.sha256, size: link.size, created: true });
  }
  return prepared;
}

export async function openCreateRow(row: CreateFileRow) {
  if (!row.link || !row.binding) throw new Error('Связанная папка не найдена. Откройте её в Проводнике и проверьте привязку.');
  const error = await openLinked(row.link, [row.binding], 'open');
  if (error) throw new Error(error);
}
