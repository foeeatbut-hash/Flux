/**
 * Постоянный рабочий поток сверки типов (собирается отдельным файлом: studio/build-assets.cjs).
 *
 * Компилятор TypeScript и стандартная библиотека встроены в этот файл, интернет и диск не нужны. Поток живёт между
 * сборками, чтобы держать программу компилятора и кэш разобранных файлов (см. tsTypes.ts); завершает его главный процесс
 * (по времени, по простою, при закрытии). Отдельно от потока esbuild: обе части идут параллельно.
 */
import { parentPort } from 'node:worker_threads';
import * as ts from 'typescript';
import libs from 'virtual:ts-libs';
import { createTypeChecker } from './tsTypes';

const checker = createTypeChecker(ts, libs);

parentPort!.on('message', (m: { id: number; files: Record<string, Uint8Array>; ambient?: Record<string, string> }) => {
  try {
    parentPort!.postMessage({ id: m.id, ok: true, problems: checker.check(m.files, m.ambient) });
  } catch (error: any) {
    parentPort!.postMessage({ id: m.id, ok: false, detail: String(error?.message || error).slice(0, 300) });
  }
});
