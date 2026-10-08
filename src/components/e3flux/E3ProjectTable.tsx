/**
 * «Атрибуты проекта» в E3Flux: позиции проекта × атрибуты E3 из справочника.
 *
 * Таблица показывает, что Flux подставит в книгу, и где данных не хватает.
 * Заполняют книгу руками в Excel: «Скачать Excel» отдаёт её, «Загрузить Excel»
 * принимает заполненную обратно (данные КИП ложатся в характеристики позиций). Строки те же, что у выгрузки оборудования (buildExportSources).
 */
import React from 'react';
import { Download, Upload, Undo2 } from 'lucide-react';
import { e3Columns, type E3AttributeBook } from '../../../e3/attributes';
import { attributeWorkbookBytes, buildAttributeSheets, isFluxColumn, isMissingCell, type E3SheetMode } from '../../../e3/attributeWorkbook';
import { classById, classOrder } from '../../../equipment/classes';
import { e3AttributesService } from '../../services/e3AttributesService';
import { buildExportSources, type ExportSystem } from '../../lib/exportWorkspace';
import { e3Rows } from '../../lib/e3Table';
import { fileName } from '../../lib/exchange';
import { count } from '../../lib/plural';
import { Btn, Empty, Field, Seg, Select, Toolbar } from '../ui';
import E3UploadDialog, { applyUploadRequest, forgetUpload, lastUpload, planUploadRequest, rememberUpload, undoUpload, type UploadPreview } from './E3AttributeUpload';

/** Больше строк в окне не рисуем: таблица для просмотра, полный список — в книге */
const SHOWN = 500;

