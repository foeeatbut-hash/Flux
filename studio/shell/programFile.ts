/**
 * Файл пользователя для программы в пробном запуске (flux.openFile): общая часть пробного запуска разработчика и владельца.
 * Диалог показывает главный процесс, программа получает имя и содержимое только выбранного файла и не больше предела
 * (правила — modules/page/pickFile.ts, те же, что во Flux). Окно получает ответ в виде, который проходит через IPC.
 */
import { pickForProgram, type PickDialog } from '../../modules/page/pickFile';

/** Системный диалог выбора файла для программы: путь выбранного файла или null, если человек отказался */
export async function showDataFileDialog(
  dialog: { showOpenDialog: (...args: any[]) => Promise<{ canceled: boolean; filePaths: string[] }> },
  parent: unknown,
  options: Parameters<PickDialog>[0],
): Promise<string | null> {
  const config = { ...options, buttonLabel: 'Отдать программе', properties: ['openFile'] };
  const picked = parent ? await dialog.showOpenDialog(parent, config) : await dialog.showOpenDialog(config);
  return picked.canceled || !picked.filePaths[0] ? null : picked.filePaths[0];
}

export type WirePick = { ok: true; name: string; data: string } | { ok: false; code: 'CANCELLED' | 'LIMIT' | 'FAILED' | 'DENIED' };

/** Один выбор файла для запущенной программы; содержимое уходит окну строкой base64 */
export async function pickForWire(program: string, accept: unknown, show: PickDialog | undefined): Promise<WirePick> {
  if (!show) return { ok: false, code: 'DENIED' };
  const reply = await pickForProgram({ program, accept }, show);
  if ('code' in reply) return reply;
  return { ok: true, name: reply.name, data: Buffer.from(reply.bytes).toString('base64') };
}
