/**
 * Общий вид плашки параметра Flux для Word и Excel: название в скруглённой светло-зелёной рамке.
 * Цвета — ступени emerald из токенов Flux (src/index.css); редактор живёт в своём окне и
 * этих переменных не видит, поэтому значения продублированы здесь. Тема — как у самого
 * редактора: атрибут data-theme на <html> либо системная.
 */
const CSS = `
:root{--flux-chip-bg:oklch(97.5% 0.016 163);--flux-chip-border:oklch(84.5% 0.09 163);--flux-chip-fg:oklch(40% 0.09 163)}
[data-theme='dark']{--flux-chip-bg:oklch(28% 0.06 163);--flux-chip-border:oklch(46% 0.105 163);--flux-chip-fg:oklch(90.5% 0.055 163)}
@media (prefers-color-scheme:dark){:root:not([data-theme='light']):not([data-theme='dark']){--flux-chip-bg:oklch(28% 0.06 163);--flux-chip-border:oklch(46% 0.105 163);--flux-chip-fg:oklch(90.5% 0.055 163)}}
#flux-sheet-token-overlay[data-theme='dark']{--flux-chip-bg:oklch(28% 0.06 163);--flux-chip-border:oklch(46% 0.105 163);--flux-chip-fg:oklch(90.5% 0.055 163)}
.flux-parameter-chip,.flux-sheet-token-chip,.flux-sheet-idle-chip{display:inline-block;box-sizing:border-box;padding:0 .45em;border:1px solid var(--flux-chip-border)!important;border-radius:4px!important;background:var(--flux-chip-bg)!important;color:var(--flux-chip-fg)!important;font-weight:600;white-space:nowrap}
.flux-sheet-token-chip,.flux-sheet-idle-chip{padding:1px 7px;font-size:12.5px;line-height:1.35;max-width:190px;min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
`
export function installParameterChipStyle(): void {
  if (document.getElementById('flux-parameter-chip-style')) return
  const style = document.createElement('style')
  style.id = 'flux-parameter-chip-style'
  style.textContent = CSS
  document.head.appendChild(style)
}
