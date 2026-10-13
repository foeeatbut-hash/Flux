/**
 * Привязанные ячейки шапки в покое: параметры показаны плашками, а не голым текстом.
 * Холст Univer рисует только текст, поэтому поверх него лежит слой DOM по видимым привязанным
 * ячейкам. Слой не перехватывает мышь (щелчки идут в холст, правый щелчок открывает меню Flux
 * как для обычной ячейки), следует за прокруткой, масштабом, шириной столбцов и сменой листа
 * и прячется под окном ввода, пока ячейка правится.
 */
import { installParameterChipStyle, partChipLabel } from './parameter-chip-style'

type Part = Record<string, any>

interface Bound { anchorId: string; sheetName: string; address: string }

interface Deps {
  workbook: () => any
  bound: () => Bound[]
  /** Части ячейки, известные редактору (кэш схемы); null — схема ещё не пришла */
  parts: (anchorId: string) => Part[] | null
  isEditing: (anchorId: string) => boolean
}

const OPERATORS = new Set(['+', '-', '*', '/', '(', ')'])

export function createSheetsIdleChips(deps: Deps) {
  let layer: HTMLDivElement | null = null
  const cells = new Map<string, { box: HTMLDivElement; signature: string }>()
  let rescanAt = 0
  let list: Bound[] = []

  const ensureLayer = (): HTMLDivElement => {
    if (layer?.isConnected) return layer
    installParameterChipStyle()
    layer = document.createElement('div')
    layer.id = 'flux-sheet-chip-layer'
    layer.setAttribute('aria-hidden', 'true')
    layer.style.cssText = 'position:fixed;z-index:100;overflow:hidden;pointer-events:none;left:0;top:0;width:0;height:0'
    document.body.appendChild(layer)
    return layer
  }

  const canvasOf = (): HTMLCanvasElement | null => document.querySelector('canvas[id^="univer-sheet-main-canvas"]')

  const dark = (): boolean => document.documentElement.getAttribute('data-theme') === 'dark'
    || (!document.documentElement.hasAttribute('data-theme') && window.matchMedia?.('(prefers-color-scheme: dark)').matches)

  const render = (box: HTMLDivElement, anchorId: string, cellText: string): string => {
    const parts = deps.parts(anchorId)
    const fieldCount = parts ? parts.filter((part) => part.kind === 'field' || part.kind === 'union').length : 0
    const pieces: Array<{ chip: boolean; text: string }> = parts?.length
      ? parts.map((part) => part.kind === 'field' || part.kind === 'union'
        ? { chip: true, text: partChipLabel(part, fieldCount === 1 && parts.length === 1, cellText) }
        : { chip: false, text: part.kind === 'operator' && OPERATORS.has(part.operator) ? part.operator : String(part.text || '') })
      : cellText ? [{ chip: true, text: cellText }] : []
    const signature = JSON.stringify(pieces)
    if (box.dataset.signature === signature) return signature
    box.dataset.signature = signature
    box.dataset.title = pieces.map((piece) => piece.text).join('')
    box.replaceChildren(...pieces.map((piece) => {
      const node = document.createElement('span')
      node.textContent = piece.text
      if (piece.chip) { node.className = 'flux-sheet-idle-chip'; node.style.maxWidth = 'none' }
      else node.style.whiteSpace = 'pre'
      return node
    }))
    // Естественная ширина содержимого: по ней плашка решает, сколько пустых соседей занять
    const keep = box.style.width
    box.style.width = 'max-content'
    box.dataset.natural = String(box.offsetWidth)
    box.style.width = keep
    return signature
  }

  const measure = (() => {
    let ctx: CanvasRenderingContext2D | null = null
    return (text: string): number => {
      ctx ||= document.createElement('canvas').getContext('2d')
      if (!ctx) return text.length * 8
      ctx.font = '14.7px Arial, sans-serif'
      return ctx.measureText(text).width * 1.1
    }
  })()

  // Подсказка с полным названием: слой не ловит мышь, поэтому ищем плашку под курсором сами
  let tip: HTMLDivElement | null = null
  const onMove = (event: MouseEvent): void => {
    let hit: HTMLDivElement | null = null
    for (const { box } of cells.values()) {
      if (box.style.display === 'none') continue
      const r = box.getBoundingClientRect()
      if (event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom) { hit = box; break }
    }
    if (!hit || !hit.dataset.title) { if (tip) tip.style.display = 'none'; return }
    if (!tip || !tip.isConnected) {
      tip = document.createElement('div')
      tip.style.cssText = 'position:fixed;z-index:101;pointer-events:none;padding:3px 8px;border-radius:4px;font:12px/1.3 system-ui,sans-serif;background:#0f172a;color:#f8fafc;max-width:420px;box-shadow:0 2px 8px rgba(0,0,0,.3)'
      document.body.appendChild(tip)
    }
    tip.textContent = hit.dataset.title
    tip.style.display = ''
    tip.style.left = `${Math.min(event.clientX + 12, window.innerWidth - 430)}px`
    tip.style.top = `${event.clientY + 18}px`
  }
  document.addEventListener('mousemove', onMove, true)

  /** A1 → [строка, столбец] с нуля */
  const cellIndex = (address: string): [number, number] | null => {
    const m = /^([A-Z]{1,3})(\d+)$/i.exec(address)
    if (!m) return null
    let col = 0
    for (const ch of m[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64
    return [Number(m[2]) - 1, col - 1]
  }

  const tick = (): void => {
    const wb = deps.workbook()
    const canvas = canvasOf()
    if (!wb || !canvas || !canvas.isConnected) { if (layer) layer.style.display = 'none'; return }
    const host = ensureLayer()
    const now = Date.now()
    if (now >= rescanAt) { list = deps.bound(); rescanAt = now + 400 }
    const sheet = wb.getActiveSheet?.()
    const activeName = String(sheet?.getSheetName?.() || '')
    const bounds = canvas.getBoundingClientRect()
    // Заголовки строк и столбцов рисуются тем же холстом: плашки под ними не заходят
    const config = sheet?._worksheet?.getConfig?.() || {}
    const headerLeft = Number(config.rowHeader?.width ?? 46) * (canvas.width > 0 ? bounds.width / canvas.width : 1)
    const headerTop = Number(config.columnHeader?.height ?? 20) * (canvas.height > 0 ? bounds.height / canvas.height : 1)
    host.style.display = ''
    host.style.left = `${bounds.left + headerLeft}px`
    host.style.top = `${bounds.top + headerTop}px`
    host.style.width = `${Math.max(0, bounds.width - headerLeft)}px`
    host.style.height = `${Math.max(0, bounds.height - headerTop)}px`
    const scaleX = canvas.width > 0 ? bounds.width / canvas.width : 1
    const scaleY = canvas.height > 0 ? bounds.height / canvas.height : 1
    const live = new Set<string>()
    for (const item of list) {
      if (item.sheetName !== activeName) continue
      live.add(item.anchorId)
      let entry = cells.get(item.anchorId)
      if (!entry) {
        const box = document.createElement('div')
        box.style.cssText = 'position:absolute;display:flex;align-items:center;gap:1px;box-sizing:border-box;padding:0 3px;overflow:hidden;font:13px/1.3 system-ui,sans-serif'
        host.appendChild(box)
        entry = { box, signature: '' }
        cells.set(item.anchorId, entry)
      }
      const box = entry.box
      try {
        const range = sheet.getRange(item.address)
        const rect = range.getCellRect()
        const left = Number(rect.left) * scaleX - headerLeft
        const top = Number(rect.top) * scaleY - headerTop
        let width = Number(rect.width) * scaleX
        const height = Number(rect.height) * scaleY
        const text = String(range.getValue?.() ?? '')
        render(box, item.anchorId, text)
        // Как текст Excel: и плашки, и перелив исходного текста идут в пустые ячейки справа,
        // поэтому слой закрывает и их; занятая соседка останавливает (тогда многоточие)
        const need = Math.max(Number(box.dataset.natural || 0) + 2, measure(text) + 6)
        const at = cellIndex(item.address)
        if (at && need > width) {
          for (let k = 1; k <= 30 && width < need; k++) {
            const next = sheet.getRange(at[0], at[1] + k, 1, 1)
            if (String(next.getValue?.() ?? '') !== '') break
            const nextRect = next.getCellRect()
            if (!(Number(nextRect.width) > 0) || (Number(nextRect.left) * scaleX - headerLeft) + Number(nextRect.width) * scaleX > bounds.width) break
            width += Number(nextRect.width) * scaleX
          }
        }
        // Подложка прячет простой текст холста под плашками; цвет ячейки, если он задан
        const fill = String(range.getBackground?.() || '')
        // Прозрачная или пустая заливка не прячет текст холста: тогда берём цвет темы
        box.style.background = /^(?:#[0-9a-f]{6}|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\))$/i.test(fill.trim()) ? fill : (dark() ? '#111827' : '#ffffff')
        box.style.color = dark() ? '#e2e8f0' : '#0f172a'
        box.style.left = `${left + 1}px`
        box.style.top = `${top + 1}px`
        box.style.width = `${Math.max(0, width - 2)}px`
        box.style.height = `${Math.max(0, height - 2)}px`
        box.style.display = deps.isEditing(item.anchorId) || !box.childNodes.length ? 'none' : 'flex'
      } catch { box.style.display = 'none' }
    }
    for (const [id, entry] of cells) if (!live.has(id)) { entry.box.remove(); cells.delete(id) }
  }

  const loop = (): void => { try { tick() } catch { /* книга в переходном состоянии */ } requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  return { refresh: (): void => { rescanAt = 0 } }
}
