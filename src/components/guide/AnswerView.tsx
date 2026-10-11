import { useMemo, useState } from 'react';
import { ArrowRight, BookOpen, ChevronRight, ExternalLink, MapPin, Play, Table2 } from 'lucide-react';
import { useGuideStore } from '../../guide/store';
import type { GuideAction, GuideCard, GuideMessage, GuideTable } from '../../guide/types';
import { exportTableToExcel, exportTableToWord } from '../../assistant/tableExport';
import { editorHref, saveNewFile } from '../../lib/officeFiles';

// ── Отрисовка ответа (карточки, таблицы, уточнения) ──

function ActionChip({ action, onRun }: { action: GuideAction; onRun: (a: GuideAction) => void }) {
  const icon = action.kind === 'tour' ? <Play className="w-3 h-3" />
    : action.kind === 'open-export' ? <Table2 className="w-3 h-3" />
    : action.kind === 'navigate' ? <ArrowRight className="w-3 h-3" />
    : action.kind === 'open-article' ? <BookOpen className="w-3 h-3" />
    : action.kind === 'focus-tag' || action.kind === 'focus-equipment' ? <MapPin className="w-3 h-3" />
    : <ChevronRight className="w-3 h-3" />;
  return (
    <button
      type="button"
      onClick={() => onRun(action)}
      className="fx-btn fx-btn-sm inline-flex max-w-full min-w-0 items-center gap-1"
      title={action.label}
    >
      {icon} <span className="truncate">{action.label}</span>
    </button>
  );
}

