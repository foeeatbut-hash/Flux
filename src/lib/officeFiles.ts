/**
 * Настоящий файл Flux из байтов — со стороны окна.
 *
 * Любая выгрузка и любой «Создать документ» кончаются одинаково: файл в
 * Проводнике и открытое окно Flux Office над ним. Сервер сам находит папку
 * и свободное имя (server/officeStore.ts), окно только отдаёт байты и потом
 * открывает то, что получилось, — тем же адресом, что двойной щелчок.
 */
import { openHref } from './fileTypes';
import { useStore } from '../store/store';

export type FileTarget =
  /** «Выгрузки» на моём столе — по умолчанию для выгрузок */
  | 'exports'
  /** Мой стол */
  | 'desk'
  /** Общий стол проекта */
  | 'shared'
  /** Своя папка */
  | { folderId: string }
  /** Корень раздела Проводника «Общий» или «Личный» — файл без папки */
  | { section: 'SHARED' | 'PERSONAL' };

export interface SavedFile { id: string; name: string; sha256: string; size: number; folderId: string | null }

const activeProjectId = (): string => {
  try { return String((useStore.getState() as any).activeProject?.id || ''); } catch { return ''; }
};

/** Положить байты новым файлом. Имя — желаемое: занятое сервер дополнит «(2)» */
export async function saveNewFile(bytes: ArrayBuffer | Uint8Array | Blob, name: string, target: FileTarget = 'exports'): Promise<SavedFile> {
  const q = new URLSearchParams({ name });
  if (typeof target === 'string') q.set('where', target);
  else if ('section' in target) { q.set('where', 'section'); q.set('scope', target.section); }
  else { q.set('where', 'folder'); q.set('folderId', target.folderId); }
  const project = activeProjectId();
  if (project) q.set('projectId', project);
  const body = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart]);
  const res = await fetch(`/api/office/files/new?${q}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.id) throw new Error(String(data?.error || `сервер ответил ${res.status}`));
  return data as SavedFile;
}

/** Адрес, по которому файл открывается в Flux Office, — тот же, что у двойного щелчка */
export const editorHref = (f: { id: string; name: string }): string => openHref({ id: f.id, name: f.name });

/** Положить и сразу открыть. `go` — навигатор окна (useNavigate) */
export async function saveAndOpen(
  bytes: ArrayBuffer | Uint8Array | Blob, name: string, go: (href: string) => void, target: FileTarget = 'exports',
): Promise<SavedFile> {
  const made = await saveNewFile(bytes, name, target);
  go(editorHref(made));
  return made;
}
