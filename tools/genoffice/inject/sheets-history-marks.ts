/**
 * Метки Flux на шагах «назад» книги. Действие Flux, меняющее схему, записывает в хосте пару
 * «прежняя / новая схема» и просит редактор пометить свои шаги (flux:mark-history). Когда такой
 * шаг отменяется или повторяется командой Univer (клавиша или кнопка — путь один), редактор
 * сообщает хосту, и тот пишет в файл прежнюю или новую схему. Без этого Ctrl+Z возвращал бы
 * таблицу, а схема в файле оставалась новой.
 */
type Step = { fluxAt?: number; fluxMark?: string }

interface Service {
  _undoStacks?: Map<string, Step[]>
  _redoStacks?: Map<string, Step[]>
  pushUndoRedo: (item: { unitID: string }) => void
  popUndoToRedo: () => void
  popRedoToUndo: () => void
  _getUndoStackForFocused: () => Step[]
  _getRedoStackForFocused: () => Step[]
  __fluxMarks?: boolean
}

export function installSheetsHistoryMarks(service: Service | undefined, notify: (step: { id: string; direction: 'undo' | 'redo' }) => void): { mark: (id: string, since: number) => number } | null {
  if (!service) return null
  if (!service.__fluxMarks) {
    service.__fluxMarks = true
    const push = service.pushUndoRedo.bind(service)
    // Метка времени на верхнем шаге: так хост отличает шаги своего действия от чужих правок
    service.pushUndoRedo = (item) => {
      push(item)
      const stack = service._undoStacks?.get(item.unitID)
      const top = stack?.[stack.length - 1]
      if (top) top.fluxAt = Date.now()
    }
    const undo = service.popUndoToRedo.bind(service)
    service.popUndoToRedo = () => {
      const stack = service._getUndoStackForFocused()
      const top = stack?.[stack.length - 1]
      undo()
      if (top?.fluxMark) notify({ id: top.fluxMark, direction: 'undo' })
    }
    const redo = service.popRedoToUndo.bind(service)
    service.popRedoToUndo = () => {
      const stack = service._getRedoStackForFocused()
      const top = stack?.[stack.length - 1]
      redo()
      if (top?.fluxMark) notify({ id: top.fluxMark, direction: 'redo' })
    }
  }
  return {
    mark: (id, since) => {
      let marked = 0
      for (const stack of service._undoStacks?.values() || []) {
        for (const step of stack) if (step.fluxAt !== undefined && step.fluxAt >= since) { step.fluxMark = id; marked++ }
      }
      return marked
    },
  }
}
