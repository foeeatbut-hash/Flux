import { MODULE_ID, MODULE_VERSION } from '../modules/trust/claims';
import { MODULE_FAILURES, type ModuleFailure } from './moduleContext';
export interface ModuleCrashCount { moduleId: string; version: string; kind: ModuleFailure; count: number }
export interface ModuleCrashBatch { id: string; events: ModuleCrashCount[] }
export function validCrashBatch(raw: unknown): raw is ModuleCrashBatch {
  const b = raw as ModuleCrashBatch;
  return !!b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).every((k) => ['id', 'events'].includes(k))
    && typeof b.id === 'string' && /^[0-9a-f-]{36}$/i.test(b.id)
    && Array.isArray(b.events) && b.events.length > 0 && b.events.length <= 100
    && b.events.every((e) => e && Object.keys(e).every((k) => ['moduleId', 'version', 'kind', 'count'].includes(k))
      && typeof e.moduleId === 'string' && MODULE_ID.test(e.moduleId) && typeof e.version === 'string' && MODULE_VERSION.test(e.version)
      && MODULE_FAILURES.includes(e.kind) && Number.isSafeInteger(e.count) && e.count > 0 && e.count <= 1000);
}
