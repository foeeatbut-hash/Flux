import assert from 'node:assert/strict'
import {
  acknowledgeSheetsSaveCheckpoint,
  captureSheetsSaveCheckpoint,
  initializeSheetsSaveCheckpoint,
  isSheetsJournalTracked,
  markSheetsJournalChanged,
  pendingSheetsJournalSize,
  serializeSheetsSave,
  subscribeSheetsJournalChanges,
} from '../tools/genoffice/inject/sheets-save-checkpoint'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function main() {
  // A save of r1 cannot clear r2, even if the cumulative journal count is unchanged.
  {
    const journal = {}
    initializeSheetsSaveCheckpoint(journal)
    markSheetsJournalChanged(journal)
    const r1 = captureSheetsSaveCheckpoint(journal)!
    assert.equal(pendingSheetsJournalSize(journal, 1), 1)
    markSheetsJournalChanged(journal) // coalesced same-cell edit; count remains 1
    acknowledgeSheetsSaveCheckpoint(journal, r1)
    assert.equal(pendingSheetsJournalSize(journal, 1), 1)
    assert.equal(captureSheetsSaveCheckpoint(journal), r1 + 1)
  }

  // Undoing every journal entry still leaves one save-relevant revision.
  {
    const journal = {}
    initializeSheetsSaveCheckpoint(journal)
    markSheetsJournalChanged(journal)
    markSheetsJournalChanged(journal) // undo to an empty journal
    assert.equal(pendingSheetsJournalSize(journal, 0), 1)
  }

  // A failed save never acknowledges its checkpoint.
  {
    const journal = {}
    initializeSheetsSaveCheckpoint(journal)
    markSheetsJournalChanged(journal)
    const rev = captureSheetsSaveCheckpoint(journal)!
    assert.equal(pendingSheetsJournalSize(journal, 1), 1)
    // Failure path intentionally does not call acknowledge.
    assert.equal(rev, 1)
    assert.equal(pendingSheetsJournalSize(journal, 1), 1)
  }

  // Overlapping saves serialize. The second captures after the first completes
  // and sees the latest revision; a rejection does not poison the queue.
  {
    const journal = {}
    initializeSheetsSaveCheckpoint(journal)
    markSheetsJournalChanged(journal)
    const gate = deferred<void>()
    const order: string[] = []
    const first = serializeSheetsSave(journal, async () => {
      order.push('first-start')
      const rev = captureSheetsSaveCheckpoint(journal)!
      await gate.promise
      acknowledgeSheetsSaveCheckpoint(journal, rev)
      order.push('first-end')
      throw new Error('disk failed')
    })
    const second = serializeSheetsSave(journal, async () => {
      order.push('second-start')
      const rev = captureSheetsSaveCheckpoint(journal)!
      assert.equal(rev, 2)
      acknowledgeSheetsSaveCheckpoint(journal, rev)
      return 'saved'
    })
    await Promise.resolve()
    markSheetsJournalChanged(journal)
    assert.deepEqual(order, ['first-start'])
    gate.resolve()
    await assert.rejects(first, /disk failed/)
    assert.equal(await second, 'saved')
    assert.deepEqual(order, ['first-start', 'first-end', 'second-start'])
    assert.equal(pendingSheetsJournalSize(journal, 0), 0)
  }

  // New tracked journals start clean; legacy/untracked callers retain old counts.
  {
    const fresh = {}
    assert.equal(isSheetsJournalTracked(fresh), false)
    assert.equal(pendingSheetsJournalSize(fresh, 4), 4)
    await serializeSheetsSave(fresh, async () => undefined)
    assert.equal(isSheetsJournalTracked(fresh), false)
    assert.equal(pendingSheetsJournalSize(fresh, 4), 4)
    initializeSheetsSaveCheckpoint(fresh)
    assert.equal(isSheetsJournalTracked(fresh), true)
    assert.equal(pendingSheetsJournalSize(fresh, 4), 0)
    assert.equal(captureSheetsSaveCheckpoint(fresh), 0)
  }


  // Bypassed setters must never hide additions/removals in any collection.
  {
    const cases: Array<[string, () => { journal: object; mutate: () => void }]> = []
    for (const key of ['visualAdds', 'sparklineAdds', 'tableAdds', 'pivotAdds']) {
      cases.push([key, () => {
        const entries: unknown[] = []
        return { journal: { [key]: entries }, mutate: () => { entries.push({ id: 'new' }) } }
      }])
    }
    for (const key of ['chartEdits', 'visualEdits', 'sheetProtection', 'pageSetup', 'pivotRefreshUpdates']) {
      cases.push([key, () => {
        const entries = new Map<string, unknown>()
        return { journal: { [key]: entries }, mutate: () => { entries.set('s', {}) } }
      }])
    }
    for (const key of ['filterDirty', 'cfDirty', 'dvDirty', 'protectedRangesDirty', 'noteDirty', 'pivotCacheRefresh']) {
      cases.push([key, () => {
        const entries = new Set<string>()
        return { journal: { [key]: entries }, mutate: () => { entries.add('s') } }
      }])
    }
    for (const key of ['cells', 'hyperlinks']) {
      cases.push([key, () => {
        const child = new Map<string, unknown>()
        return { journal: { [key]: new Map([['s', child]]) }, mutate: () => { child.set('A1', {}) } }
      }])
    }
    for (const key of ['structuralOps', 'bulkConstantFills']) {
      cases.push([key, () => {
        const child: unknown[] = []
        return { journal: { [key]: new Map([['s', child]]) }, mutate: () => { child.push({}) } }
      }])
    }
    for (const key of ['added', 'removed', 'renamed', 'hidden']) {
      cases.push(['sheets.' + key, () => {
        const child = new Map<string, unknown>()
        return { journal: { sheets: { [key]: child } }, mutate: () => { child.set('s', {}) } }
      }])
    }
    for (const [label, setup] of cases) {
      const { journal, mutate } = setup()
      initializeSheetsSaveCheckpoint(journal)
      const saved = captureSheetsSaveCheckpoint(journal)!
      mutate()
      acknowledgeSheetsSaveCheckpoint(journal, saved)
      assert.equal(pendingSheetsJournalSize(journal, 0), 1, label + ' changed during save')
      acknowledgeSheetsSaveCheckpoint(journal, captureSheetsSaveCheckpoint(journal)!)
      assert.equal(pendingSheetsJournalSize(journal, 1), 0, label + ' acknowledged')
    }
  }
  // Equal aggregate counts still differ across separate journal collections.
  {
    const journal = { visualAdds: [{}], sparklineAdds: [] as unknown[] }
    initializeSheetsSaveCheckpoint(journal)
    journal.visualAdds.pop()
    journal.sparklineAdds.push({})
    assert.equal(pendingSheetsJournalSize(journal, 1), 1)
    acknowledgeSheetsSaveCheckpoint(journal, captureSheetsSaveCheckpoint(journal)!)
    journal.sparklineAdds.pop()
    assert.equal(pendingSheetsJournalSize(journal, 0), 1, 'unmarked undo-to-empty')
  }
  {
    const journal = {}
    initializeSheetsSaveCheckpoint(journal)
    let notices = 0
    const stop = subscribeSheetsJournalChanges(journal, () => { notices += 1 })
    markSheetsJournalChanged(journal)
    assert.equal(notices, 1)
    stop()
    markSheetsJournalChanged(journal)
    assert.equal(notices, 1)
  }

  console.log('Sheets save checkpoint tests passed')
}

void main()
