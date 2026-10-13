/**
 * Вкладка «Flux» ленты Word и Таблицы (ТЗ v10 §3).
 *
 * Лента только шлёт окну Flux команды и показывает его состояние; панель,
 * шаблоны и запись в файл — дело окна. Каждая кнопка — одно сообщение
 * `flux:open-panel` с полем command (окно Flux открывает или переключает
 * правую панель). Команды не дублируют родную ленту редактора.
 *
 * Разметка берёт классы самого редактора (Word — rb-big, Таблица —
 * ribbon-tool large), чтобы вид и обе темы были его собственными.
 */
import { Fragment, useEffect, useState } from 'react'

type Variant = 'docs' | 'sheets'

/** Что окно Flux сообщает ленте: можно ли вернуть исходную шапку и выпустить ревизию. */
interface RibbonState {
  resetAvailable: boolean
  resetHint: string
  issueAvailable: boolean
  issueHint: string
  /** Файл проекта: «Поля проекта» и «Английская версия» работают только с карточкой файла в базе. */
  projectFile: boolean
  projectFileHint: string
}

const NO_TEMPLATE = 'У файла нет шаблона'
const ISSUE_TIP = 'Выпустить ревизию документа'
let ribbonState: RibbonState = { resetAvailable: false, resetHint: NO_TEMPLATE, issueAvailable: true, issueHint: ISSUE_TIP, projectFile: true, projectFileHint: '' }
const subscribers = new Set<(state: RibbonState) => void>()

const parentOrigin = (): string =>
  window.location.origin === 'null' || window.location.origin === 'file://' ? '*' : window.location.origin

function tellHost(op: string, extra?: Record<string, unknown>): void {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ flux: 'office', op, ...extra }, parentOrigin())
  }
}

/** Команда ленты окну Flux: открыть панель на нужном и сделать действие. */
export function sendFluxCommand(command: string): void {
  tellHost('flux:open-panel', { command })
}

// Состояние слушаем с загрузки модуля: окно может прислать его раньше, чем
// пользователь откроет вкладку.
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return
    const known = event.origin === window.location.origin || window.location.origin === 'null' || window.location.origin === 'file://'
    const message = event.data
    if (!known || !message || message.flux !== 'office' || message.event !== 'fluxRibbonState') return
    const next = message.payload
    ribbonState = {
      resetAvailable: next?.resetAvailable === true,
      resetHint: typeof next?.resetHint === 'string' && next.resetHint ? next.resetHint : NO_TEMPLATE,
      issueAvailable: next?.issueAvailable !== false,
      issueHint: typeof next?.issueHint === 'string' && next.issueHint ? next.issueHint : ISSUE_TIP,
      projectFile: next?.projectFile !== false,
      projectFileHint: typeof next?.projectFileHint === 'string' ? next.projectFileHint : '',
    }
    subscribers.forEach((fn) => fn(ribbonState))
  })
  // Окно отвечает состоянием на этот вопрос; спросить надо и при показе вкладки
  tellHost('flux:ribbon-ready')
}

const ICONS: Record<string, string> = {
  equipment: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M19 9h3M19 14h3M2 9h3M2 14h3"/>',
  tags: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7" cy="7" r="1"/>',
  management: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01"/>',
  e3: '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  'project-fields': '<path d="M4 7V5a1 1 0 0 1 1-1h3M20 7V5a1 1 0 0 0-1-1h-3M4 17v2a1 1 0 0 0 1 1h3M20 17v2a1 1 0 0 1-1 1h-3"/><path d="M9 9c-1 0-1.5.5-1.5 1.5v1c0 .7-.4 1-1 1 .6 0 1 .3 1 1v1C7.5 14.5 8 15 9 15M15 9c1 0 1.5.5 1.5 1.5v1c0 .7.4 1 1 1-.6 0-1 .3-1 1v1c0 1-.5 1.5-1.5 1.5"/>',
  english: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  translator: '<path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/>',
  templates: '<rect x="3" y="3" width="18" height="7" rx="1"/><rect x="3" y="14" width="9" height="7" rx="1"/><rect x="16" y="14" width="5" height="7" rx="1"/>',
  pinned: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2-6.2 3.2L7 14.2 2 9.3l6.9-1L12 2z"/>',
  'save-template': '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  'update-template': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16M16 16h5v5"/>',
  issue: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/>',
  'reset-header': '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  export: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
}

interface Command { id: string; label: string; tip: string; soon?: boolean }
interface Group { label: string; commands: Command[] }

