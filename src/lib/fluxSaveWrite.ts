/**
 * Запись файла в папку Проводника Flux — без интерфейса, чтобы правила
 * («как называется копия», «что делать при занятом имени», «не оставить мусор
 * после сбоя») можно было проверить без окна.
 *
 * Запись идёт командами моста Проводника (publish для нового файла, write для
 * замены с проверкой версии), поэтому обходных путей на диск нет: страница не
 * видит путей, только rootId и относительный путь, а мост сам проверяет имя,
 * корень и занятость.
 */
import { bytesToBase64, type WindowsFileEntry, type WindowsFileRef, type WindowsFilesRequest, type WindowsFilesResponse } from './windowsFiles';

export type SaveRequestFn = <T = unknown>(request: WindowsFilesRequest) => Promise<WindowsFilesResponse<T>>;
/** replace — поверх существующего файла, keepBoth — рядом под новым именем «Имя (2).ext». */
export type SaveCollision = 'new' | 'replace' | 'keepBoth';
export interface SaveWritten { ref: WindowsFileRef; name: string }

const join = (folder: string, name: string) => (folder ? `${folder.replace(/\/+$/u, '')}/${name}` : name);

/** «Смета.xlsx» → «Смета (2).xlsx»; расширение остаётся на месте */
export function numberedName(name: string, index: number): string {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot < name.length - 1;
  return hasExt ? `${name.slice(0, dot)} (${index})${name.slice(dot)}` : `${name} (${index})`;
}

/** Windows не допускает эти знаки и конечные точки/пробелы в имени; ошибку человек видит до записи, а не после отказа моста. */
export function nameProblem(raw: string): string {
  const name = raw.trim();
  if (!name) return 'Введите имя файла.';
  if (/[\\/:*?"<>|\u0000-\u001f]/u.test(name)) return 'В имени нельзя использовать знаки \\ / : * ? " < > |';
  if (/[. ]$/u.test(name)) return 'Имя не может заканчиваться точкой или пробелом.';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu.test(name)) return 'Это имя зарезервировано Windows.';
  if (name.length > 200) return 'Имя слишком длинное.';
  return '';
}

/** Есть ли уже файл или папка с таким именем в выбранной папке */
export async function existingEntry(request: SaveRequestFn, folder: WindowsFileRef, name: string): Promise<WindowsFileEntry | null> {
  const answer = await request<WindowsFileEntry>({ action: 'stat', ref: { rootId: folder.rootId, relativePath: join(folder.relativePath, name) } });
  return answer.ok ? answer.data : null;
}

const fail = (answer: { ok: false; error: { message: string } }) => { throw new Error(answer.error.message); };

/** Одноразовый ключ журнала записи: повтор того же ключа вернул бы прежний результат вместо новой записи */
const writeKey = (): string => {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return `save-${c.randomUUID()}`;
  return `save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

/**
 * Новый файл пишется прямо в папку Windows командой publish: черновик Flux не
 * создаётся, поэтому копия содержимого не остаётся в данных программы (важно
 * для выгрузок вроде списка начальных паролей). Занятое имя мост не затирает,
 * а отвечает EEXIST.
 */
async function createFile(request: SaveRequestFn, folder: WindowsFileRef, name: string, base64: string): Promise<SaveWritten & { taken?: boolean }> {
  const written = await request<{ ref: WindowsFileRef }>({ action: 'publish', parent: { rootId: folder.rootId, relativePath: folder.relativePath }, name, base64, draftId: writeKey() });
  if (written.ok === false) {
    if (written.error.code === 'EEXIST') return { ref: folder, name, taken: true };
    return fail(written);
  }
  return { ref: written.data.ref, name };
}

/** Записать байты в папку; возвращает, куда они легли. Ошибка — исключением с текстом для человека. */
export async function writeIntoFolder(request: SaveRequestFn, folder: WindowsFileRef, name: string, bytes: Uint8Array, collision: SaveCollision): Promise<SaveWritten> {
  const base64 = bytesToBase64(bytes);
  if (collision === 'replace') {
    const target: WindowsFileRef = { rootId: folder.rootId, relativePath: join(folder.relativePath, name) };
    const hash = await request<{ sha256: string }>({ action: 'fileHash', ref: target });
    if (hash.ok === false) return fail(hash);
    const written = await request({ action: 'write', ref: target, base64, baseSha256: hash.data.sha256 });
    if (written.ok === false) return fail(written);
    return { ref: target, name };
  }
  if (collision === 'keepBoth') {
    for (let index = 2; index < 100; index++) {
      const candidate = numberedName(name, index);
      const done = await createFile(request, folder, candidate, base64);
      if (!done.taken) return done;
    }
    throw new Error('Не удалось подобрать свободное имя. Выберите другое.');
  }
  const done = await createFile(request, folder, name, base64);
  if (done.taken) throw new Error('Файл с таким именем уже есть в этой папке.');
  return done;
}

/** Путь, который читает человек: «Документы\Отчёты\Смета.xlsx» (имя корня + относительный путь, как в окне Windows) */
export function readablePath(rootName: string, relativePath: string): string {
  return [rootName, ...relativePath.split('/').filter(Boolean)].join('\\');
}
