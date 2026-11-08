/**
 * «Сверка с папкой» (docs/docflow-program.md, 4.3): чистая функция, которая
 * сравнивает файлы рабочей папки проекта, связи и строки реестра и раскладывает
 * расхождения по четырём группам. Ничего не пишет — только показывает; что с
 * найденным делать, решает человек (автосвязи нет, решение владельца).
 *
 * Работает без Проводника и сервера: файлы и связи приходят данными, поэтому
 * тот же расчёт проверяется скриптом.
 */
import type { DocflowConfig } from './config';
import { checkName, isIgnored, parseFileName, same, revisionValid, buildFileName, type RowForCheck } from './nameMask';
import { linkLookupKey, LOCK_VIOLATION_TEXT, type DocLinkDto } from './links';

export interface ReconRow { id: string; registerId: string; title: string; status: string; row: RowForCheck }
/** Файл рабочей папки: путь внутри привязанной папки и имя. */
export interface ReconFile { folderKey: string; relativePath: string; name: string }

export interface ReconNoFile { rowId: string; revision: string; /** Файлы папки, чьё имя читается как эта строка, но не привязано. */ candidates: ReconFile[] }
export interface ReconNoRow { file: ReconFile; fields: Record<string, string>; /** Строки, чей шифр совпал с именем файла. */ matches: string[] }
export interface ReconOffMask { file: ReconFile; problems: string[] }
export interface ReconDiverged { link: DocLinkDto; rowId: string; reason: 'name' | 'missing' | 'lock'; problems: string[]; /** Имя по строке и маске — «Переименовать по строке». */ expectedName: string }
export interface Reconciliation { noFile: ReconNoFile[]; noRow: ReconNoRow[]; offMask: ReconOffMask[]; diverged: ReconDiverged[]; scanned: number; ignored: number }

const extOf = (name: string) => /\.[^.\\/]+$/.exec(name)?.[0] || '';

/** Строка закрыта: ей файл не нужен («Аннулирован»). */
const closed = (status: string) => status === 'VOID';

export function reconcile(config: DocflowConfig, rows: ReconRow[], files: ReconFile[], links: DocLinkDto[]): Reconciliation {
  const active = links.filter((l) => l.role === 'file' && !l.unlinkedAt);
  const linkedAt = new Map(active.map((l) => [linkLookupKey(l.folderKey, l.relativePath), l]));
  const present = new Set(files.map((f) => linkLookupKey(f.folderKey, f.relativePath)));
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const out: Reconciliation = { noFile: [], noRow: [], offMask: [], diverged: [], scanned: files.length, ignored: 0 };
  const cipherOf = (r: ReconRow) => String(r.row[config.masks.cipherSource] || '');

  const free: ReconFile[] = [];
  for (const file of files) {
    if (isIgnored(config, file.name)) { out.ignored++; continue; }
    if (!linkedAt.has(linkLookupKey(file.folderKey, file.relativePath))) free.push(file);
  }

  // 1. Расхождения у привязанных
  for (const link of active) {
    const row = rowById.get(link.itemId);
    if (!row) continue;
    const here = present.has(linkLookupKey(link.folderKey, link.relativePath));
    const expectedName = buildFileName(config, row.row, extOf(link.fileName), link.revision);
    // Заблокированный файл, изменённый или убранный вне Flux, — нарушение блокировки, а не просто расхождение
    const violation = link.lockViolation ? `нарушена блокировка: ${LOCK_VIOLATION_TEXT[link.lockViolation]}` : '';
    if (!here || link.lostAt) { out.diverged.push({ link, rowId: row.id, reason: 'missing', problems: [violation || (link.lostAt ? 'файл удалён или перемещён' : 'файла нет в папке')], expectedName }); continue; }
    const check = checkName(config, link.fileName, row.row);
    const nameProblems = check.ok ? [] : [...check.blocking.map((f) => f.text), ...(check.parsed.ok ? [] : check.parsed.problems)];
    if (violation || !check.ok) out.diverged.push({ link, rowId: row.id, reason: violation && check.ok ? 'lock' : 'name', problems: [...(violation ? [violation] : []), ...nameProblems], expectedName });
  }

  // 2. Файлы без связи: читаются по маске — ищем строку; не читаются — «Имя не по маске»
  const byCipher = new Map<string, ReconRow[]>();
  for (const r of rows) {
    const c = cipherOf(r).toUpperCase();
    if (c) byCipher.set(c, [...(byCipher.get(c) || []), r]);
  }
  const candidatesOf = new Map<string, ReconFile[]>();
  for (const file of free) {
    const parsed = parseFileName(config, file.name);
    const rev = parsed.fields['ред'];
    const readable = parsed.ok && (rev === undefined || revisionValid(config, rev)) && !parsed.problems.length;
    if (!readable) {
      const problems = parsed.ok ? [...parsed.problems, ...(rev !== undefined && !revisionValid(config, rev) ? [`ревизия «${rev}» не по схеме проекта`] : [])] : parsed.problems;
      out.offMask.push({ file, problems });
      continue;
    }
    const cipher = parsed.fields['шифр'] ?? '';
    const matches = (cipher ? byCipher.get(cipher.toUpperCase()) || [] : []).filter((r) => !parsed.fields['тип'] || !r.row.vdrCode || same(parsed.fields['тип'], r.row.vdrCode));
    if (matches.length) for (const m of matches) candidatesOf.set(m.id, [...(candidatesOf.get(m.id) || []), file]);
    out.noRow.push({ file, fields: parsed.fields, matches: matches.map((m) => m.id) });
  }
  // Файл с совпавшей строкой остаётся в группе «в реестре нет»: действие другое («Связать с …»), список один

  // 3. Строки без файла текущей ревизии
  const hasFile = new Set(active.map((l) => `${l.itemId}\n${l.revision.toUpperCase()}`));
  for (const r of rows) {
    if (closed(r.status)) continue;
    const rev = String(r.row.revision || '');
    if (hasFile.has(`${r.id}\n${rev.toUpperCase()}`)) continue;
    out.noFile.push({ rowId: r.id, revision: rev, candidates: candidatesOf.get(r.id) || [] });
  }
  return out;
}

/** Сводка для вкладки и значка: сколько в каждой группе. */
export const reconSummary = (r: Reconciliation) => ({ noFile: r.noFile.length, noRow: r.noRow.length, offMask: r.offMask.length, diverged: r.diverged.length });
