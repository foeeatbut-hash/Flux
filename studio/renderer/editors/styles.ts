/**
 * Оформление редакторов программы.
 *
 * Окно Studio открывается с CSP `style-src 'self'`: ни <style>, ни style="" из разметки. Поэтому
 * стили лежат строкой и ставятся через constructable stylesheet (его CSP не блокирует) — так же
 * ставит стили CodeMirror. Цвета редакторов — токены Studio (--surface, --border…): светлая и
 * тёмная тема приходят от оболочки. Предпросмотр формы — отдельная область с токенами Flux
 * (--flux-*), чтобы проверить программу в обеих темах независимо от темы Studio.
 */
const css = `
.ed { --ed-gap: 8px; display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--text); font: 13px/20px system-ui, -apple-system, "Segoe UI", sans-serif; }
.ed *, .ed *::before, .ed *::after { box-sizing: border-box; }
.ed button, .ed input, .ed select, .ed textarea { font: inherit; color: inherit; }
.ed-tabs { display: flex; gap: 4px; padding: 8px 12px 0; border-bottom: 1px solid var(--border); background: var(--surface); flex-wrap: wrap; }
.ed-tab { height: 32px; padding: 0 12px; border: 0; border-bottom: 2px solid transparent; background: transparent; cursor: pointer; color: var(--muted); font-weight: 500; }
.ed-tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.ed-tab:hover { color: var(--text); }
.ed-badge { margin-left: 8px; padding: 0 6px; border-radius: 4px; background: var(--danger-bg); color: var(--danger); font-size: 12px; font-weight: 500; }
.ed-panel { flex: 1; min-height: 0; display: flex; }
.ed-panel[hidden] { display: none; }
.ed-btn { height: 28px; padding: 0 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); cursor: pointer; font-weight: 500; }
.ed-btn:hover { background: var(--surface-2); }
.ed-btn:disabled { opacity: .5; cursor: default; }
.ed-btn.is-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.ed-btn.is-danger { color: var(--danger); }
.ed-btn:focus-visible, .ed-tab:focus-visible, .ed-row:focus-visible, .ed-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.ed-muted { color: var(--muted); }
.ed-title { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.ed-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.ed-strong { font-weight: 600; }
.ed-hint { margin: 4px 0 0; font-size: 12px; line-height: 16px; color: var(--muted); }
.ed-error { margin: 4px 0 0; font-size: 12px; line-height: 16px; color: var(--danger); }

.ed-form { flex: 1; min-width: 0; display: grid; grid-template-columns: 220px minmax(0, 1fr) 300px; grid-template-rows: minmax(0, 1fr); min-height: 0; }
.ed-form[data-locked] { grid-template-rows: auto minmax(0, 1fr); }
.ed-col { min-height: 0; min-width: 0; overflow: auto; padding: 12px; }
.ed-col + .ed-col { border-left: 1px solid var(--border); }
.ed-center { display: flex; flex-direction: column; gap: 12px; padding: 0; overflow: hidden; }
.ed-center > section { padding: 12px; min-height: 0; overflow: auto; }
.ed-structure { flex: 0 1 45%; border-bottom: 1px solid var(--border); }
.ed-previewbox { flex: 1 1 55%; }

.ed-lock { grid-column: 1 / -1; display: flex; gap: 12px; align-items: center; padding: 8px 12px; background: var(--danger-bg); color: var(--danger); border-bottom: 1px solid var(--border); }
.ed-form[data-locked] .ed-col[inert], .ed-form[data-locked] section[inert] { opacity: .6; }
.ed-palette { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.ed-pal { border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
.ed-pal-main { display: flex; flex-direction: column; align-items: flex-start; width: 100%; padding: 4px 8px; border: 0; background: transparent; text-align: left; cursor: grab; border-radius: 6px; }
.ed-pal-main:hover { background: var(--surface-2); }
.ed-pal-name { font-weight: 600; }
.ed-pal details { padding: 0 8px 8px; font-size: 12px; line-height: 16px; }
.ed-pal summary { cursor: pointer; color: var(--muted); padding: 4px 0; }
.ed-pal ul { margin: 4px 0 0; padding-left: 16px; }
.ed-pal li { margin: 0 0 4px; }
.ed-example { margin: 4px 0 0; padding: 4px 8px; background: var(--surface-2); border-radius: 4px; color: var(--muted); }

.ed-tree { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.ed-row { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 0 8px; border: 1px solid transparent; border-radius: 6px; cursor: pointer; background: transparent; width: 100%; text-align: left; }
.ed-row:hover { background: var(--surface-2); }
.ed-row[aria-selected="true"] { background: var(--surface-2); border-color: var(--accent); }
.ed-row.is-child { padding-left: 24px; }
.ed-row .ed-kind { flex: none; width: 56px; font-size: 12px; color: var(--muted); }
.ed-row .ed-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ed-row .ed-bind { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--muted); }
.ed-row .ed-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--danger); }
.ed-row.drop-before { box-shadow: 0 -2px 0 0 var(--accent); }
.ed-row.drop-after { box-shadow: 0 2px 0 0 var(--accent); }
.ed-row.drop-into { border-color: var(--accent); border-style: dashed; }
.ed-empty { padding: 12px; border: 1px dashed var(--border); border-radius: 6px; color: var(--muted); }
.ed-empty.drop-into { border-color: var(--accent); }
.ed-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }

.ed-props { display: flex; flex-direction: column; gap: 12px; }
.ed-field { display: flex; flex-direction: column; gap: 4px; }
.ed-field > label, .ed-label { font-size: 12px; line-height: 16px; font-weight: 500; color: var(--muted); }
.ed-input { height: 32px; width: 100%; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); }
.ed-input[aria-invalid="true"] { border-color: var(--danger); }
.ed-check { display: flex; align-items: center; gap: 8px; min-height: 32px; }
.ed-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ed-section { margin: 0; padding-top: 12px; border-top: 1px solid var(--border); font-size: 12px; font-weight: 600; color: var(--muted); }
.ed-findings { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.ed-findings li { padding: 4px 8px; border-radius: 6px; background: var(--surface-2); font-size: 12px; line-height: 16px; }
.ed-findings li.is-error { border-left: 3px solid var(--danger); }
.ed-findings li.is-warning { border-left: 3px solid var(--warn); }
.ed-findings .ed-src { display: block; color: var(--muted); }
.ed-segment { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.ed-segment button { height: 28px; padding: 0 12px; border: 0; background: var(--surface); cursor: pointer; }
.ed-segment button[aria-pressed="true"] { background: var(--accent); color: var(--accent-text); }
.ed-toolbar .ed-title { margin: 0; }
.ed-toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }

.ed-text { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.ed-cm { flex: 1; min-height: 0; min-width: 0; overflow: hidden; border-bottom: 1px solid var(--border); background: var(--surface); display: block; }
.ed-text-foot { max-height: 40%; overflow: auto; padding: 8px 12px; background: var(--surface); }
.ed-text-foot ul { margin: 0; padding: 0; list-style: none; }
.ed-text-foot li { display: flex; gap: 8px; }
.ed-text-foot .ed-line { flex: none; min-width: 72px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--muted); }
.ed-ok { color: var(--ok); }
.ed-code { flex: 1; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) 320px; min-height: 0; }
.ed-code-main { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.ed-code-side { overflow: auto; padding: 12px; border-left: 1px solid var(--border); }
.ed-code-side pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12px/16px ui-monospace, Consolas, monospace; }
.ed-code-file { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.ed-code-file[hidden] { display: none; }
.ed-files { display: flex; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--border); align-items: center; flex-wrap: wrap; }
.ed-contract { flex: 1; overflow: auto; padding: 16px; max-width: 880px; display: flex; flex-direction: column; gap: 16px; }
.ed-vals { width: 100%; border-collapse: collapse; }
.ed-vals th { text-align: left; font-size: 12px; font-weight: 500; color: var(--muted); padding: 0 8px 4px 0; }
.ed-vals td { padding: 0 8px 4px 0; }
.ed-checks { display: flex; gap: 16px; flex-wrap: wrap; }
.ed-rules { flex: 1; overflow: auto; padding: 16px; max-width: 880px; display: flex; flex-direction: column; gap: 16px; }
.ed-rules ul { margin: 0; padding-left: 20px; }

/* Предпросмотр: токены Flux и классы, которыми рисует рендерер формы программы (modules/runtime/form.ts) */
.ed-pv { --flux-bg: oklch(97.8% 0.004 163); --flux-surface: #ffffff; --flux-line: oklch(91.2% 0.006 163); --flux-text: oklch(28.5% 0.014 163); --flux-text-muted: oklch(56.5% 0.012 163); --flux-accent: oklch(54% 0.115 163); --flux-row-h: 32px; --flux-cell-px: 10px;
  background: var(--flux-surface); color: var(--flux-text); border: 1px solid var(--flux-line); border-radius: 6px; font-size: 13px; line-height: 20px; overflow-x: hidden; }
.ed-pv[data-pv-theme="dark"] { --flux-bg: oklch(21% 0.011 163); --flux-surface: oklch(16% 0.009 163); --flux-line: oklch(28.5% 0.016 163); --flux-text: oklch(92.9% 0.007 163); --flux-text-muted: oklch(70.5% 0.020 163); --flux-accent: oklch(76% 0.130 163); }
.ed-pv .p-3 { padding: 12px; } .ed-pv .flex { display: flex; } .ed-pv .items-center { align-items: center; }
.ed-pv .justify-between { justify-content: space-between; } .ed-pv .gap-4 { gap: 16px; } .ed-pv .min-h-8 { min-height: 32px; }
.ed-pv .border-b { border-bottom: 1px solid; } .ed-pv .border-\\[var\\(--flux-line\\)\\] { border-color: var(--flux-line); }
.ed-pv .text-sm { font-size: 13px; } .ed-pv .break-words { overflow-wrap: anywhere; } .ed-pv .min-w-0 { min-width: 0; }
.ed-pv .font-mono { font-family: ui-monospace, Consolas, monospace; } .ed-pv .w-full { width: 100%; } .ed-pv .table-fixed { table-layout: fixed; }
.ed-pv .text-right { text-align: right; } .ed-pv .tabular-nums { font-variant-numeric: tabular-nums; }
.ed-pv .fx-label { font-size: 12px; line-height: 16px; font-weight: 500; color: var(--flux-text-muted); }
.ed-pv .fx-group-title { font-size: 13px; line-height: 20px; font-weight: 600; color: var(--flux-text); margin: 0; padding-bottom: 8px; border-bottom: 1px solid var(--flux-line); }
.ed-pv .fx-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; font-variant-numeric: tabular-nums; }
.ed-pv .fx-table th { height: 28px; padding: 0 var(--flux-cell-px); text-align: left; font-size: 12px; font-weight: 500; color: var(--flux-text-muted); background: var(--flux-bg); border-bottom: 1px solid var(--flux-line); }
.ed-pv .fx-table th.text-right { text-align: right; }
.ed-pv .fx-table td { height: var(--flux-row-h); padding: 0 var(--flux-cell-px); border-bottom: 1px solid var(--flux-line); color: var(--flux-text); }
.ed-pv .fx-table td.text-right { text-align: right; }
.ed-pv-frame { margin: 0 auto; max-width: 100%; }
.ed-pv-frame[data-width="narrow"] { width: 360px; }
.ed-pv-empty { padding: 12px; color: var(--flux-text-muted); }
.ed { --tok-keyword: #6d28d9; --tok-string: #047857; --tok-number: #b45309; --tok-name: #0f172a; --tok-type: #0369a1; }
:root.dark .ed { --tok-keyword: #c4b5fd; --tok-string: #6ee7b7; --tok-number: #fcd34d; --tok-name: #f1f5f9; --tok-type: #7dd3fc; }
@media (max-width: 1000px) { .ed-form { grid-template-columns: 1fr; overflow: auto; } .ed-col + .ed-col { border-left: 0; border-top: 1px solid var(--border); } .ed-code { grid-template-columns: 1fr; } }
`;