const GROUPS: Group[] = [
  { label: 'Переводчик', commands: [
    { id: 'translator', label: 'Переводчик', tip: 'Перевод текста документа' },
    { id: 'english', label: 'Английская версия', tip: 'Английская версия файла проекта' },
  ] },
  { label: 'Данные', commands: [
    { id: 'project-fields', label: 'Поля проекта', tip: 'Метки {{ключ}} в документе и «Обновить поля»' },
    { id: 'source-equipment', label: 'Оборудование', tip: 'Данные оборудования проекта' },
    { id: 'source-tags', label: 'Теги', tip: 'Теги проекта' },
    { id: 'source-management', label: 'Менеджмент', tip: 'Скоро', soon: true },
    { id: 'source-e3', label: 'E3Flux', tip: 'Скоро', soon: true },
  ] },
  { label: 'Шаблоны', commands: [
    { id: 'templates', label: 'Шаблоны', tip: 'Библиотека шаблонов шапки' },
    { id: 'pinned', label: 'Закреплённые', tip: 'Закреплённые шаблоны' },
    { id: 'save-template', label: 'Сохранить как', tip: 'Сохранить шапку как новый шаблон' },
    { id: 'update-template', label: 'Обновить шаблон', tip: 'Записать текущую шапку в шаблон файла' },
  ] },
  { label: 'Документ', commands: [
    { id: 'refresh', label: 'Обновить данные', tip: 'Сравнить с источником и обновить значения' },
    { id: 'issue', label: 'Выпустить', tip: ISSUE_TIP },
    { id: 'reset-header', label: 'Исходная шапка', tip: NO_TEMPLATE },
    { id: 'export', label: 'Выгрузить', tip: 'XLSX, CSV или книга Flux из выборки' },
  ] },
]

const Icon = ({ id, size }: { id: string; size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[id] || '' }} />
)

const STYLE = '.flux-soon{font-size:10px;line-height:1;color:var(--text-dim,#7b8a80)}.flux-rb-btn:disabled{opacity:.45;cursor:default}'

export function FluxRibbonTab({ variant }: { variant: Variant }) {
  const [state, setState] = useState<RibbonState>(ribbonState)
  useEffect(() => {
    subscribers.add(setState)
    setState(ribbonState)
    tellHost('flux:ribbon-ready')
    return () => { subscribers.delete(setState) }
  }, [])

  const button = (command: Command) => {
    const reset = command.id === 'reset-header'
    const issue = command.id === 'issue'
    const projectOnly = command.id === 'project-fields' || command.id === 'english'
    const disabled = command.soon === true || (reset && !state.resetAvailable) || (issue && !state.issueAvailable) || (projectOnly && !state.projectFile)
    const tip = reset ? (state.resetAvailable ? state.resetHint : NO_TEMPLATE) : issue ? state.issueHint : projectOnly && !state.projectFile ? state.projectFileHint || 'Недоступно для этого файла' : command.tip
    const onClick = () => { if (!disabled) sendFluxCommand(command.id) }
    if (variant === 'docs') {
      return (
        <button key={command.id} type="button" className="rb-big flux-rb-btn" data-flux-command={command.id} disabled={disabled} data-tip={tip} title={tip} aria-label={command.label} onClick={onClick}>
          <span className="rb-big-icon"><Icon id={command.id} size={28} /></span>
          <span>{command.label}</span>
          {command.soon && <span className="flux-soon">Скоро</span>}
        </button>
      )
    }
    return (
      <button key={command.id} type="button" className="ribbon-tool as-button large flux-rb-btn" data-flux-command={command.id} disabled={disabled} data-tip={tip} title={tip} aria-label={command.label} onClick={onClick}>
        <span className="tool-icon-row"><span className="tool-symbol"><Icon id={command.id} size={28} /></span></span>
        <span><strong>{command.label}</strong></span>
        {command.soon && <span className="flux-soon">Скоро</span>}
      </button>
    )
  }

  const groups = GROUPS.map((group, index) => variant === 'docs' ? (
    <Fragment key={group.label}>
      {index > 0 && <div className="ribbon-sep" />}
      <div className="ribbon-group" data-flux-group={group.label}>
        <div className="ribbon-group-items">{group.commands.map(button)}</div>
        <div className="ribbon-group-label">{group.label}</div>
      </div>
    </Fragment>
  ) : (
    <section key={group.label} className="ribbon-group" aria-label={group.label} data-flux-group={group.label}>
      <div className="ribbon-group-content">{group.commands.map(button)}</div>
    </section>
  ))

  return variant === 'docs'
    ? <><style>{STYLE}</style>{groups}</>
    : <div className="ribbon" data-ribbon-body="" data-flux-ribbon=""><style>{STYLE}</style>{groups}</div>
}
