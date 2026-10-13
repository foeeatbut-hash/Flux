/**
 * Метки Flux на шагах «назад» документа (Yjs UndoManager). Действие Flux, меняющее схему, просит
 * редактор пометить свои шаги (markFluxHistory); когда такой шаг отменяется или повторяется,
 * редактор сообщает хосту (flux:history-step), и тот пишет в файл прежнюю или новую схему.
 * Путь один и для клавиш, и для кнопок: событие UndoManager не зависит от того, откуда пришла команда.
 */
type Manager = {
  undoStack: Array<{ meta: Map<unknown, unknown> }>
  redoStack: Array<{ meta: Map<unknown, unknown> }>
  on: (event: string, fn: (e: any) => void) => void
  stopCapturing: () => void
}

export function createDocsHistoryMarks(manager: () => Manager | undefined, notify: (step: { id: string; direction: 'undo' | 'redo' }) => void) {
  // UndoManager пересоздаётся вместе с плагином (reviveUndoManager): слушаем каждый экземпляр один раз
  const attached = new WeakSet<object>()
  const attach = (): Manager | undefined => {
    const um = manager()
    if (!um || attached.has(um)) return um
    attached.add(um)
    // Метка времени нужна, чтобы отличить шаги действия Flux от чужих правок
    const stamp = ({ stackItem }: any): void => { stackItem.meta.set('fluxAt', Date.now()) }
    um.on('stack-item-added', stamp)
    um.on('stack-item-updated', stamp)
    um.on('stack-item-popped', ({ stackItem, type }: any) => {
      const id = stackItem.meta.get('fluxMark')
      if (typeof id !== 'string') return
      // Запись для обратного хода создана до этого события и метки не имеет: переносим
      const other = type === 'undo' ? um.redoStack : um.undoStack
      other[other.length - 1]?.meta.set('fluxMark', id)
      notify({ id, direction: type === 'redo' ? 'redo' : 'undo' })
    })
    return um
  }
  return {
    attach,
    mark: (id: string, since: number): number => {
      const um = attach()
      if (!um) return 0
      let marked = 0
      for (const item of um.undoStack) {
        const at = item.meta.get('fluxAt')
        if (typeof at === 'number' && at >= since) { item.meta.set('fluxMark', id); marked++ }
      }
      // Следующая правка человека не должна склеиваться с помеченным шагом
      um.stopCapturing()
      return marked
    },
  }
}
