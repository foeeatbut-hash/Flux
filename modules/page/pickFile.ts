/**
 * Выбор файла пользователя для программы без Electron: проверка просьбы, диалог (подставляется хостом), чтение.
 * Общая часть Flux (electron/modulePickFile.ts) и Studio (пробный запуск): правила одни — программа получает имя и
 * содержимое только выбранного файла, не больше предела, никогда не путь. Только Node: окно этот файл не подключает.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openAcceptProblem, openFilters, PAGE_LIMITS } from './model';

export type PickReply = { ok: true; name: string; bytes: Uint8Array } | { ok: false; code: 'CANCELLED' | 'LIMIT' | 'FAILED' | 'DENIED' };

/** Читает выбранный файл: только обычный файл, не больше предела; больше — отказ без чтения содержимого */
export function readPicked(file: string, limit: number = PAGE_LIMITS.openBytes): PickReply {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, code: 'FAILED' };
    if (stat.size > limit) return { ok: false, code: 'LIMIT' };
    const bytes = fs.readFileSync(file);
    // Файл мог вырасти между проверкой и чтением
    if (bytes.length > limit) return { ok: false, code: 'LIMIT' };
    return { ok: true, name: path.basename(file), bytes: new Uint8Array(bytes) };
  } catch { return { ok: false, code: 'FAILED' }; }
}

/** Заголовок диалога: чья просьба. Название программы приходит из проверенного выпуска, но длину всё равно ограничиваем */
export const pickTitle = (program: string) => `Программа «${program.replace(/[\u0000-\u001f]/g, ' ').slice(0, 60)}» просит файл`;

export interface PickDialog { (options: { title: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<string | null> }

/** Весь порядок одного выбора, отдельно от Electron: проверка просьбы, диалог, чтение */
export async function pickForProgram(request: { program?: unknown; accept?: unknown }, show: PickDialog, limit?: number): Promise<PickReply> {
  const accept = request.accept === undefined ? [] : request.accept;
  if (openAcceptProblem(accept)) return { ok: false, code: 'DENIED' };
  const program = typeof request.program === 'string' ? request.program : 'без названия';
  const chosen = await show({ title: pickTitle(program), filters: openFilters(accept as string[]) });
  if (!chosen) return { ok: false, code: 'CANCELLED' };
  return readPicked(chosen, limit);
}