/** Стили внутри теневого корня редактора: CodeMirror ставит свои стили в тот корень, где живёт (см. CodeView) */
const shadowCss = `
:host { display: block; height: 100%; }
.cm-editor { height: 100%; background: var(--surface); color: var(--text); }
.cm-editor.cm-focused { outline: 2px solid var(--focus); outline-offset: -2px; }
.cm-scroller { font-family: ui-monospace, Consolas, "Cascadia Mono", monospace; font-size: 13px; line-height: 20px; }
.cm-editor .cm-gutters { background: var(--surface-2); color: var(--muted); border-right: 1px solid var(--border); }
.cm-editor .cm-activeLine, .cm-editor .cm-activeLineGutter { background: var(--surface-2); }
/* CodeMirror задаёт tab-size и скрытый распорку номеров через style="", который CSP окна Studio (style-src 'self') не пускает: те же правила здесь */
.cm-content { caret-color: var(--text); tab-size: 4; }
.cm-gutter > .cm-gutterElement:first-child { visibility: hidden; pointer-events: none; }
.cm-editor .cm-cursor { border-left-color: var(--text); }
.cm-editor .cm-selectionBackground, .cm-editor.cm-focused .cm-selectionBackground { background: color-mix(in srgb, var(--accent) 30%, transparent); }
.cm-tooltip { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; }
.cm-tooltip-autocomplete ul li[aria-selected] { background: var(--accent); color: var(--accent-text); }
.cm-diagnostic-error { border-left-color: var(--danger); }
.cm-tok-keyword { color: var(--tok-keyword); font-weight: 600; }
.cm-tok-string { color: var(--tok-string); }
.cm-tok-number { color: var(--tok-number); }
.cm-tok-comment { color: var(--muted); font-style: italic; }
.cm-tok-name { color: var(--tok-name); }
.cm-tok-type { color: var(--tok-type); }
`;

let installed: boolean | null = null;
/** Ставит стили один раз через constructable stylesheet (CSP окна не пускает <style>); false — окно их не поддерживает */
export function installEditorStyles(root: Document = document): boolean {
  if (installed !== null) return installed;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    installed = true;
  } catch {
    installed = false;
  }
  return installed;
}

/** Ставит стили редактора кода в теневой корень (constructable stylesheet: CSP окна не пускает <style>); false — не поддерживается */
export function installShadowStyles(root: ShadowRoot): boolean {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(shadowCss);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    return true;
  } catch {
    // Запасного <style> нет: CSP окна его отвергнет, и редактор остался бы без оформления — лучше сказать об этом прямо
    return false;
  }
}

export const editorCss = css;
