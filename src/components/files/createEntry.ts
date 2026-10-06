/**
 * Создание объекта в папке Windows или в Flux — чистая логика без React.
 *
 * Вынесено из рабочего стола (`WindowsDesktop.tsx`), чтобы то же самое делал
 * Проводник: две копии разошлись бы с первой же правкой (так уже было — у
 * Проводника не было документа Windows, у рабочего стола не было ZIP). Здесь
 * только имя, расширение, байты и вызовы моста; окно имени и пункты меню —
 * в `CreatePanel.tsx`.
 *
 * Мост передаётся параметром: логику можно проверить без Electron.
 */
import { blankBytes } from '../../lib/blankFiles';
import { zip } from '../../../feedback/zip';
import { bytesToBase64, type WindowsFileEntry, type WindowsFileRef, type WindowsFilesRequest, type WindowsFilesResponse } from '../../lib/windowsFiles';

/** Где появится объект: в настоящей папке Windows или только во Flux (черновик). */
export type CreatePlace = 'windows' | 'flux';
/** Что создаём. Набор один для обоих мест: человек не должен гадать, чего где нет. */
export type CreateKind = 'folder' | 'doc' | 'sheet' | 'text' | 'archive';

export const CREATE_KINDS: { kind: CreateKind; label: string }[] = [
  { kind: 'folder', label: 'Папку' },
  { kind: 'doc', label: 'Документ Word' },
  { kind: 'sheet', label: 'Книгу Excel' },
  { kind: 'text', label: 'Текстовый файл' },
  { kind: 'archive', label: 'Архив ZIP' },
];

/** Имена по умолчанию — как в Windows: «Новая папка», «Новый документ…». */
export const DEFAULT_NAME: Record<CreateKind, string> = {
  folder: 'Новая папка',
  doc: 'Новый документ.docx',
  sheet: 'Новая таблица.xlsx',
  text: 'Новый текстовый документ.txt',
  archive: 'Новый архив.zip',
};

const EXTENSION: Record<CreateKind, string> = { folder: '', doc: '.docx', sheet: '.xlsx', text: '.txt', archive: '.zip' };

export type BridgeRequest = <T = unknown>(request: WindowsFilesRequest) => Promise<WindowsFilesResponse<T>>;

/** Текст ошибки для человека или null, если имя годится. */
export function validateName(raw: string): string | null {
  const name = raw.trim();
  // Те же запрещённые знаки, что у имён файлов Windows: мост всё равно откажет,
  // но лучше сказать это до обращения к нему
  return !name || /[\\/:*?"<>|]/u.test(name) ? 'Укажите имя без символов \\/ : * ? " < > |' : null;
}

/** Имя с расширением вида: «Отчёт» → «Отчёт.docx»; уже с расширением не трогаем. */
export function finalName(kind: CreateKind, raw: string): string {
  const name = raw.trim();
  const extension = EXTENSION[kind];
  return extension && !name.toLowerCase().endsWith(extension) ? `${name}${extension}` : name;
}

/** Пустое содержимое нового файла; для папки байтов нет. */
export async function createBytes(kind: Exclude<CreateKind, 'folder'>): Promise<Uint8Array> {
  if (kind === 'doc' || kind === 'sheet') return blankBytes(kind);
  // Пустой ZIP — только запись конца каталога, но настоящий: открывается и Windows
  return kind === 'archive' ? zip([]) : new TextEncoder().encode('');
}

export type CreateOutcome =
  | { ok: true; place: CreatePlace; kind: CreateKind; name: string; ref?: WindowsFileRef; entry?: WindowsFileEntry }
  | {
    ok: false; message: string;
    /** Черновик уже создан, не удалась только публикация: окно имени закрывается, список обновляется. */
    draftKept: boolean;
  };

const failure = (response: { error: { message: string } }, draftKept = false): CreateOutcome => ({ ok: false, message: response.error.message, draftKept });

export type Created = Extract<CreateOutcome, { ok: true }>;
// Проверка типом-стражем: у проекта нет strict, и обычное сравнение `ok` не сужает объединение
export const isCreated = (outcome: CreateOutcome): outcome is Created => outcome.ok === true;

/**
 * Создать объект. Файл Windows создаётся черновиком и сразу публикуется: так он
 * остаётся обычным файлом в выбранной папке и получает значок программы,
 * назначенной в системе; а если публикация сорвалась, черновик остаётся виден
 * и повторная попытка не затрёт данные человека.
 */
export async function createEntry(
  request: BridgeRequest,
  { place, kind, parent, name }: { place: CreatePlace; kind: CreateKind; parent: WindowsFileRef; name: string },
): Promise<CreateOutcome> {
  const clean = name.trim();
  try {
    if (kind === 'folder') {
      if (place === 'windows') {
        const made = await request<WindowsFileEntry>({ action: 'mkdir', parent, name: clean });
        if ('error' in made) return failure(made);
        return { ok: true, place, kind, name: clean, entry: made.data, ref: { rootId: parent.rootId, relativePath: made.data?.relativePath ?? '' } };
      }
      const made = await request<{ ref?: WindowsFileRef; file?: WindowsFileEntry }>({ action: 'createDraftFolder', parent, name: clean });
      if ('error' in made) return failure(made);
      return { ok: true, place, kind, name: clean, ref: made.data?.ref, entry: made.data?.file };
    }
    const fileName = finalName(kind, clean);
    const draft = await request<{ ref?: WindowsFileRef; file?: WindowsFileEntry }>({ action: 'createDraft', parent, name: fileName, base64: bytesToBase64(await createBytes(kind)) });
    if ('error' in draft) return failure(draft);
    if (!draft.data?.ref) return { ok: false, message: 'Мост не вернул созданный файл.', draftKept: false };
    if (place === 'flux') return { ok: true, place, kind, name: fileName, ref: draft.data.ref, entry: draft.data.file };
    const published = await request<{ ref?: WindowsFileRef; file?: WindowsFileEntry }>({ action: 'publishDraft', ref: draft.data.ref });
    if ('error' in published) return failure(published, true);
    if (!published.data?.ref) return { ok: false, message: 'Публикация не вернула файл Windows. Черновик сохранён в Flux.', draftKept: true };
    return { ok: true, place, kind, name: fileName, ref: published.data.ref, entry: published.data.file };
  } catch (cause: any) {
    return { ok: false, message: cause?.message || 'Не удалось создать файл', draftKept: false };
  }
}

/** Что сказать человеку об удаче. `where` — «на рабочем столе Windows», «в Windows». */
export function createdMessage(outcome: Created, where = 'в Windows'): string {
  if (outcome.place === 'windows') return outcome.kind === 'folder' ? `Папка создана ${where}` : `Файл создан ${where}`;
  return outcome.kind === 'folder' ? 'Папка создана в Flux. Опубликуйте её в Windows, когда будете готовы.' : 'Черновик создан в Flux.';
}

/** Заголовок окна имени: по нему человек видит, куда именно попадёт объект. */
export function createTitle(place: CreatePlace, kind: CreateKind): string {
  if (place === 'flux') return kind === 'folder' ? 'Новая папка Flux' : kind === 'archive' ? 'Новый архив Flux' : 'Новый файл Flux';
  return kind === 'folder' ? 'Новая папка Windows' : 'Новый файл Windows';
}

export function createHint(place: CreatePlace): string {
  return place === 'flux' ? 'Объект сохранится только в Flux. Позже его можно сохранить в Windows.' : 'Объект появится в настоящем каталоге Windows.';
}
