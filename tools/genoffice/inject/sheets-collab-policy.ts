const LOCAL = /^(formula\.|formula-ui\.|sheet\.mutation\.set-worksheet-row-auto-height)/
const DEFINED_NAME = /^formula\.mutation\.(?:set|remove)-defined-name$/

export interface DefinedNameMutationParams {
  id?: unknown
  name?: unknown
  localSheetId?: unknown
  [key: string]: unknown
}

export interface DefinedNameIdentity {
  id: string
  name: string
  localSheetId?: string
}

export type DefinedNameResolution =
  | { ok: true; params: DefinedNameMutationParams }
  | { ok: false; reason: 'missing-name' | 'missing-id' | 'remove-target-missing' }

/** Имена книги сохраняются между загрузками; остальные мутации формул остаются локальными. */
export function isLocalOnlyCollabMutation(id: string): boolean {
  if (!LOCAL.test(id)) return false
  return !DEFINED_NAME.test(id)
}

/** Сопоставляет имена по логическому ключу: идентификаторы после импорта у участников разные. */
export function resolveDefinedNameMutation(
  id: string,
  params: DefinedNameMutationParams,
  names: readonly DefinedNameIdentity[],
): DefinedNameResolution {
  const name = typeof params.name === 'string' ? params.name : ''
  if (!name) return { ok: false, reason: 'missing-name' }
  if (typeof params.id !== 'string' || !params.id) return { ok: false, reason: 'missing-id' }

  const localSheetId = typeof params.localSheetId === 'string' ? params.localSheetId : undefined
  const existing = names.find((entry) => entry.name === name && entry.localSheetId === localSheetId)
  if (id === 'formula.mutation.remove-defined-name' && !existing) {
    // У получателя имени нет: повторное удаление уже выполнено по смыслу.
    return { ok: false, reason: 'remove-target-missing' }
  }

  return { ok: true, params: { ...params, id: existing?.id ?? params.id } }
}

export function isDefinedNameMutation(id: string): boolean {
  return DEFINED_NAME.test(id)
}

export function mapDefinedNameScope(
  scope: unknown,
  sourceSheetNames: Record<string, string> | undefined,
  targetSheetIds: ReadonlyMap<string, string>,
): unknown {
  if (typeof scope !== 'string') return scope
  const sheetName = sourceSheetNames?.[scope]
  return sheetName ? targetSheetIds.get(sheetName) ?? scope : scope
}
