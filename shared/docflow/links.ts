/**
 * Связь файла папки проекта со строкой ВДР: типы и чистые правила, общие для
 * сервера, Проводника и ДО (docs/docflow-program.md, разделы 4 и 7.3).
 *
 * Файл адресуется «ключом привязанной папки + путём внутри неё»: буква диска
 * и корень у каждого компьютера свои, а ключ (хеш сетевого пути) у всех один.
 */

export type LinkRole = 'file' | 'remarks';
/** Назначение привязанной папки проекта (раздел 3.1). */
export type FolderPurpose = 'work' | 'issue' | 'returns' | 'incoming';

export const FOLDER_PURPOSES: Array<{ id: FolderPurpose; label: string; hint: string }> = [
  { id: 'work', label: 'Рабочая', hint: 'документы в работе' },
  { id: 'issue', label: 'Выпуск', hint: 'выданные документы' },
  { id: 'returns', label: 'Возвраты', hint: 'файлы замечаний заказчика' },
  { id: 'incoming', label: 'Входящие', hint: 'прочее от заказчика: исходные данные' },
];
export const isPurpose = (value: unknown): value is FolderPurpose => FOLDER_PURPOSES.some((p) => p.id === value);
export const purposeLabel = (purpose: FolderPurpose | undefined | null): string => FOLDER_PURPOSES.find((p) => p.id === purpose)?.label || 'Папка проекта';

/** Что связь ожидает от папки: файлы документов — рабочая и выпуск (и папка без назначения), замечания — возвраты. */
export function purposeAllows(role: LinkRole, purpose: FolderPurpose | undefined | null): boolean {
  if (role === 'remarks') return purpose === 'returns';
  return !purpose || purpose === 'work' || purpose === 'issue';
}

export interface DocLinkDto {
  id: string;
  itemId: string;
  projectId: string;
  revision: string;
  role: LinkRole;
  toLinkId: string | null;
  folderKey: string;
  relativePath: string;
  fileName: string;
  sha256: string;
  size: number;
  reviewCode: string;
  receivedAt: string | null;
  lostAt: string | null;
  linkedById: string | null;
  createdAt: string;
  unlinkedAt: string | null;
  unlinkReason: string;
  /** Имя файла сейчас не сходится со строкой (после переименования в Windows) и что именно не так. */
  mismatch?: string[];
}

/** Короткие сведения о строке для столбцов Проводника и ДО, чтобы не запрашивать каждую строку отдельно. */
export interface LinkedItemBrief {
  id: string;
  cipher: string;
  title: string;
  vdrCode: string;
  revision: string;
  status: string;
  registerId: string;
}

const clean = (path: string) => String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);

/** Ключ для словаря на клиенте: папка + путь без учёта регистра, как в Windows. */
export function linkLookupKey(folderKey: string, relativePath: string): string {
  return `${folderKey}\n${clean(relativePath).join('/').toLowerCase()}`;
}

/**
 * Путь файла внутри привязанной папки. `depth` — индекс привязанной папки в
 * цепочке ключей, где первым идёт сам файл: у файла прямо в привязанной папке
 * depth = 1, и путь — одно имя.
 */
export function relativeInBinding(refRelativePath: string, depth: number): string {
  const parts = clean(refRelativePath);
  if (depth < 1 || depth > parts.length) return '';
  return parts.slice(parts.length - depth).join('/');
}

/** Безопасен ли путь внутри папки: без «..», без абсолютных, не пустой, имя совпадает с последним сегментом. */
export function relativePathProblem(relativePath: string, fileName: string): string | null {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 1024) return 'Путь файла пуст или слишком длинный';
  if (/[\u0000-\u001f]/.test(relativePath) || /^[\\/]/.test(relativePath) || /^[A-Za-z]:/.test(relativePath)) return 'Путь файла должен быть внутри папки проекта';
  const parts = relativePath.split(/[\\/]+/);
  if (parts.some((p) => !p || p === '.' || p === '..')) return 'Путь файла содержит недопустимые сегменты';
  if (typeof fileName !== 'string' || parts[parts.length - 1].toLowerCase() !== fileName.toLowerCase()) return 'Имя файла не совпадает с концом пути';
  return null;
}

/** Папка файла внутри привязанной: «E02/3700-B01» для «E02/3700-B01/x.pdf». */
export function dirOf(relativePath: string): string {
  return clean(relativePath).slice(0, -1).join('/');
}

export const isFolderKey = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
