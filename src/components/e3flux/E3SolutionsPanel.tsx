/**
 * Список типовых решений E3 (docs/e3-integration.md, 5.0–5.1): отбор, карточка,
 * загрузка классификатора из Excel с планом, отмена последней загрузки и
 * выгрузка каталога обратно в Excel. Читать могут все, править и загружать —
 * по правам рабочей области каталога. Правка — по одному решению: так чужая
 * правка не затирает соседние строки.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileText, Plus, Undo2, Upload } from 'lucide-react';
import { solutionNames, solutionNamesFile, solutionWorkbookBytes } from '../../../e3/solutionWorkbook';
import type { E3Solution, E3SolutionPlan } from '../../../e3/solutionTypes';
import { e3SolutionsService as svc, E3SolutionVersionError, type E3SolutionPatch } from '../../services/e3SolutionsService';
import { useToastStore } from '../../store/toastStore';
import { fileName } from '../../lib/exchange';
import { count } from '../../lib/plural';
import { Btn, Chip, Empty, FilterSeg, Input, SectionHead, Select, Toolbar } from '../ui';
import { confirmAsk } from '../catalog/ui';
import E3SolutionDialog from './E3SolutionDialog';
import E3SolutionsImport, { readSolutionFile, type ParsedFile } from './E3SolutionsImport';
import { useJump, type JumpProps } from './e3Jump';
import { STALE, type SolutionBookState } from './useSolutionBook';

const sols = (n: number) => count(n, 'решение', 'решения', 'решений');
const muted = 'text-slate-500 dark:text-slate-400';
const cell = 'truncate max-w-[180px]';
const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function E3SolutionsPanel({ state, rights, jump }: { state: SolutionBookState; rights: { edit: boolean; import: boolean }; jump?: JumpProps }) {
  const { book, error, setError, busy, setBusy, reload, run, setBook } = state;
  const addToast = useToastStore((s) => s.addToast);
  const [q, setQ] = useState('');
  const [cls, setCls] = useState('');
  const [view, setView] = useState<'all' | 'open' | 'removed'>('all');
  const [editing, setEditing] = useState<string | null>(null); // '' — новое решение
  const [dialogError, setDialogError] = useState('');
  const [imp, setImp] = useState<{ file: ParsedFile; plan: E3SolutionPlan } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useJump(jump, ['solutions'], (j) => { setDialogError(''); setEditing(j.id ?? null); }, !!state.book);
  const items = book?.solutions || [];
  const live = items.filter((s) => !s.removed);
  const removedCount = items.length - live.length;
  const openCount = live.filter((s) => !s.featuresConfirmed).length;
  const classes = useMemo(() => [...new Set([...items.map((s) => s.mainClass), ...(book?.features || []).map((f) => f.mainClass)].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')), [items, book]);
  const shown = useMemo(() => {
    const low = q.trim().toLocaleLowerCase('ru');
    return items.filter((s) => (!cls || s.mainClass === cls) && (view === 'removed' ? s.removed : !s.removed && (view === 'all' || !s.featuresConfirmed))
      && (!low || `${s.id} ${s.name} ${s.description}`.toLocaleLowerCase('ru').includes(low)));
  }, [items, q, cls, view]);
  // Откатили загрузку — снятых нет, а фильтр «Снятые» остался бы пустым и без кнопки
  useEffect(() => { if (view === 'removed' && !removedCount) setView('all'); }, [view, removedCount]);

  const save = async (patch: E3SolutionPatch, id: string) => {
    const ok = await run((v) => (editing === '' ? svc.createSolution(id, patch, v) : svc.updateSolution(id, patch, v)), setDialogError);
    if (ok) setEditing(null);
  };

  const pick = async (file: File | undefined) => {
    if (!file || !book) return;
    setBusy(true); setError('');
    try {
      const parsed = await readSolutionFile(file, book);
      if (!parsed.items.length && !parsed.ioTable.length) { setError(parsed.issues[0] || 'В файле нет типовых решений и таблицы IO'); return; }
      setDialogError('');
      setImp({ file: parsed, plan: await svc.plan(parsed.items, parsed.dictionary, parsed.ioTable) });
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const apply = async (missing: 'keep' | 'remove') => {
    if (!imp || !book) return;
    setBusy(true); setDialogError('');
    try {
      const r = await svc.apply(imp.file.items, imp.file.dictionary, book.version, missing, imp.file.ioTable);
      setBook(r.book); setImp(null);
      addToast(`Каталог обновлён: ${sols(r.book.solutions.filter((s) => !s.removed).length)}. Загрузку можно отменить.`, 'success');
    } catch (e: any) {
      if (e instanceof E3SolutionVersionError) {
        // Пока читали файл, коллега записал своё: показываем план заново на свежей книге
        try { await reload(); setImp({ ...imp, plan: await svc.plan(imp.file.items, imp.file.dictionary, imp.file.ioTable) }); } catch (_) { /* план останется прежним */ }
        setDialogError('Каталог изменён коллегой. План пересчитан по свежему каталогу — проверьте и запишите ещё раз.');
      } else setDialogError(e.message);
    } finally { setBusy(false); }
  };

  const undoImport = async () => {
    if (!book) return;
    setBusy(true); setError('');
    try {
      const revs = await svc.revisions();
      const at = revs.findIndex((r) => r.action === 'import');
      if (at < 0) { addToast('Загрузок, которые можно отменить, нет', 'info'); return; }
      const rev = revs[at];
      const later = at > 0 ? ` Правки, сделанные после неё (${at}), тоже будут отменены.` : '';
      const ok = await confirmAsk('Отменить последнюю загрузку?', `Каталог вернётся к состоянию до загрузки от ${when(rev.createdAt)}: ${sols(rev.count)}.${later}`, { confirmLabel: 'Отменить загрузку', tone: 'danger' });
      if (!ok) return;
      setBook((await svc.undo(rev.id, book.version)).book);
      addToast('Загрузка отменена', 'success');
    } catch (e: any) {
      setError(e instanceof E3SolutionVersionError ? STALE : e.message);
      if (e instanceof E3SolutionVersionError) await reload();
    } finally { setBusy(false); }
  };

  const download = () => {
    if (!book) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([solutionWorkbookBytes(book)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = fileName('Типовые решения E3', 'xlsx');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    addToast(`Каталог выгружен в Excel: ${sols(live.length)}`, 'success');
  };

  // Список названий для пробы E3 (tools/e3-probe, -NamesFile): имя блока в базе E3 = «Название схемы»
  const downloadNames = () => {
    if (!book) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([solutionNamesFile(book.solutions)], { type: 'text/plain;charset=utf-8' }));
    a.download = 'e3-names.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    addToast(`Названия для пробы выгружены: ${solutionNames(book.solutions).length}`, 'success');
  };

  const editingSolution: E3Solution | null = editing ? items.find((s) => s.id === editing) || null : null;
  const actions = <>
    <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.xls" hidden aria-label="Файл классификатора типовых решений" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
    <Btn tone="ghost" onClick={download} disabled={!live.length} title="Каталог в Excel того же вида, что файл классификатора, плюс столбцы признаков"><Download className="w-3.5 h-3.5" /> Скачать Excel</Btn>
    {rights.edit && <Btn tone="ghost" onClick={() => { setDialogError(''); setEditing(''); }} disabled={busy || !book} title="Добавить типовое решение вручную"><Plus className="w-3.5 h-3.5" /> Добавить</Btn>}
    {rights.import && <>
      <Btn tone="ghost" onClick={() => void undoImport()} disabled={busy || !items.length} title="Вернуть каталог к состоянию до последней загрузки файла"><Undo2 className="w-3.5 h-3.5" /> Отменить загрузку</Btn>
      <Btn tone="primary" onClick={() => fileRef.current?.click()} disabled={busy || !book}><Upload className="w-3.5 h-3.5" /> Загрузить из Excel</Btn>
    </>}
  </>;

  return (
    <div className="fx-page min-w-0">
      <SectionHead title="Типовые решения" count={items.length ? sols(live.length) : ''} actions={actions} />
      {error && editing === null && <p role="alert" className="fx-error px-4 py-1">{error}</p>}
      {!book ? <p className={`p-4 text-sm ${muted}`}>{error ? '' : 'Загружаю каталог…'}</p>
        : !items.length ? (
          <div className="p-4"><Empty title="Каталог пуст — загрузите «Классификатор типовых решений» из Excel" text={rights.import ? 'Решения можно и добавить вручную: список не окончательный и растёт.' : 'Загрузить каталог может сотрудник с правом на загрузку справочников каталога.'} /></div>
        ) : <>
          <Toolbar>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ID, название или описание" aria-label="Поиск решения" className="max-w-[360px] flex-1" />
            <Select value={cls} onChange={setCls} aria-label="Основной класс" className="w-auto" options={[{ value: '', label: 'все классы' }, ...classes.map((c) => ({ value: c, label: c }))]} />
            <FilterSeg label="Какие решения показать" value={view} onChange={setView} options={[
              { value: 'all', label: 'Все', count: live.length },
              { value: 'open', label: 'Признаки не подтверждены', count: openCount, hint: 'Признаки предложены по названию, человек их ещё не просмотрел' },
              ...(removedCount ? [{ value: 'removed' as const, label: 'Снятые', count: removedCount, hint: 'Сняты загрузкой: подбор их не предлагает' }] : []),
            ]} />
            <span className={`ml-auto text-xs ${muted}`}>{shown.length === (view === 'removed' ? removedCount : view === 'open' ? openCount : live.length) ? '' : `Показано ${shown.length}`}</span>
            <Btn tone="ghost" onClick={downloadNames} disabled={!live.length} title="Названия схем по одному в строке (e3-names.txt) для пробы E3: tools/e3-probe, run.cmd -NamesFile"><FileText className="w-3.5 h-3.5" /> Скачать названия для пробы</Btn>
          </Toolbar>
          <div className="fx-page-body">
            {!shown.length ? <div className="p-4"><Empty title="Решения не найдены" text="Измените поиск или отбор." /></div> : (
              <table className="fx-table text-left">
                <thead><tr><th>ID</th><th>Основной класс</th><th>Класс</th><th>Название схемы</th><th>Описание</th><th>Признаки</th></tr></thead>
                <tbody>{shown.slice(0, 500).map((s) => (
                  <tr key={s.id} tabIndex={0} role="button" className="cursor-pointer" onClick={() => { setDialogError(''); setEditing(s.id); }}
                    onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setDialogError(''); setEditing(s.id); } }}>
                    <td className="whitespace-nowrap font-mono">{s.removed ? <Chip off title="Снято загрузкой: подбор не предлагает">{s.id}</Chip> : s.id}</td>
                    <td className="whitespace-nowrap">{s.mainClass}</td>
                    <td className={cell} title={s.subclass}>{s.subclass || '—'}</td>
                    <td className={`${cell} font-mono`} title={s.name}>{s.name}</td>
                    <td className={`${cell} ${s.description ? '' : muted}`} title={s.description}>{s.description || '—'}</td>
                    <td className={`whitespace-nowrap ${s.featuresConfirmed ? '' : muted}`}>{s.featuresConfirmed ? 'подтверждены' : 'предложены'}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            {shown.length > 500 && <p className={`px-4 py-1 text-xs ${muted}`}>Показано 500 из {shown.length} — уточните поиск. В Excel попадут все решения.</p>}
          </div>
        </>}
      {editing !== null && book && (editing === '' || editingSolution) && <E3SolutionDialog key={`${editing}:${book.version}`} solution={editingSolution} classes={classes}
        features={book.features} canEdit={rights.edit} busy={busy} error={dialogError} onSave={(p, id) => void save(p, id)} onClose={() => { setEditing(null); setDialogError(''); }} />}
      {imp && <E3SolutionsImport plan={imp.plan} parseIssues={imp.file.issues} solutionsInFile={imp.file.items.length > 0} busy={busy} error={dialogError} onApply={(m) => void apply(m)} onClose={() => { setImp(null); setDialogError(''); }} />}
    </div>
  );
}