const download = (blob: Blob, name: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

export default function E3ProjectTable({ projectId, projectName, onOpenBook, say }: {
  projectId: string; projectName: string; onOpenBook: () => void; say: (text: string, kind?: 'success' | 'error' | 'info') => void;
}) {
  const [systems, setSystems] = React.useState<ExportSystem[] | null>(null);
  const [book, setBook] = React.useState<E3AttributeBook | null>(null);
  const [error, setError] = React.useState('');
  const [scope, setScope] = React.useState('all');
  const [classes, setClasses] = React.useState<string[]>([]);
  const [taggedOnly, setTaggedOnly] = React.useState(false);
  const [header, setHeader] = React.useState<'name' | 'title'>('name');
  const [mode, setMode] = React.useState<E3SheetMode>('class');
  // Загрузка заполненной книги: план в окне, перечитывание данных после записи или отмены
  const [reload, setReload] = React.useState(0);
  const [preview, setPreview] = React.useState<UploadPreview | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [uploadError, setUploadError] = React.useState('');
  const [undoable, setUndoable] = React.useState(() => lastUpload(projectId));
  const fileRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    let alive = true;
    setError('');
    Promise.all([
      fetch(`/api/projects/${encodeURIComponent(projectId)}/systems`).then((r) => { if (!r.ok) throw new Error('Оборудование недоступно. Проверьте доступ к проекту'); return r.json(); }),
      e3AttributesService.load(),
    ]).then(([data, b]) => { if (alive) { setSystems(data.systems || []); setBook(b); } })
      .catch((e: any) => { if (alive) setError(e.message || 'Не удалось загрузить данные'); });
    return () => { alive = false; };
  }, [projectId, reload]);

  const sources = React.useMemo(() => buildExportSources(systems || [], []), [systems]);
  const units = sources.scopes.filter((s) => s.id.startsWith('unit:'));
  const inScope = React.useMemo(() => sources.rows(scope), [sources, scope]);
  const classCounts = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const it of inScope) m.set(String(it.cls || 'ПРОЧЕЕ'), (m.get(String(it.cls || 'ПРОЧЕЕ')) || 0) + 1);
    return [...m.entries()].sort((a, b) => classOrder(a[0]) - classOrder(b[0]));
  }, [inScope]);

  const live = React.useMemo(() => (book?.items || []).filter((a) => !a.removed), [book]);
  // Типы не выбраны — все типы в охвате: так же, как в выгрузке оборудования
  const columns = React.useMemo(() => e3Columns(live, classes.length ? classes : classCounts.map(([c]) => c), { header }), [live, classes, classCounts, header]);
  const table = React.useMemo(() => e3Rows(inScope, live, columns, { classes, taggedOnly }), [inScope, live, columns, classes, taggedOnly]);
  const missing = table.rows.reduce((n, r) => n + r.cells.filter((v, j) => isMissingCell(columns[j], v, r.na[j])).length, 0);

  if (error) return <Empty title="E3Flux недоступен" text={error} />;
  if (!systems || !book) return <div role="status" className="p-4 text-sm text-slate-500 dark:text-slate-400">Подготовка данных проекта…</div>;
  if (!live.length) return <div className="p-4"><Empty title="Справочник атрибутов пуст" text="Сначала загрузите «Список атрибутов» из Excel на вкладке «Справочник атрибутов»."><Btn onClick={onOpenBook}>Открыть справочник</Btn></Empty></div>;

  const save = () => {
    const sheets = buildAttributeSheets({ columns, items: live, rows: table.rows, mode });
    download(new Blob([attributeWorkbookBytes(sheets)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName(`E3 ${projectName}`, 'xlsx'));
    say(`Книга записана: ${count(table.rows.length, 'позиция', 'позиции', 'позиций')}, ${sheets.length > 1 ? `листов ${sheets.length}` : 'один лист'}`, 'success');
  };
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setUploadError('');
    try { setPreview(await planUploadRequest(projectId, file)); }
    catch (e: any) { say(e.message || 'Не удалось прочитать книгу', 'error'); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true); setUploadError('');
    try {
      const r = await applyUploadRequest(projectId, preview.sheets);
      rememberUpload(projectId, r.batchId, r.written); setUndoable(lastUpload(projectId));
      setPreview(null); setReload((n) => n + 1);
      say(`Книга загружена: ${count(r.written, 'позиция', 'позиции', 'позиций')}, значений ${r.values}. Загрузку можно отменить.`, 'success');
    } catch (e: any) { setUploadError(e.message); }
    finally { setBusy(false); }
  };
  const undo = async () => {
    if (!undoable) return;
    setBusy(true);
    try {
      const r = await undoUpload(undoable.batchId);
      forgetUpload(projectId); setUndoable(null); setReload((n) => n + 1);
      say(`Загрузка отменена: вернулось ${count(r.restored, 'позиция', 'позиции', 'позиций')}`, 'success');
    } catch (e: any) { if (e.message) say(e.message, 'error'); }
    finally { setBusy(false); }
  };
  const toggle = (id: string) => setClasses((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const muted = 'text-slate-500 dark:text-slate-400';

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-64 shrink-0 overflow-auto border-r border-slate-200 p-3 dark:border-slate-800 flex flex-col gap-3" aria-label="Отбор позиций">
        <Field label="Установка">
          <Select value={scope} onChange={(v) => { setScope(v); setClasses([]); }} aria-label="Установка"
            options={[{ value: 'all', label: `Все установки · ${sources.rows('all').length}` }, ...units.map((u) => ({ value: u.id, label: `${u.label.replace(/^Установка «|»$/g, '')} · ${u.count}` }))]} />
        </Field>
        <div className="flex flex-col gap-1">
          <span className="fx-label">Типы Flux {classes.length ? '' : '· все'}</span>
          {classCounts.map(([id, n]) => (
            <label key={id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-emerald-600" checked={classes.includes(id)} onChange={() => toggle(id)} />
              <span className="min-w-0 flex-1 truncate">{classById(id).title}</span>
              <span className={`tabular-nums text-xs ${muted}`}>{n}</span>
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-emerald-600" checked={taggedOnly} onChange={(e) => setTaggedOnly(e.target.checked)} />Только с тегом</label>
        {/* Не Field: подпись-label нажала бы первую кнопку переключателя */}
        <div className="fx-field"><span className="fx-label">Заголовок столбцов</span><Seg label="Заголовок столбцов" value={header} onChange={setHeader} options={[{ value: 'name', label: 'имя E3' }, { value: 'title', label: 'описание' }]} /></div>
        <div className="fx-field"><span className="fx-label">Листы в книге</span><Seg label="Листы в книге" value={mode} onChange={setMode} options={[{ value: 'class', label: 'лист на тип' }, { value: 'single', label: 'один лист' }]} /></div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar>
          <span className={`text-xs ${muted}`}>
            {count(table.rows.length, 'позиция', 'позиции', 'позиций')} · {count(columns.length, 'столбец', 'столбца', 'столбцов')}
            {missing > 0 && ` · без данных: ${count(missing, 'ячейка', 'ячейки', 'ячеек')}`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.xls" hidden aria-label="Заполненная книга атрибутов" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
            {undoable && <Btn tone="ghost" disabled={busy} onClick={() => void undo()} title="Вернуть значения КИП, как они были до последней загрузки книги"><Undo2 className="w-3.5 h-3.5" /> Отменить загрузку</Btn>}
            <Btn disabled={busy} onClick={() => fileRef.current?.click()} title="Принять заполненную книгу: значения КИП лягут в характеристики позиций"><Upload className="w-3.5 h-3.5" /> Загрузить Excel</Btn>
            <Btn tone="primary" disabled={!table.rows.length || !columns.length} onClick={save}><Download className="w-3.5 h-3.5" /> Скачать Excel</Btn>
          </div>
        </Toolbar>
        <div className="min-h-0 flex-1 overflow-auto">
          {!table.rows.length ? <div className="p-4"><Empty title="Позиций нет" text={inScope.length ? 'Снимите часть отбора.' : 'В проекте пока нет оборудования.'} /></div>
            : !columns.length ? <div className="p-4"><Empty title="Нет столбцов" text="Для выбранных типов в справочнике нет атрибутов." /></div> : (
              <table className="fx-table text-left">
                <thead><tr>
                  <th>Позиция</th><th>Тип</th>
                  {columns.map((c) => <th key={c.key} title={isFluxColumn(c) ? c.key.slice(3) : 'Без «Да»: столбец пустой, его заполняют в Excel'} className={isFluxColumn(c) ? '' : '!text-slate-400 dark:!text-slate-500'}>{c.label}</th>)}
                </tr></thead>
                <tbody>{table.rows.slice(0, SHOWN).map((r, i) => (
                  <tr key={`${r.id}:${i}`}>
                    <td className="whitespace-nowrap font-mono">{r.label || '—'}</td>
                    <td className="whitespace-nowrap">{classById(r.cls).title}</td>
                    {columns.map((c, j) => {
                      const none = isMissingCell(c, r.cells[j], r.na[j]);
                      return <td key={c.key} title={none ? 'Нет данных: у позиции не заполнена характеристика' : undefined}
                        className={`max-w-[220px] truncate ${none ? 'bg-amber-100 dark:bg-amber-500/15' : ''}`}>{r.cells[j]}</td>;
                    })}
                  </tr>
                ))}</tbody>
              </table>
            )}
        </div>
        {(table.rows.length > SHOWN || missing > 0) && <div className={`border-t border-slate-200 px-4 py-1 text-xs dark:border-slate-800 ${muted}`}>
          {table.rows.length > SHOWN && `Показано ${SHOWN} из ${table.rows.length} — в книгу попадут все. `}
          {missing > 0 && 'Янтарная ячейка: у атрибута есть «Да», а данных в проекте нет.'}
        </div>}
      </div>
      {preview && <E3UploadDialog preview={preview} busy={busy} error={uploadError} onApply={() => void apply()} onClose={() => { setPreview(null); setUploadError(''); }} />}
    </div>
  );
}
