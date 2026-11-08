import type { DocflowConfig } from '../../../shared/docflow/config';
import { linkLookupKey, purposeAllows, type IssueDto, type DocLinkDto, type FolderPurpose, type LinkedItemBrief } from '../../../shared/docflow/links';
import { isIgnored, parseFileName, revisionValid, type ParsedName } from '../../../shared/docflow/nameMask';

/**
 * Что Проводник знает о файле как о документе проекта (docs/docflow-program.md,
 * 3.2): шифр, тип и ревизия из имени, связь со строкой ВДР и всё, что не так.
 * Чистая функция: данные берутся из привязок папок, настроек и списка связей.
 */
export interface DocEntryInfo {
  projectId: string;
  folderKey: string;
  purpose?: FolderPurpose;
  /** Путь файла внутри привязанной папки. */
  relativePath: string;
  /** Файл замечаний (лежит в папке возвратов) или документ. */
  role: 'file' | 'remarks';
  parsed: ParsedName | null;
  /** Почему имя не по маске проекта; пусто — имя читается. */
  offMask: string[];
  /** Служебный файл («Не документ»): не считается ни документом, ни ошибкой. */
  ignored: boolean;
  link: DocLinkDto | null;
  item: LinkedItemBrief | null;
  /** У файла замечаний — файл ревизии, к которому он относится. */
  remarksTo: DocLinkDto | null;
  /** Выпуск этого файла ревизии (у файла возврата — выпуск файла, к которому он относится). */
  issue: IssueDto | null;
}

export interface DocContext { config: DocflowConfig; byPath: Map<string, DocLinkDto>; items: Record<string, LinkedItemBrief>; links: DocLinkDto[]; issues?: IssueDto[] }

export function docInfoOf(
  entry: { name: string; kind: string },
  where: { projectId: string; folderKey: string; purpose?: FolderPurpose; relativePath: string },
  ctx: DocContext | undefined,
): DocEntryInfo | null {
  if (entry.kind !== 'file' || !where.relativePath) return null;
  const isRemarks = where.purpose === 'returns';
  if (!isRemarks && !purposeAllows('file', where.purpose)) return null;
  const base: DocEntryInfo = { ...where, role: isRemarks ? 'remarks' : 'file', parsed: null, offMask: [], ignored: false, link: null, item: null, remarksTo: null, issue: null };
  if (!ctx) return base;
  const link = ctx.byPath.get(linkLookupKey(where.folderKey, where.relativePath)) || null;
  const item = link ? ctx.items[link.itemId] || null : null;
  const remarksTo = link?.toLinkId ? ctx.links.find((l) => l.id === link.toLinkId) || null : null;
  const issueOf = (l: DocLinkDto | null) => (l ? ctx.issues?.find((i) => i.linkId === l.id) || null : null);
  if (isRemarks) return { ...base, link, item, remarksTo, issue: issueOf(remarksTo) };
  if (isIgnored(ctx.config, entry.name)) return { ...base, ignored: true };
  const parsed = parseFileName(ctx.config, entry.name);
  const rev = parsed.fields['ред'];
  const offMask = parsed.ok
    ? [...parsed.problems, ...(rev !== undefined && !revisionValid(ctx.config, rev) ? [`ревизия «${rev}» не по схеме проекта`] : [])]
    : parsed.problems;
  return { ...base, parsed, offMask, link, item, issue: issueOf(link) };
}

export type DocFilter = 'all' | 'linked' | 'unlinked' | 'offMask';
export const DOC_FILTERS: Array<{ id: DocFilter; label: string }> = [
  { id: 'all', label: 'Все файлы' }, { id: 'linked', label: 'В реестре' }, { id: 'unlinked', label: 'Нет в реестре' }, { id: 'offMask', label: 'Имя не по маске' },
];

/** Подходит ли файл под фильтр; папки показывает вызывающий всегда, файл вне проектных папок под фильтр не подходит. */
export function matchesDocFilter(info: DocEntryInfo | null, filter: DocFilter): boolean {
  if (filter === 'all') return true;
  if (!info) return false;
  if (info.ignored) return false;
  if (filter === 'linked') return !!info.link;
  if (filter === 'unlinked') return !info.link;
  return info.offMask.length > 0;
}
