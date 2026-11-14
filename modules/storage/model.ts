/**
 * Хранилище самостоятельной программы: понятия, общие для Flux, Store, окна установки и Studio.
 *
 * Чистый модуль без Node и React (окно Flux и Store импортируют его напрямую). Работа с диском — в `disk.ts`: там
 * `node:path` и `node:crypto`, и импортирует его только главный процесс.
 *
 * Решение — `.claude/progress/stage2-standalone-attach.md` и `docs/roadmap/studio-next.md` (12 ноября 2026, пункты 3–4):
 * на диск попадает состояние ТОЛЬКО самостоятельной программы. Программа, читающая данные Flux, остаётся с состоянием
 * в памяти: копии данных проектов вне базы не появляются.
 */
import type { ModuleManifest } from '../contract';
import { permissionsOf } from '../permissions/registry';

/** Предел сохранённого состояния самостоятельной программы: размер JSON поля `state`, на программу и человека */
export const STORAGE_LIMIT_BYTES = 1024 * 1024;
/** Предел состояния в памяти (программа, читающая данные Flux): прежний, как до хранилища (modules/page/model.ts, `stateBytes`) */
export const MEMORY_LIMIT_BYTES = 256 * 1024;

/**
 * Три области не видят друг друга: выпуск (оба канала делят одну — смена канала не должна терять данные человека),
 * сборка из разработки («Запустить во Flux») и запуск внутри Studio
 */
export type StorageScope = 'released' | 'dev' | 'studio';
export const STORAGE_SCOPES: readonly StorageScope[] = ['released', 'dev', 'studio'];

/** Формат файла `state.json`. Неизвестный формат читать нельзя: файл откладывается, а не затирается */
export const STORAGE_FORMAT = 1;
export const STORAGE_FILE = 'state.json';

/**
 * Самостоятельная программа: ничего не читает во Flux и открывается только из «Пуска». Признак считается из манифеста,
 * отдельного поля нет — его нельзя «объявить» мимо подписанного списка чтения. Пустой `entries` не годится: такую
 * программу вообще нечем открыть, значит и «самостоятельной» она не является.
 */
export function isStandalone(manifest: Pick<ModuleManifest, 'reads' | 'entries'> | null | undefined): boolean {
  if (!manifest || !Array.isArray(manifest.reads) || !Array.isArray(manifest.entries)) return false;
  return manifest.reads.length === 0 && manifest.entries.length > 0 && manifest.entries.every(e => e === 'start');
}

/**
 * Метка «работает без связи»: самостоятельная программа без интернета, локальной сети и обращений к другим программам.
 * Подключения к программам на этом компьютере (COM и т. п.) метку не снимают — это не связь. Метка — заявление о
 * программе: сам запуск без связи появится на этапе 3.
 */
export function worksOffline(manifest: Pick<ModuleManifest, 'reads' | 'entries' | 'permissions'> | null | undefined): boolean {
  if (!isStandalone(manifest)) return false;
  return !permissionsOf(manifest).some(p => p.kind === 'internet' || p.kind === 'lan' || p.kind === 'program');
}

/** Предел состояния для окна: диск у самостоятельной программы, память у остальных */
export const stateLimitFor = (manifest: Pick<ModuleManifest, 'reads' | 'entries'> | null | undefined): number =>
  isStandalone(manifest) ? STORAGE_LIMIT_BYTES : MEMORY_LIMIT_BYTES;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Размер состояния — байты его JSON в UTF-8; `null`, если состояние не превращается в JSON (цикл, BigInt) */
export function stateBytes(state: unknown): number | null {
  try {
    const json = JSON.stringify(state);
    return json === undefined ? null : new TextEncoder().encode(json).length;
  } catch { return null; }
}

/** «312 Б», «12 КиБ», «1,3 МиБ»: человеку и разработчику одинаково. Меньше килобайта — в байтах: «0 КиБ» при сохранённых данных читалось бы как «пусто» */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} Б`;
  if (bytes < 1024 * 1024) {
    const kib = bytes / 1024;
    return `${kib < 10 ? (Math.round(kib * 10) / 10).toString().replace('.', ',') : Math.round(kib)} КиБ`;
  }
  return `${(Math.round(bytes / (1024 * 1024) * 10) / 10).toString().replace('.', ',')} МиБ`;
}
/** Отказ `LIMIT`: один текст для человека (окно, журнал программ) и разработчика (Studio) */
export const storageFullText = (bytes: number) => `Хранилище программы заполнено: ${sizeText(bytes)} из ${sizeText(STORAGE_LIMIT_BYTES)}`;
/** Строка Studio и окна разработки: сколько занято */
export const storageUsageText = (bytes: number) => `Хранилище: ${sizeText(bytes)} из ${sizeText(STORAGE_LIMIT_BYTES)}`;
/** Строка в подтверждении удаления программы (решение владельца): человек знает, что вместе с программой уйдут её данные */
export const STORAGE_DELETE_NOTICE = 'Сохранённые программой данные на этом компьютере будут удалены';
/** Строка Studio у программы, читающей данные Flux: диска у неё нет */
export const STORAGE_IN_MEMORY_TEXT = 'Хранилище: в памяти — программа читает данные Flux';
/** Метка Store, окна установки и Studio */
export const WORKS_OFFLINE_LABEL = 'Работает без связи';

export type StorageErrorCode = 'LIMIT' | 'FAILED';
