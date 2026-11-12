import { MODULE_ID, MODULE_VERSION } from '../modules/trust/claims';

export const MODULE_FAILURES = ['crash', 'timeout', 'memory', 'bridge', 'controls', 'connection'] as const;
export type ModuleFailure = typeof MODULE_FAILURES[number];
/** `journal` — строки журнала программы, которые человек сам приложил к обращению (до 30 строк, без людей и проектов) */
export const JOURNAL_ATTACH_LINES = 30;
export const JOURNAL_ATTACH_LINE = 240;
export interface ModuleDiagnostics { code?: ModuleFailure; frames?: string[]; journal?: string[] }
export interface ModuleFeedbackContext {
  moduleId?: string;
  moduleVersion?: string;
  moduleChannel?: 'test' | 'production';
  moduleApiVersion?: string;
  moduleDeveloper?: string;
  moduleDiagnostics?: ModuleDiagnostics;
}

/** Журнал Flux и произвольные значения не могут стать «диагностикой модуля». */
export function safeModuleDiagnostics(raw: unknown): ModuleDiagnostics {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const code = MODULE_FAILURES.includes(r.code as ModuleFailure) ? r.code as ModuleFailure : undefined;
  // От стека остаются только имена исходных файлов и координаты: локальные
  // пути, аргументы и сообщение исключения могут содержать данные проекта.
  const frames = Array.isArray(r.frames) ? r.frames.filter((x): x is string => typeof x === 'string').slice(0, 12)
    .map((x) => x.match(/(?:^|[/\\(\s])([a-zA-Z0-9_.-]+\.(?:js|ts|tsx|py|wasm)):(\d{1,8}):(\d{1,8})(?:\)?$)/))
    .filter(Boolean).map((m) => `${m![1]}:${m![2]}:${m![3]}`) : [];
  const journal = Array.isArray(r.journal) ? r.journal.filter((x): x is string => typeof x === 'string').slice(0, JOURNAL_ATTACH_LINES)
    .map((x) => x.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, JOURNAL_ATTACH_LINE)) : [];
  return { ...(code ? { code } : {}), ...(frames.length ? { frames } : {}), ...(journal.length ? { journal } : {}) };
}

export function validateModuleContext(r: Record<string, unknown>): { ok: boolean; value?: ModuleFeedbackContext; error?: string } {
  const keys = ['moduleId', 'moduleVersion', 'moduleChannel', 'moduleApiVersion', 'moduleDeveloper', 'moduleDiagnostics'];
  if (!keys.some((k) => r[k] !== undefined)) return { ok: true, value: {} };
  if (typeof r.moduleId !== 'string' || !MODULE_ID.test(r.moduleId)
    || typeof r.moduleVersion !== 'string' || !MODULE_VERSION.test(r.moduleVersion)
    || !['test', 'production'].includes(String(r.moduleChannel))) {
    return { ok: false, error: 'Нужны программа, её версия и канал' };
  }
  if (r.moduleApiVersion !== undefined && (typeof r.moduleApiVersion !== 'string' || r.moduleApiVersion.length > 40)) return { ok: false, error: 'Неверная версия API программы' };
  if (r.moduleDeveloper !== undefined && (typeof r.moduleDeveloper !== 'string' || r.moduleDeveloper.length > 200)) return { ok: false, error: 'Неверное имя разработчика' };
  if (r.moduleDiagnostics !== undefined) {
    const d = r.moduleDiagnostics as any;
    if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some((k) => !['code', 'frames', 'journal'].includes(k))
      || (d.code !== undefined && !MODULE_FAILURES.includes(d.code))
      || (d.frames !== undefined && (!Array.isArray(d.frames) || d.frames.length > 12 || d.frames.some((f: unknown) => typeof f !== 'string' || f.length > 1000)))
      || (d.journal !== undefined && (!Array.isArray(d.journal) || d.journal.length > JOURNAL_ATTACH_LINES || d.journal.some((f: unknown) => typeof f !== 'string' || f.length > JOURNAL_ATTACH_LINE)))) {
      return { ok: false, error: 'Диагностика программы содержит неизвестные данные' };
    }
  }
  return { ok: true, value: {
    moduleId: r.moduleId, moduleVersion: r.moduleVersion, moduleChannel: r.moduleChannel as 'test' | 'production',
    ...(r.moduleApiVersion !== undefined ? { moduleApiVersion: r.moduleApiVersion as string } : {}),
    ...(r.moduleDeveloper !== undefined ? { moduleDeveloper: r.moduleDeveloper as string } : {}),
    ...(r.moduleDiagnostics !== undefined ? { moduleDiagnostics: safeModuleDiagnostics(r.moduleDiagnostics) } : {}),
  } };
}
