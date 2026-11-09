import { MODULE_ID, MODULE_VERSION } from '../modules/trust/claims';

export const MODULE_FAILURES = ['crash', 'timeout', 'memory', 'bridge', 'controls', 'connection'] as const;
export type ModuleFailure = typeof MODULE_FAILURES[number];
export interface ModuleDiagnostics { code?: ModuleFailure; frames?: string[] }
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
  return { ...(code ? { code } : {}), ...(frames.length ? { frames } : {}) };
}

export function validateModuleContext(r: Record<string, unknown>): { ok: boolean; value?: ModuleFeedbackContext; error?: string } {
  const keys = ['moduleId', 'moduleVersion', 'moduleChannel', 'moduleApiVersion', 'moduleDeveloper', 'moduleDiagnostics'];
  if (!keys.some((k) => r[k] !== undefined)) return { ok: true, value: {} };
  if (typeof r.moduleId !== 'string' || !MODULE_ID.test(r.moduleId)
    || typeof r.moduleVersion !== 'string' || !MODULE_VERSION.test(r.moduleVersion)
    || !['test', 'production'].includes(String(r.moduleChannel))) {
    return { ok: false, error: 'Нужны подпрограмма, её версия и канал' };
  }
  if (r.moduleApiVersion !== undefined && (typeof r.moduleApiVersion !== 'string' || r.moduleApiVersion.length > 40)) return { ok: false, error: 'Неверная версия API подпрограммы' };
  if (r.moduleDeveloper !== undefined && (typeof r.moduleDeveloper !== 'string' || r.moduleDeveloper.length > 200)) return { ok: false, error: 'Неверное имя разработчика' };
  if (r.moduleDiagnostics !== undefined) {
    const d = r.moduleDiagnostics as any;
    if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some((k) => !['code', 'frames'].includes(k))
      || (d.code !== undefined && !MODULE_FAILURES.includes(d.code))
      || (d.frames !== undefined && (!Array.isArray(d.frames) || d.frames.length > 12 || d.frames.some((f: unknown) => typeof f !== 'string' || f.length > 1000)))) {
      return { ok: false, error: 'Диагностика подпрограммы содержит неизвестные данные' };
    }
  }
  return { ok: true, value: {
    moduleId: r.moduleId, moduleVersion: r.moduleVersion, moduleChannel: r.moduleChannel as 'test' | 'production',
    ...(r.moduleApiVersion !== undefined ? { moduleApiVersion: r.moduleApiVersion as string } : {}),
    ...(r.moduleDeveloper !== undefined ? { moduleDeveloper: r.moduleDeveloper as string } : {}),
    ...(r.moduleDiagnostics !== undefined ? { moduleDiagnostics: safeModuleDiagnostics(r.moduleDiagnostics) } : {}),
  } };
}
