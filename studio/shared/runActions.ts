/**
 * Договор действий полного запуска программы в Studio: общие типы главного процесса (studio/shell/run*.ts) и окна.
 *
 * Только формы данных, без кода: окно импортирует отсюда типы, оболочка — те же типы. Имена и формы менять нельзя без записи в
 * `.claude/progress/stage2-studio-full-run.md` (раздел «Исполнитель A»): с этим договором сверяется исполнитель окна.
 */
import type { ConnectCall, ConnectErrorCode, GrantAsk } from '../../modules/connections/model';
import type { ProgramCall, ProgramReply } from '../../modules/programs/model';

/** Ответ `runConnect`: те же коды, что у подключения во Flux, но без `ASK` — вопрос человеку оболочка задаёт сама и ждёт ответа */
export type RunConnectReply =
  | { ok: true; data: unknown }
  /** `line` — строка для журнала запуска, если у отказа есть чем помочь человеку (например, «политики администратора в Studio нет») */
  | { ok: false; code: ConnectErrorCode; line?: string };

/** Три ответа человека, как во Flux: «разрешить всегда» (до закрытия Studio), «только сейчас» (до закрытия запуска), «не разрешать» (до закрытия Studio) */
export type ConnectDecision = 'always' | 'once' | 'never';
export const CONNECT_DECISIONS: readonly ConnectDecision[] = ['always', 'once', 'never'];

/**
 * События запуска, которые оболочка присылает окну (`window.studio.onRun(fn)`, канал `studio:run`).
 * `connectAsk` — вопрос о подключении: окно показывает его и отвечает действием `runConnectAnswer { id, decision }`.
 * `connectAskClose` — вопрос снят без ответа окна (запуск закрыт, время ожидания вышло, ответ уже дан): окно убирает диалог.
 */
export type RunEvent =
  | { kind: 'connectAsk'; id: string; ask: GrantAsk }
  | { kind: 'connectAskClose'; id: string };

/** Строка списка «вторая программа» (`testPrograms`) */
export interface TestProgramRow {
  id: string;
  name: string;
  version: string;
  language: 'typescript' | 'python' | 'wasm';
  /** Методы, которые программа объявляет другим (`exports` манифеста) */
  exports: Array<{ method: string; does: string }>;
  /** «Установлена» в тестовую базу этого запуска: только такую программу можно вызвать из запущенной */
  installed: boolean;
}

/** Ответ `runProgram`: ответ вызова как во Flux плюс строка для журнала запуска, когда у отказа есть что сказать человеку */
export type RunProgramReply = ProgramReply & { line?: string };

/** Ответ `runSaveFile`: 'saved' — человек выбрал место и файл записан, 'cancelled' — отказ, слишком большой файл или занятый диалог */
export type RunSaveReply = 'saved' | 'cancelled';

/** Хранилище запущенной программы (`runStorageInfo`): у самостоятельной — диск области `studio`, у остальных — память окна */
export interface RunStorageInfo { standalone: boolean; bytes: number | null; text: string }
/** Состояние при запуске (`runStorageLoad`); `line` — строка для журнала запуска (битый файл, диск не отвечает) */
export interface RunStorageLoadReply { standalone: boolean; state: Record<string, unknown>; line?: string; failed?: boolean }
/** Ответ `runStorageKeep`: `LIMIT` и `FAILED` — отказы, текст `line` — тот же, что видит человек во Flux */
export type RunStorageKeepReply =
  | { ok: true; stored: boolean; bytes?: number; line?: string }
  | { ok: false; code: 'LIMIT' | 'FAILED'; line: string };

/** Аргументы действий (для окна и для проверок) */
export interface RunActionArgs {
  runConnect: { connection: string; call: ConnectCall };
  runConnectAnswer: { id: string; decision: ConnectDecision };
  runStop: Record<string, never>;
  testPrograms: Record<string, never>;
  testProgramInstall: { id: string };
  testProgramRemove: { id: string };
  runProgram: { call: ProgramCall };
  runSaveFile: { name: string; mime: string; bytes: Uint8Array };
  runStorageInfo: Record<string, never>;
  runStorageLoad: Record<string, never>;
  runStorageKeep: { state: Record<string, unknown> };
  runStorageClear: Record<string, never>;
}
