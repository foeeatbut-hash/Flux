/**
 * Tracks save checkpoints without changing GenOffice's edit journal. Flux keeps
 * the original workbook baseline and cumulative journal across normal saves;
 * this sidecar only records which journal revision the writer acknowledged.
 */
interface CheckpointState {
  revision: number
  acknowledged: number
}

const checkpoints = new WeakMap<object, CheckpointState>()
const saveQueues = new WeakMap<object, Promise<void>>()

function createState(): CheckpointState {
  return { revision: 0, acknowledged: 0 }
}

/** Mark a newly created workbook journal as clean and save-trackable. */
export function initializeSheetsSaveCheckpoint(journal: object): void {
  if (!checkpoints.has(journal)) checkpoints.set(journal, createState())
}

/** Record a journal mutation, including same-count edits and undo-to-empty. */
export function markSheetsJournalChanged(journal: object): number {
  let state = checkpoints.get(journal)
  if (!state) {
    state = createState()
    checkpoints.set(journal, state)
  }
  state.revision += 1
  return state.revision
}

/** Capture this revision inside the serialized save task, immediately pre-IPC. */
export function captureSheetsSaveCheckpoint(journal: object): number | undefined {
  return checkpoints.get(journal)?.revision
}

/** Acknowledge no later than the captured revision; older replies cannot regress state. */
export function acknowledgeSheetsSaveCheckpoint(journal: object, capturedRevision: number): void {
  const state = checkpoints.get(journal)
  if (!state || !Number.isFinite(capturedRevision)) return
  state.acknowledged = Math.max(state.acknowledged, Math.min(capturedRevision, state.revision))
}

export function isSheetsJournalTracked(journal: object): boolean {
  return checkpoints.has(journal)
}

/** Preserve legacy count behavior for untracked journals; tracked dirtiness is revision-based. */
export function pendingSheetsJournalSize(journal: object, cumulativeSize: number): number {
  const state = checkpoints.get(journal)
  if (!state) return cumulativeSize
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