function AnswerTable({ table }: { table: GuideTable }) {
  const runAction = useGuideStore((s) => s.runAction);
  const projectId = useGuideStore((s) => s.projectId);
  const [sort, setSort] = useState<{ column: number; direction: 1 | -1 } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => {
    const indexed = table.rows.map((row, index) => ({ row, index }));
    if (!sort) return indexed;
    return indexed.sort((a, b) => a.row[sort.column].localeCompare(b.row[sort.column], 'ru', { numeric: true, sensitivity: 'base' }) * sort.direction);
  }, [sort, table.rows]);
  const toggleRow = (index: number) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });
  const allSelected = table.rows.length > 0 && selected.size === table.rows.length;
  const exportFile = async (format: 'xlsx' | 'docx') => {
    setExporting(true);
    setExportError('');
    try {
      const rows = selected.size ? table.rows.filter((_, i) => selected.has(i)) : table.rows;
      const source = { title: table.title, columns: table.columns, rows };
      const file = format === 'xlsx' ? await exportTableToExcel(source) : exportTableToWord(source);
      const saved = await saveNewFile(file.bytes, file.name, 'exports', undefined, projectId || undefined);
      runAction({ kind: 'navigate', label: 'Открыть файл', route: editorHref(saved) });
    } catch (error) {
      setExportError(error instanceof Error ? `Не удалось создать файл: ${error.message}` : 'Не удалось создать файл. Проверьте соединение и повторите.');
    } finally { setExporting(false); }
  };
  return (
    <div className={expanded
      ? 'fixed inset-3 z-50 flex min-w-0 flex-col rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 shadow-sm'
      : 'min-w-0'} role={expanded ? 'dialog' : undefined} aria-modal={expanded || undefined} aria-label={expanded ? table.title : undefined}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-slate-600 dark:text-slate-300">{table.title}</span>
        <button type="button" onClick={() => setExpanded((v) => !v)}
          className="fx-btn fx-btn-sm shrink-0">{expanded ? 'Свернуть' : 'Полный просмотр'}</button>
      </div>
      <div className="border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
        <div className={`${expanded ? 'flex-1 min-h-0' : 'max-h-[360px]'} overflow-auto scrollbar-thin`}>
          <table className="w-full text-sm min-w-[520px]">
            <thead>
              <tr className="sticky top-0 z-10 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-850">
                <th className="w-8 px-2 py-1.5"><input type="checkbox" aria-label="Выбрать все строки" checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(table.rows.map((_, i) => i)))} /></th>
                <th className="w-10 text-right px-2 py-1.5">№</th>
                {table.columns.map((c, index) => <th key={c} aria-sort={sort?.column === index ? (sort.direction === 1 ? 'ascending' : 'descending') : 'none'}
                  className="text-left px-2 py-1.5 whitespace-nowrap">
                  <button type="button" onClick={() => setSort((s) => ({ column: index, direction: s?.column === index ? (s.direction === 1 ? -1 : 1) : 1 }))}
                    className="hover:text-slate-900 dark:hover:text-white cursor-pointer">{c}{sort?.column === index ? (sort.direction === 1 ? ' ↑' : ' ↓') : ''}</button>
                </th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ row, index }) => (
                <tr key={index} aria-selected={selected.has(index)} className="h-8 border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-850/60">
                  <td className="w-8 px-2 py-1"><input type="checkbox" aria-label={`Выбрать строку ${index + 1}`} checked={selected.has(index)} onChange={() => toggleRow(index)} /></td>
                  <td className="px-2 py-1 text-right tabular-nums text-xs text-slate-400">{index + 1}</td>
                  {row.map((cell, j) => (
                    <td key={j} className="px-2 py-1 text-xs text-slate-800 dark:text-dark-text-main break-words max-w-[280px]">{cell || <span className="text-slate-400">—</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-1 text-2xs text-slate-400 dark:text-slate-500">
        <span>{table.total === undefined || table.total === table.rows.length ? `Строк: ${table.rows.length}` : `Показаны ${table.rows.length} из ${table.total}`}</span>
        {selected.size > 0 && <span>· Выбрано: {selected.size}</span>}
        {table.note && <span>· {table.note}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        <button type="button" disabled={exporting || !table.rows.length} onClick={() => void exportFile('xlsx')}
          className="fx-btn fx-btn-sm" title={selected.size ? `Создать Excel из выбранных строк (${selected.size})` : 'Создать Excel из показанных строк'}>
          {exporting ? 'Создаю…' : 'Excel'}
        </button>
        <button type="button" disabled={exporting || !table.rows.length} onClick={() => void exportFile('docx')}
          className="fx-btn fx-btn-sm" title={selected.size ? `Создать Word из выбранных строк (${selected.size})` : 'Создать Word из показанных строк'}>
          Word
        </button>
        {exportError && <span role="alert" className="text-xs text-rose-700 dark:text-rose-300">{exportError}</span>}
      </div>
    </div>
  );
}

function AnswerCard({ card, onRun }: { card: GuideCard; onRun: (a: GuideAction) => void }) {
  return (
    <div className="border-t border-slate-200 dark:border-slate-800 pt-2 flex flex-col gap-2 min-w-0 max-w-full">
      <div className="flex items-start gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="text-sm font-semibold text-slate-900 dark:text-white break-all">{card.title}</span>
            {card.badge && (
              <span className="px-1.5 py-0.5 rounded-md text-2xs font-semibold bg-emerald-600/10 text-emerald-700 dark:text-emerald-300">{card.badge}</span>
            )}
          </div>
          {card.subtitle && <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 break-words">{card.subtitle}</div>}
        </div>
        {card.action && (
          <button type="button" onClick={() => onRun(card.action!)} title={card.action.label}
            className="shrink-0 p-1.5 rounded-lg text-emerald-700 dark:text-emerald-300 hover:bg-emerald-600/10 cursor-pointer">
            <ExternalLink className="w-4 h-4" />
          </button>
        )}
      </div>
      <dl className="grid grid-cols-1 @[420px]:grid-cols-2 gap-x-4 gap-y-1">
        {card.fields.map((f) => (
          <div key={f.label} className="flex items-baseline gap-2 min-w-0 text-xs">
            <dt className="text-slate-400 dark:text-slate-500 shrink-0">{f.label}</dt>
            <dd className="text-slate-800 dark:text-dark-text-main break-words min-w-0">{f.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const STATUS_STYLE: Record<string, { dot: string; label: string }> = {
  'no-match': { dot: 'bg-slate-400', label: 'Ничего не найдено' },
  permission: { dot: 'bg-amber-500', label: 'Доступ ограничен' },
  unavailable: { dot: 'bg-rose-500', label: 'Данные недоступны' },
  'need-project': { dot: 'bg-sky-500', label: 'Выберите проект' },
  ok: { dot: '', label: '' },
};

export function AnswerView({ msg }: { msg: GuideMessage }) {
  const runAction = useGuideStore((s) => s.runAction);
  const setProject = useGuideStore((s) => s.setProject);
  const projects = useGuideStore((s) => s.projects);
  const style = STATUS_STYLE[msg.status || 'ok'];

  return (
    <div className="max-w-[80ch] flex flex-col gap-2.5 min-w-0 py-1">
      {style.label && <div className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300" role="status">
        <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} aria-hidden="true" />{style.label}
      </div>}
      {msg.outcome && (
        <div className="text-sm font-semibold text-slate-900 dark:text-white break-words">{msg.outcome}</div>
      )}
      <div className="text-sm text-slate-800 dark:text-dark-text-main leading-relaxed whitespace-pre-line break-words min-w-0">{msg.text}</div>

      {msg.clarify && (msg.clarify.options.length > 0 || msg.status === 'need-project') && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">{msg.clarify.question}</span>
          {msg.status === 'need-project' && (
            <div className="flex flex-wrap gap-1.5">
              {projects.map((p) => (
                <button key={p.id} type="button"
                  onClick={() => setProject(p.id, p.name)}
                  className="px-2.5 py-1 rounded-lg text-xs font-semibold border border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300 hover:bg-sky-500/20 cursor-pointer">
                  {p.name}
                </button>
              ))}
            </div>
          )}
          {msg.clarify.options.map((o) => (
            <button key={o.label} type="button" onClick={() => runAction({ kind: 'ask', label: o.query || o.label, query: o.query })}
              className="fx-btn w-full justify-start text-left text-xs">
              {o.label}{o.detail ? <span className="text-slate-400"> · {o.detail}</span> : null}
            </button>
          ))}
        </div>
      )}

      {msg.cards?.map((c) => <AnswerCard key={c.id} card={c} onRun={runAction} />)}

      {msg.list && msg.list.items.length > 0 && (
        <ul className="flex flex-col gap-1 min-w-0">
          {msg.list.items.map((it) => (
            <li key={it.id}>
              <button type="button" onClick={() => it.action && runAction(it.action)}
                className="w-full text-left px-1.5 py-1.5 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-850 cursor-pointer flex items-center gap-2 min-w-0">
                <span className="text-xs font-semibold text-slate-800 dark:text-dark-text-main break-all">{it.title}</span>
                {it.badge && <span className="text-2xs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-850 text-slate-500 shrink-0">{it.badge}</span>}
                <span className="flex-1 text-xs text-slate-500 dark:text-slate-400 truncate">{it.subtitle}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {msg.table && <AnswerTable table={msg.table} />}

      {msg.actions && msg.actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {msg.actions.map((a, i) => <ActionChip key={`${a.kind}-${i}`} action={a} onRun={runAction} />)}
        </div>
      )}

      {msg.source && (
        <div className="flex flex-wrap items-center gap-1.5 text-2xs text-slate-400 dark:text-slate-500 pt-1 border-t border-slate-100 dark:border-slate-800">
          <span className="font-semibold">Источник: {msg.source.label}</span>
          <span>· {msg.source.at}</span>
          {msg.source.articleId && (
            <button type="button"
              onClick={() => runAction({ kind: 'open-article', label: '', route: `/guide?article=${encodeURIComponent(msg.source!.articleId!)}` })}
              className="text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer">
              {msg.source.articleTitle || 'статья'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

