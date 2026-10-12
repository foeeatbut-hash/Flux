/** Дополнение к canvas-редактору: формула редактируется поверх настоящей ячейки. */
type Part = Record<string, any>

interface Ipc {
  send(channel: string, ...args: unknown[]): void
  on(channel: string, fn: (event: unknown, ...args: any[]) => void): unknown
  invoke?(channel: string, ...args: unknown[]): Promise<any>
}

interface CellTarget { range: any; sheetName: string; address: string }

export function createSheetsTokenOverlay(
  ipc: Ipc,
  resolveCell: (anchorId: string) => CellTarget | null,
  writeCell: (range: any, value: string) => boolean,
  canEdit: () => boolean,
) {
  let active: { anchorId: string; range: any; sheetName: string; address: string; host: HTMLDivElement; root: HTMLDivElement; caret: Range | null; parts: Part[]; selectionHandler: () => void; menu: HTMLDivElement | null; modalOpen: boolean } | null = null
  let composing = false
  let fluxTheme = 'light'
  const setTheme = (theme: unknown): void => {
    fluxTheme = String(theme || '').toLowerCase().includes('dark') ? 'dark' : 'light'
    if (active) {
      active.root.dataset.theme = fluxTheme
      if (active.menu) active.menu.dataset.theme = fluxTheme
    }
  }
  void ipc.invoke?.('app:get-theme').then(setTheme).catch(() => undefined)
  ipc.on('app:theme-changed', (_event, theme: unknown) => setTheme(theme))

  const installStyle = (): void => {
    if (document.getElementById('flux-sheet-token-style')) return
    const style = document.createElement('style')
    style.id = 'flux-sheet-token-style'
    style.textContent = `
#flux-sheet-token-overlay{position:fixed;z-index:1200;display:flex;align-items:center;gap:5px;box-sizing:border-box;min-height:34px;padding:4px 6px;border:1px solid #94a3b8;border-radius:7px;background:#fff;color:#0f172a;box-shadow:0 8px 24px #0f172a33;font:13px/1.35 system-ui,sans-serif}
#flux-sheet-token-overlay .flux-sheet-token-edit{display:flex;align-items:center;gap:3px;flex:1;min-width:0;min-height:24px;outline:none;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
#flux-sheet-token-overlay .flux-sheet-token-chip{display:inline-flex;align-items:center;max-width:190px;padding:2px 7px;border:1px solid #bfdbfe;border-radius:999px;background:#eff6ff;color:#1e40af;white-space:nowrap;user-select:all}
#flux-sheet-token-overlay button{flex:none;border:0;border-radius:5px;padding:4px 7px;background:#f1f5f9;color:#334155;font:inherit;cursor:pointer}
#flux-sheet-token-overlay button[data-action=save]{background:#2563eb;color:#fff}
#flux-sheet-token-menu{position:fixed;z-index:1201;padding:4px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;box-shadow:0 5px 16px #0f172a33}
#flux-sheet-token-menu button{border:0;border-radius:4px;padding:6px 9px;background:transparent;color:#334155;font:12px system-ui,sans-serif;cursor:pointer}
#flux-sheet-token-menu button:hover{background:#f1f5f9}
#flux-sheet-token-overlay[data-theme=dark]{border-color:#475569;background:#111827;color:#e2e8f0;box-shadow:0 8px 24px #0009}
#flux-sheet-token-overlay[data-theme=dark] .flux-sheet-token-chip{border-color:#1d4ed8;background:#172554;color:#bfdbfe}
#flux-sheet-token-overlay[data-theme=dark] button{background:#334155;color:#e2e8f0}
#flux-sheet-token-overlay[data-theme=dark] button[data-action=save]{background:#2563eb;color:#fff}
#flux-sheet-token-menu[data-theme=dark]{border-color:#475569;background:#111827;box-shadow:0 5px 16px #0009}
#flux-sheet-token-menu[data-theme=dark] button{color:#e2e8f0}
#flux-sheet-token-menu[data-theme=dark] button:hover{background:#334155}
`
    document.head.appendChild(style)
  }

  const label = (part: Part): string => String(part?.binding?.displayName || part?.binding?.fieldKey || part?.label || part?.alternatives?.map((item: Part) => item?.displayName || item?.fieldKey).filter(Boolean).join(' / ') || 'Параметр')
  const renderText = (parts: Part[]): string => parts.map((part) => {
    if (part?.kind === 'text') return String(part.text || '')
    if (part?.kind === 'operator') return String(part.operator || '')
    if (part?.kind === 'field') return label(part)
    if (part?.kind === 'union') return String(part.label || label(part))
    return ''
  }).join('')

  const writeCaret = (range: Range): void => {
    const selection = window.getSelection()
    if (!selection) return
    selection.removeAllRanges()
    selection.addRange(range)
  }

  const rememberCaret = (): void => {
    if (!active) return
    const selection = window.getSelection()
    if (selection?.rangeCount && active.host.contains(selection.anchorNode)) active.caret = selection.getRangeAt(0).cloneRange()
  }

  const hasProtectedToken = (range: Range): boolean => {
    if (range.collapsed) return false
    return Array.from(active?.host.querySelectorAll('[data-flux-token="true"]') || []).some((token) => {
      try { return range.intersectsNode(token) } catch { return false }
    })
  }

  const touchesProtectedToken = (range: Range, inputType: string): boolean => {
    if (hasProtectedToken(range)) return true
    if (!range.collapsed) return false
    const backward = inputType === 'deleteContentBackward' || inputType === 'deleteWordBackward' || inputType === 'deleteSoftLineBackward'
    const forward = inputType === 'deleteContentForward' || inputType === 'deleteWordForward' || inputType === 'deleteSoftLineForward'
    if (!backward && !forward) return false
    const host = active?.host
    if (!host) return false
    let node: Node | null = range.startContainer
    while (node && node !== host && node.parentNode !== host) node = node.parentNode
    const parent = node === host ? node : node?.parentNode
    if (!parent) return false
    const siblings = Array.from(parent.childNodes)
    const nodeIndex = siblings.findIndex((child) => child === node)
    const at = node === parent ? range.startOffset : nodeIndex + (backward ? 1 : 0)
    const adjacent = siblings[backward ? at - 1 : at]
    return adjacent instanceof HTMLElement && adjacent.dataset.fluxToken === 'true'
  }

  const partsFromHost = (): Part[] => {
    const state = active
    if (!state) return []
    const raw: Part[] = []
    const text = (value: string): void => {
      let ordinary = ''
      const flush = (): void => { if (ordinary) raw.push({ kind: 'text', text: ordinary }); ordinary = '' }
      for (const character of value) {
        const operator = character === '×' ? '*' : character === '÷' ? '/' : character === '−' ? '-' : character
        if (['+', '-', '*', '/', '(', ')'].includes(operator)) { flush(); raw.push({ kind: 'operator', operator }) }
        else ordinary += character
      }
      flush()
    }
    const visit = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) { text(node.textContent || ''); return }
      if (!(node instanceof HTMLElement)) return
      if (node.dataset.fluxToken === 'true') {
        const index = Number(node.dataset.partIndex)
        const part = Number.isInteger(index) ? state.parts[index] : null
        if (part?.kind === 'field' || part?.kind === 'union') raw.push(part)
        return
      }
      for (const child of Array.from(node.childNodes)) visit(child)
    }
    for (const child of Array.from(state.host.childNodes)) visit(child)
    return raw.reduce<Part[]>((result, part) => {
      const prior = result[result.length - 1]
      if (part.kind === 'text' && prior?.kind === 'text') prior.text += part.text
      else result.push(part)
      return result
    }, [])
  }

  const addPart = (part: Part): void => {
    if (!active || !['field', 'union'].includes(String(part?.kind || ''))) return
    const selection = active.caret
    const chip = document.createElement('span')
    chip.className = 'flux-sheet-token-chip'
    chip.contentEditable = 'false'
    chip.dataset.fluxToken = 'true'
    chip.setAttribute('role', 'img')
    chip.setAttribute('aria-label', label(part))
    chip.textContent = label(part)
    // Храним привязку отдельно от разметки, чтобы ввод пользователя не мог её изменить.
    active.parts.push(part)
    chip.dataset.partIndex = String(active.parts.length - 1)
    if (selection && active.host.contains(selection.startContainer)) {
      selection.deleteContents()
      selection.insertNode(chip)
    } else active.host.appendChild(chip)
    const after = document.createRange()
    after.setStartAfter(chip)
    after.collapse(true)
    active.caret = after.cloneRange()
    writeCaret(after)
    active.host.focus()
  }

  const position = (): void => {
    if (!active) return
    const canvas = document.getElementById('univer-sheet-main-canvas') as HTMLCanvasElement | null
    if (!canvas || !canvas.isConnected) return
    try {
      const cell = active.range.getCellRect()
      const bounds = canvas.getBoundingClientRect()
      const scaleX = canvas.width > 0 ? bounds.width / canvas.width : 1
      const scaleY = canvas.height > 0 ? bounds.height / canvas.height : 1
      const width = Math.max(180, Math.min(520, Number(cell.width) * scaleX))
      const cellLeft = bounds.left + Number(cell.left) * scaleX
      const cellTop = bounds.top + Number(cell.top) * scaleY
      const cellRight = cellLeft + Number(cell.width) * scaleX
      const cellBottom = cellTop + Number(cell.height) * scaleY
      active.root.hidden = cellRight <= 0 || cellLeft >= window.innerWidth || cellBottom <= 0 || cellTop >= window.innerHeight
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, cellLeft))
      const top = Math.max(8, Math.min(window.innerHeight - 54, cellTop))
      active.root.style.left = `${left}px`
      active.root.style.top = `${top}px`
      active.root.style.width = `${width}px`
    } catch { /* виртуальная ячейка может исчезнуть при смене листа */ }
  }

  const close = (commit: boolean): void => {
    const state = active
    if (!state) return
    active = null
    state.menu?.remove()
    document.removeEventListener('selectionchange', state.selectionHandler)
    window.removeEventListener('resize', position)
    window.removeEventListener('scroll', position, true)
    if (commit) {
      const parts = partsFromHostFor(state.host, state.parts)
      const value = renderText(parts)
      if (writeCell(state.range, value)) ipc.send('flux:header-schema-edited', { anchorId: state.anchorId, parts })
      else ipc.send('flux:header-schema-edited', { anchorId: state.anchorId, parts, ok: false, error: 'Ячейка не обновлена: документ открыт только для чтения или книга изменилась' })
    } else ipc.send('flux:header-formula-edit-cancelled', { anchorId: state.anchorId })
    state.root.remove()
  }

  const open = (anchorId: string, schema: any): boolean => {
    if (!canEdit()) return false
    if (active?.anchorId === anchorId) {
      // Root may reopen the formula editor after a parameter picker closes.
      // Keep the user-edited DOM and saved caret instead of replacing them with
      // the schema snapshot from before the picker opened.
      active.modalOpen = false
      active.menu?.remove()
      active.menu = null
      active.host.focus()
      if (active.caret) writeCaret(active.caret)
      ipc.send('flux:header-formula-edit-started', { ok: true, anchorId, resumed: true })
      return true
    }
    const target = resolveCell(anchorId)
    const anchor = schema?.anchors?.find((item: any) => String(item?.id || '') === anchorId)
    if (!target || !anchor || !Array.isArray(anchor.parts)) return false
    if (active) close(false)
    installStyle()
    const root = document.createElement('div')
    root.id = 'flux-sheet-token-overlay'
    root.setAttribute('role', 'group')
    root.setAttribute('aria-label', 'Формула заголовка')
    root.dataset.theme = fluxTheme
    const host = document.createElement('div')
    host.className = 'flux-sheet-token-edit'
    host.contentEditable = 'true'
    host.setAttribute('role', 'textbox')
    host.setAttribute('aria-label', 'Формула заголовка')
    const buttons = (action: 'save' | 'cancel', title: string): HTMLButtonElement => {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.action = action
      button.textContent = title
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', () => close(action === 'save'))
      return button
    }
    root.append(host, buttons('save', 'Готово'), buttons('cancel', 'Отмена'))
    const selectionHandler = (): void => rememberCaret()
    active = { anchorId, range: target.range, sheetName: target.sheetName, address: target.address, host, root, caret: null, parts: anchor.parts.map((part: Part) => ({ ...part })), selectionHandler, menu: null, modalOpen: false }
    const state = active
    for (let index = 0; index < state.parts.length; index++) {
      const part = state.parts[index]!
      if (part.kind === 'field' || part.kind === 'union') {
        const chip = document.createElement('span')
        chip.className = 'flux-sheet-token-chip'
        chip.contentEditable = 'false'
        chip.dataset.fluxToken = 'true'
        chip.dataset.partIndex = String(index)
        chip.setAttribute('role', 'img')
        chip.setAttribute('aria-label', label(part))
        chip.textContent = label(part)
        host.appendChild(chip)
      } else {
        const span = document.createElement('span')
        span.textContent = part.kind === 'text' ? String(part.text || '') : part.kind === 'operator' ? String(part.operator || '') : ''
        host.appendChild(span)
      }
    }
    if (!host.childNodes.length) host.appendChild(document.createTextNode(''))
    document.body.appendChild(root)
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    host.addEventListener('input', rememberCaret)
    host.addEventListener('compositionstart', () => { composing = true })
    host.addEventListener('compositionend', () => { composing = false; rememberCaret() })
    host.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(false) }
      else if (event.key === 'Enter' && !event.shiftKey && !composing) { event.preventDefault(); close(true) }
    })
    host.addEventListener('beforeinput', (event: InputEvent) => {
      if (!event.inputType.startsWith('delete')) return
      const selection = window.getSelection()
      if (selection?.rangeCount && touchesProtectedToken(selection.getRangeAt(0), event.inputType)) event.preventDefault()
    })
    host.addEventListener('paste', (event) => {
      event.preventDefault()
      const selection = window.getSelection()
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null
      if (!range || hasProtectedToken(range)) return
      const value = event.clipboardData?.getData('text/plain') || ''
      range.deleteContents()
      const text = document.createTextNode(value)
      range.insertNode(text)
      range.setStartAfter(text)
      range.collapse(true)
      active && (active.caret = range.cloneRange())
      writeCaret(range)
    })
    host.addEventListener('contextmenu', (event) => {
      const token = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-flux-token="true"]') : null
      event.preventDefault()
      event.stopPropagation()
      rememberCaret()
      state.menu?.remove()
      const menu = document.createElement('div')
      menu.id = 'flux-sheet-token-menu'
      menu.dataset.theme = fluxTheme
      menu.setAttribute('role', 'menu')
      menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 170, event.clientX))}px`
      menu.style.top = `${Math.max(8, Math.min(window.innerHeight - 48, event.clientY))}px`
      const addMenuItem = (title: string, action: () => void): void => {
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('role', 'menuitem')
        button.textContent = title
        button.addEventListener('mousedown', (press) => press.preventDefault())
        button.addEventListener('click', action)
        menu.appendChild(button)
      }
      if (token && host.contains(token)) addMenuItem('Удалить параметр', () => {
        const index = Number(token.dataset.partIndex)
        if (!Number.isInteger(index)) return
        const caret = document.createRange()
        caret.setStartBefore(token)
        caret.collapse(true)
        token.remove()
        state.parts.splice(index, 1)
        for (const chip of Array.from(host.querySelectorAll<HTMLElement>('[data-flux-token="true"]'))) {
          const oldIndex = Number(chip.dataset.partIndex)
          if (oldIndex > index) chip.dataset.partIndex = String(oldIndex - 1)
        }
        state.caret = caret.cloneRange()
        writeCaret(caret)
        state.menu = null
        menu.remove()
        host.focus()
      })
      addMenuItem('Действия заголовка', () => {
        state.modalOpen = true
        state.menu = null
        menu.remove()
        ipc.send('flux:cell-actions', {
          editorKind: 'sheets',
          anchors: [{ anchorId: state.anchorId, kind: 'excel-range', sheetName: state.sheetName, address: state.address, parts: partsFromHostFor(state.host, state.parts) }],
          position: { x: event.clientX, y: event.clientY },
        })
      })
      document.body.appendChild(menu)
      state.menu = menu
    })
    document.addEventListener('selectionchange', selectionHandler)
    root.addEventListener('focusout', (event) => {
      const related = (event as FocusEvent).relatedTarget
      if (active?.root === root && !active.modalOpen && !(related instanceof Node && root.contains(related))) close(true)
    })
    host.focus()
    const end = document.createRange()
    end.selectNodeContents(host)
    end.collapse(false)
    writeCaret(end)
    state.caret = end.cloneRange()
    ipc.send('flux:header-formula-edit-started', { ok: true, anchorId })
    return true
  }

  const partsFromHostFor = (host: HTMLElement, original: Part[]): Part[] => {
    const raw: Part[] = []
    const text = (value: string): void => {
      let ordinary = ''
      const flush = (): void => { if (ordinary) raw.push({ kind: 'text', text: ordinary }); ordinary = '' }
      for (const character of value) {
        const operator = character === '×' ? '*' : character === '÷' ? '/' : character === '−' ? '-' : character
        if (['+', '-', '*', '/', '(', ')'].includes(operator)) { flush(); raw.push({ kind: 'operator', operator }) }
        else ordinary += character
      }
      flush()
    }
    const visit = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) { text(node.textContent || ''); return }
      if (!(node instanceof HTMLElement)) return
      if (node.dataset.fluxToken === 'true') {
        const index = Number(node.dataset.partIndex)
        const part = Number.isInteger(index) ? original[index] : null
        if (part?.kind === 'field' || part?.kind === 'union') raw.push(part)
        return
      }
      for (const child of Array.from(node.childNodes)) visit(child)
    }
    for (const child of Array.from(host.childNodes)) visit(child)
    return raw.reduce<Part[]>((result, part) => {
      const prior = result[result.length - 1]
      if (part.kind === 'text' && prior?.kind === 'text') prior.text += part.text
      else result.push(part)
      return result
    }, [])
  }

  ipc.on('flux:edit-header-formula', (_event, request: any) => {
    const message = request?.payload ?? request ?? {}
    const ok = open(String(message.anchorId || ''), message.schema)
    if (!ok) ipc.send('flux:header-formula-edit-started', { ok: false, anchorId: String(message.anchorId || ''), error: 'Ячейка заголовка больше не существует' })
  })
  ipc.on('flux:close-header-formula', (_event, request: any) => {
    const message = request?.payload ?? request ?? {}
    if (active?.anchorId === String(message.anchorId || '')) close(message.commit === true)
  })

  return {
    insertField(anchorId: string, binding: Part, displayName: string): boolean {
      if (!active || active.anchorId !== anchorId) return false
      const copied: Part = { ...binding, anchorId }
      if (displayName && !copied.displayName) copied.displayName = displayName
      addPart({ kind: 'field', binding: copied })
      return true
    },
    isEditing(anchorId?: string): boolean { return !!active && (!anchorId || active.anchorId === anchorId) },
    getLiveParts(anchorId: string): Part[] | null { return active?.anchorId === anchorId ? partsFromHost() : null },
  }
}
