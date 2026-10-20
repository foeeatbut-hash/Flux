/**
 * Tracks save checkpoints without changing GenOffice's edit journal. Flux keeps
 * the original workbook baseline and cumulative journal across normal saves;
 * this sidecar only records which journal revision the writer acknowledged.
 */
interface CheckpointState {
  revision: number
  acknowledged: number
  signature: string
}

const checkpoints = new WeakMap<object, CheckpointState>()
const saveQueues = new WeakMap<object, Promise<void>>()
const listeners = new WeakMap<object, Set<() => void>>()

/** Keep the save badge and close guard current even without setPendingEdits. */
export function subscribeSheetsJournalChanges(journal: object, listener: () => void): () => void {
  let current = listeners.get(journal)
  if (!current) { current = new Set(); listeners.set(journal, current) }
  current.add(listener)
  const subscribed = current
  return () => { subscribed.delete(listener) }
}

/**
 * Sizes remain an independent guard for mutation paths that do not emit the
 * pending-edit callback. Keep every collection (including per-sheet children)
 * separate: two operations may have equal totals but different journal shapes.
 * Values are tracked by mutator revisions, without serializing all cell data.
 */
function journalSignature(journal: object): string {
  const j = journal as Record<string, unknown>
  const sizes = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.length
    if (value instanceof Set) return value.size
    if (value instanceof Map) {
      return [value.size, [...value].map(([key, child]) => [
        String(key),
        child instanceof Map || child instanceof Set ? child.size :
          Array.isArray(child) ? child.length : null,
      ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]
    }
    if (value && typeof value === 'object') {
      return Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sizes(child)])
    }
    return value ?? null
  }
  return JSON.stringify(Object.keys(j).sort().map((key) => [key, sizes(j[key])]))
}

function createState(journal: object): CheckpointState {
  return { revision: 0, acknowledged: 0, signature: journalSignature(journal) }
}

function observeJournal(journal: object, state: CheckpointState): void {
  const signature = journalSignature(journal)
  if (signature !== state.signature) {
    state.signature = signature
    state.revision += 1
  }
}

/** Mark a newly created workbook journal as clean and save-trackable. */
export function initializeSheetsSaveCheckpoint(journal: object): void {
  if (!checkpoints.has(journal)) checkpoints.set(journal, createState(journal))
}

/** Record a journal mutation, including same-count edits and undo-to-empty. */
export function markSheetsJournalChanged(journal: object): number {
  let state = checkpoints.get(journal)
  if (!state) {
    state = createState(journal)
    checkpoints.set(journal, state)
  }
  state.signature = journalSignature(journal)
  state.revision += 1
  for (const listener of listeners.get(journal) ?? []) listener()
  return state.revision
}

/** Capture this revision inside the serialized save task, immediately pre-IPC. */
export function captureSheetsSaveCheckpoint(journal: object): number | undefined {
  const state = checkpoints.get(journal)
  if (!state) return undefined
  observeJournal(journal, state)
  return state.revision
}

/** Acknowledge no later than the captured revision; older replies cannot regress state. */
export function acknowledgeSheetsSaveCheckpoint(journal: object, capturedRevision: number): void {
  const state = checkpoints.get(journal)
  if (!state || !Number.isFinite(capturedRevision)) return
  observeJournal(journal, state)
  state.acknowledged = Math.max(state.acknowledged, Math.min(capturedRevision, state.revision))
}

export function isSheetsJournalTracked(journal: object): boolean {
  return checkpoints.has(journal)
}

/** Clean requires both an acknowledged revision and an unchanged journal signature. */
export function pendingSheetsJournalSize(journal: object, cumulativeSize: number): number {
  const state = checkpoints.get(journal)
  if (!state) return cumulativeSize
  observeJournal(journal, state)
  if (state.revision === state.acknowledged) return 0
  return Math.max(1, cumulativeSize)
}

/** Serialize saves per journal while keeping the queue usable after rejection. */
export function serializeSheetsSave<T>(journal: object, task: () => Promise<T>): Promise<T> {
  const queue = saveQueues.get(journal) ?? Promise.resolve()
  const result = queue.then(task, task)
  saveQueues.set(journal, result.then(() => undefined, () => undefined))
  return result
}
