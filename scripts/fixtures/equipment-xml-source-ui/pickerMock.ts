/**
 * Дерево папок для окна «Выбрать файл/папку из Проводника» в стендах XML-источников оборудования.
 *
 * Выбор файла и папки всегда идёт через Проводник Flux (ImportFileChooser), поэтому стендам нужны
 * команды list/stat/selectionProvenance — раньше их заменяли ответы системного окна Windows.
 * Дерево: L23 (ревизии A и B с L23.xml), NewRoot, CommonRoot.
 */
type Ref = { rootId: string; relativePath: string };

export function fluxPickerMock(rootId: string, xmlLength: number, request: any): { ok: true; data: unknown } | null {
  const dirs = new Set(['L23', 'L23/A', 'L23/B', 'NewRoot', 'CommonRoot']);
  const files = new Set(['L23/A/L23.xml', 'L23/B/L23.xml']);
  const parent = (path: string) => path.split('/').slice(0, -1).join('/');
  const name = (path: string) => path.split('/').pop() || '';
  const entry = (path: string) => dirs.has(path)
    ? { name: name(path), relativePath: path, storage: 'windows', kind: 'directory', fileId: path, size: 0, modifiedAt: '2026-10-01T00:00:00.000Z', linked: false, rootId }
    : { name: name(path), relativePath: path, storage: 'windows', kind: 'file', fileId: path, size: xmlLength, modifiedAt: '2026-10-01T00:00:00.000Z', linked: false, rootId };
  if (request.action === 'list') {
    const at = String(request.ref.relativePath || '');
    const entries = [...dirs, ...files].filter(path => parent(path) === at).map(entry);
    return { ok: true, data: { entries, nextOffset: null } };
  }
  if (request.action === 'stat') {
    const path = String(request.ref.relativePath || '');
    if (!path) return { ok: true, data: { ...entry('L23'), name: '', relativePath: '', fileId: 'root' } };
    return dirs.has(path) || files.has(path) ? { ok: true, data: entry(path) } : null;
  }
  if (request.action === 'selectionProvenance') {
    const fileRef: Ref | undefined = request.fileRef;
    return { ok: true, data: { sourceFolder: request.ref, ...(fileRef ? { fileRef } : {}) } };
  }
  if (request.action === 'viewStateGet') return { ok: true, data: {} };
  if (request.action === 'viewStateSet') return { ok: true, data: { stored: 0 } };
  return null;
}
