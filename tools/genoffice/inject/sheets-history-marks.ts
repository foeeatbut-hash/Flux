/**
 * Метки Flux на шагах «назад» книги. Действие Flux, меняющее схему, записывает в хосте пару
 * «прежняя / новая схема» и просит редактор пометить свои шаги (flux:mark-history). Когда такой
 * шаг отменяется или повторяется (клавиша и кнопка идут одним путём), редактор сообщает хосту,
 * и тот пишет в файл прежнюю или новую схему. Без этого Ctrl+Z возвращал бы таблицу,
 * а схема в файле оставалась новой.
 *
 * Шаги не перехватываем в сервисе Univer (инжектор отдаёт ленивую обёртку, и подмена методов
 * прототипа до команд не доходит): следим за стеками по событию состояния «назад/вперёд», которое
 * сервис выдаёт после каждой записи, отмены и повтора.
 */
type Step = { fluxAt?: number; fluxMark?: string }

interface Service {
  _undoStacks?: Map<string, Step[]>
  _redoStacks?: Map<string, Step[]>
  undoRedoStatus$?: { subscribe: (fn: () => void) => { unsubscribe: () => void } }
}

const all = (stacks: Map<string, Step[]> | undefined): Step[] => [...(stacks?.values() || [])].flat()

export function installSheetsHistoryMarks(getService: () => Service | undefined, notify: (step: { id: string; direction: 'undo' | 'redo' }) => void): { mark: (id: string, since: number) => number } {
  let watched: Map<string, Step[]> | undefined
  let subscription: { unsubscribe: () => void } | undefined
  // Помеченные шаги, какими они были в прошлый раз: переход из одного стека в другой — это отмена или повтор
  let markedUndo = new Set<Step>()
  let markedRedo = new Set<Step>()

  const scan = (): void => {
    const service = getService()
    const undo = all(service?._undoStacks)
    const redo = all(service?._redoStacks)
    const now = Date.now()
    // Новый шаг получает время, в которое он впервые замечен: сервис сообщает о записи сразу
    for (const step of undo) if (step.fluxAt === undefined) step.fluxAt = now
    const nextUndo = new Set(undo.filter((step) => step.fluxMark))
    const nextRedo = new Set(redo.filter((step) => step.fluxMark))
    const back = [...nextRedo].filter((step) => markedUndo.has(step) && !markedRedo.has(step))
    const forth = [...nextUndo].filter((step) => markedRedo.has(step) && !markedUndo.has(step))
    markedUndo = nextUndo
    markedRedo = nextRedo
    for (const step of back) notify({ id: step.fluxMark!, direction: 'undo' })
    for (const step of forth) notify({ id: step.fluxMark!, direction: 'redo' })
  }

  // Сервис пересоздаётся вместе с книгой: подписываемся заново
  const ensure = (): void => {
    const service = getService()
    if (!service?._undoStacks || service._undoStacks === watched) return
    subscription?.unsubscribe()
    watched = service._undoStacks
    subscription = service.undoRedoStatus$?.subscribe(scan)
    scan()
  }
  ensure()
  setInterval(() => { ensure(); scan() }, 300)

  return {
    mark: (id, since) => {
      ensure()
      scan()
      let marked = 0
      for (const step of all(getService()?._undoStacks)) {
        if (step.fluxAt !== undefined && step.fluxAt >= since) { step.fluxMark = id; marked++ }
      }
      scan()
      return marked
    },
  }
}
