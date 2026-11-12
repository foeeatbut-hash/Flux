/**
 * Обращение программы к другой программе (`flux.programs.call`): общие понятия для моста, окна, главного процесса и Studio.
 *
 * Чистый модуль без Node и React. Вызываемая программа объявляет в манифесте `exports` — методы, которые вправе вызвать
 * другие; вызывающая объявляет разрешение `program` (modules/permissions/registry.ts). Метод — чистая функция «JSON → JSON»
 * в логике вызываемой программы: окно её не открывается, а подключений, сети и чтения данных Flux у вызова нет — поэтому
 * обращение не может стать обходом чужих разрешений.
 */
import { humanText } from '../connections/model';
import type { ModuleExport } from '../contract';

export const EXPORTS_MAX = 16;
export const EXPORT_METHOD = /^[a-z][A-Za-z0-9]{0,39}$/;
export const PROGRAM_ID = /^[a-z][a-z0-9-]{0,63}$/;

/** Пределы вызова: общие для окна (мост) и главного процесса, чтобы одно число не расходилось в двух местах */
export const PROGRAM_LIMITS = {
  /** Данные вызова и ответ метода, байт */
  bytes: 256 * 1024,
  /** Одновременных вызовов от одной программы */
  inFlight: 4,
  perSecond: 20,
  /** Сколько главный процесс ждёт окончания вызова, прежде чем освободить место: предел расчёта и запас на очередь */
  staleMs: 60_000,
} as const;

/** NOT_ALLOWED — нет разрешения или запрет (себя, вложенный вызов); NOT_INSTALLED — вызываемой нет у этого человека или она ему не допущена */
export type ProgramCallErrorCode = 'NOT_ALLOWED' | 'NOT_INSTALLED' | 'NO_METHOD' | 'LIMIT' | 'TIMEOUT' | 'FAILED';
export const PROGRAM_ERROR_CODES: readonly ProgramCallErrorCode[] = ['NOT_ALLOWED', 'NOT_INSTALLED', 'NO_METHOD', 'LIMIT', 'TIMEOUT', 'FAILED'];
/** Вызов как он идёт по мосту: метод лежит внутри `call`, а не на верхнем уровне сообщения (мост читает верхний `method` как запись) */
export interface ProgramCall { program: string; method: string; data?: unknown }
export type ProgramReply = { ok: true; data: unknown } | { ok: false; code: ProgramCallErrorCode };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Раздел `exports`: любое лишнее или неверное поле — отказ целиком; `does` — текст для человека (он виден владельцу при проверке) */
export function parseExports(raw: unknown): ModuleExport[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > EXPORTS_MAX) return null;
  const out: ModuleExport[] = [];
  for (const item of raw) {
    if (!isObject(item) || Object.keys(item).some(k => k !== 'method' && k !== 'does')
      || typeof item.method !== 'string' || !EXPORT_METHOD.test(item.method) || out.some(e => e.method === item.method)
      || typeof item.does !== 'string' || !humanText(item.does, 12, 240, 3)) return null;
    out.push({ method: item.method, does: item.does.trim() });
  }
  return out;
}
/** Объявленные методы (в проверенном выпуске они уже прошли схему; повторный разбор — защита главного процесса) */
export const exportsOf = (manifest: { exports?: unknown } | null | undefined): ModuleExport[] => parseExports(manifest?.exports) || [];
