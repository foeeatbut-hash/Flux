/**
 * Файл от запущенной программы пользователю (`flux.saveFile` → мост → `offerFile`): системный диалог сохранения главного процесса.
 *
 * Во Flux (src/services/modulePage.ts, offerFileToUser) страница на диск не пишет: человек подтверждает предложение, файл уходит
 * обычной загрузкой окна. В Studio окно — не браузер, поэтому диалог показывает главный процесс, а записывает файл он же и только
 * туда, где человек сам выбрал место. Пределы те же, что во Flux: имя — `saveNameProblem`, размер — `PAGE_LIMITS.saveChars`
 * (больше — «отказ», как у Flux). Один диалог за раз: пока он открыт, второй запрос получает отказ.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PAGE_LIMITS, saveNameProblem } from '../../modules/page/model';
import type { RunSaveReply } from '../shared/runActions';
import { StudioFailure } from './api';

/** Системный диалог «Сохранить как»: путь, выбранный человеком, или null, если он отказался */
export type SaveDialog = (options: { title: string; defaultName: string }) => Promise<string | null>;

export class RunFileSaver {
  private open = false;
  constructor(private readonly dialog: SaveDialog | undefined, private readonly write: (file: string, bytes: Uint8Array) => Promise<void> = (file, bytes) => fs.writeFile(file, bytes)) {}

  async save(program: string, args: { name?: unknown; mime?: unknown; bytes?: unknown }): Promise<RunSaveReply> {
    const { name } = args;
    // Имя и тип проверяются здесь заново: мост окна уже отказал плохому имени, но главный процесс окну не верит
    if (typeof name !== 'string' || name.length > 255) throw new StudioFailure('Недопустимое имя файла.');
    const problem = saveNameProblem(name);
    if (problem) throw new StudioFailure(`Недопустимое имя файла: ${problem}.`);
    if (args.mime !== undefined && (typeof args.mime !== 'string' || args.mime.length > 200)) throw new StudioFailure('Недопустимый тип файла.');
    const bytes = args.bytes instanceof Uint8Array ? args.bytes : args.bytes instanceof ArrayBuffer ? new Uint8Array(args.bytes) : null;
    if (!bytes) throw new StudioFailure('Содержимое файла должно быть набором байт.');
    // Как у Flux: слишком большой файл не предлагается человеку вовсе
    if (bytes.length > PAGE_LIMITS.saveChars) return 'cancelled';
    if (!this.dialog || this.open) return 'cancelled';
    this.open = true;
    try {
      const kb = Math.max(1, Math.round(bytes.length / 1024));
      const chosen = await this.dialog({ title: `Программа «${program}» предлагает сохранить файл «${name}» (${kb} КБ)`, defaultName: name });
      if (!chosen) return 'cancelled';
      // Человек мог переименовать файл в диалоге: исполняемый или сценарный тип не записывается и тогда
      const chosenProblem = saveNameProblem(path.basename(chosen));
      if (!path.isAbsolute(chosen) || chosenProblem) throw new StudioFailure(`Файл не сохранён: ${chosenProblem || 'нужен полный путь'}.`);
      try { await this.write(chosen, bytes); } catch (error: any) { throw new StudioFailure(`Файл не сохранён: ${String(error?.code || error?.message || 'ошибка записи').slice(0, 80)}.`); }
      return 'saved';
    } finally { this.open = false; }
  }
}
