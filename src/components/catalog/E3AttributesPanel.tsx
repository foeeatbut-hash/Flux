/**
 * Справочник атрибутов E3 в Каталоге (docs/e3-integration.md, 5.5).
 *
 * «Да» у атрибута значит «значение даёт Flux»; без «Да» столбец выгрузки
 * остаётся пустым, его заполняют руками в Excel. Читать справочник могут все,
 * править и загружать — по правам рабочей области каталога. Правка — по одному
 * атрибуту: так устаревшая версия (чужая правка) не затирает соседние строки.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload, Undo2 } from 'lucide-react';
import type { E3Attribute, E3AttributeBook, E3Plan } from '../../../e3/attributes';
import { e3AttributesService as svc, E3VersionError, type E3ItemPatch } from '../../services/e3AttributesService';
import { useToastStore } from '../../store/toastStore';
import { Btn, Chip, Empty, Input, Select, confirmAsk } from './ui';
import { FilterSeg, Seg, SectionHead, Toolbar } from '../ui';
import { count } from '../../lib/plural';
import E3AttributesByClass from './E3AttributesByClass';
import E3AttributeDialog from './E3AttributeDialog';
import E3ImportDialog, { readAttributeFile } from './E3AttributesImport';
import { CONFLICT_TITLES, classesText, sourceText } from './e3AttributeText';

const attrs = (n: number) => count(n, 'атрибут', 'атрибута', 'атрибутов');
// Серверный текст 409 кончается словом «Обновите»: окно само перечитывает справочник, так что говорит, что уже сделано
const STALE = 'Справочник атрибутов изменён коллегой — он перечитан, повторите действие.';
const muted = 'text-slate-500 dark:text-slate-400';
const cell = 'truncate max-w-[200px]';
const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function E3AttributesPanel({ rights }: { rights: { edit: boolean; import: boolean } }) {
  const addToast = useToastStore((s) => s.addToast);
  const [book, setBook] = useState<E3AttributeBook | null>(null);
  const [error, setError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [cls, setCls] = useState('');
  const [view, setView] = useState<'all' | 'yes' | 'removed'>('all');
  const [editing, setEditing] = useState('');
  const [mode, setMode] = useState<'list' | 'byClass'>('list');
  const [imp, setImp] = useState<{ items: E3Attribute[]; issues: string[]; plan: E3Plan } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try { setBook(await svc.load()); setError(''); } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const items = book?.items || [];
  const classes = useMemo(() => [...new Set(items.map((a) => a.attrClass).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')), [items]);
  const shown = useMemo(() => {
    const low = q.trim().toLocaleLowerCase('ru');
    return items.filter((a) => (!cls || a.attrClass === cls) && (view === 'removed' ? a.removed : !a.removed && (view === 'all' || a.fromFlux))
      && (!low || a.name.toLocaleLowerCase('ru').includes(low) || a.title.toLocaleLowerCase('ru').includes(low)));
  }, [items, q, cls, view]);
  const removedCount = items.filter((a) => a.removed).length;
  const activeCount = items.length - removedCount;
  // Откатили загрузку — снятых нет, а фильтр «Снятые» остался бы пустым и без кнопки
  useEffect(() => { if (view === 'removed' && !removedCount) setView('all'); }, [view, removedCount]);
  const yesCount = items.filter((a) => a.fromFlux && !a.removed).length;

  /** Одна правка одного атрибута. Устаревшая версия: сообщение и перечитать — правка не применяется */
  const mutate = async (name: string, patch: E3ItemPatch, inDialog = !!editing): Promise<boolean> => {
    if (!book) return false;
    try {
      const r = await svc.update(name, patch, book.version);
      setBook(r.book); setError(''); setDialogError('');
      return true;
    } catch (e: any) {
      const text = e instanceof E3VersionError ? STALE : e.message;
      if (inDialog) setDialogError(text); else setError(text);
      if (e instanceof E3VersionError) await reload();
      return false;
    }
  };

  const save = async (patch: E3ItemPatch) => {
    setBusy(true);
    const ok = await mutate(editing, patch);
    setBusy(false);
    if (ok) setEditing('');
  };
  const toggle = async (a: E3Attribute) => { setBusy(true); await mutate(a.name, { fromFlux: !a.fromFlux }); setBusy(false); };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const parsed = await readAttributeFile(file);
      if (!parsed.items.length) { setError(parsed.issues[0] || 'В файле нет атрибутов'); return; }
      setDialogError('');
      setImp({ ...parsed, plan: await svc.plan(parsed.items) });
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const apply = async (missing: 'keep' | 'remove') => {
    if (!imp || !book) return;
    setBusy(true); setDialogError('');
    try {
      const r = await svc.apply(imp.items, book.version, missing);
      setBook(r.book); setImp(null);
      addToast(`Справочник обновлён: ${attrs(r.book.items.length)}. Загрузку можно отменить.`, 'success');
    } catch (e: any) {
      if (e instanceof E3VersionError) {
        // Пока читали файл, коллега записал своё: показываем план заново на свежей книге
        try { await reload(); setImp({ ...imp, plan: await svc.plan(imp.items) }); } catch (_) { /* план останется прежним */ }
        setDialogError('Справочник атрибутов изменён коллегой. План пересчитан по свежему справочнику — проверьте и запишите ещё раз.');
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
      const ok = await confirmAsk('Отменить последнюю загрузку?', `Справочник вернётся к состоянию до загрузки от ${when(rev.createdAt)}: ${attrs(rev.count)}.${later}`, { confirmLabel: 'Отменить загрузку', tone: 'danger' });
      if (!ok) return;
      const r = await svc.undo(rev.id, book.version);
      setBook(r.book);
      addToast('Загрузка отменена', 'success');
    } catch (e: any) {
      setError(e instanceof E3VersionError ? STALE : e.message);
      if (e instanceof E3VersionError) await reload();
    } finally { setBusy(false); }
  };

  const editingAttr = items.find((a) => a.name === editing);
  const modeSeg = (
    <Seg label="Как показать справочник" value={mode} onChange={(m) => { setMode(m); setDialogError(''); }}
      options={[{ value: 'list', label: 'Список' }, { value: 'byClass', label: 'По типам', hint: 'Откуда Flux берёт значение атрибута для каждого типа оборудования' }]} />
  );
  const upload = rights.import && <>
    <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.xls" hidden aria-label="Файл списка атрибутов" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
    <Btn onClick={() => void undoImport()} tone="ghost" disabled={busy || !items.length}><Undo2 className="w-3.5 h-3.5" /> Отменить последнюю загрузку</Btn>
    <Btn tone="primary" onClick={() => fileRef.current?.click()} disabled={busy}><Upload className="w-3.5 h-3.5" /> Загрузить из Excel</Btn>
  </>;

  return (
    <div className="fx-page rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
      <SectionHead title="Атрибуты E3" count={items.length ? attrs(activeCount) : ''} actions={<>{modeSeg}{upload}</>} />
      {error && !editing && <p role="alert" className="fx-error px-4 py-1">{error}</p>}
      {!book ? <p className={`p-4 text-sm ${muted}`}>{error ? '' : 'Загружаю справочник…'}</p>
        : !items.length ? (
          <div className="p-4"><Empty title="Справочник пуст — загрузите «Список атрибутов» из Excel" text={rights.import ? 'Значения заполняет Flux у атрибутов с «Да» в первом столбце; остальные столбцы выгрузки остаются пустыми.' : 'Загрузить справочник может сотрудник с правом на загрузку справочников каталога.'} /></div>
        ) : mode === 'byClass' ? (
          <E3AttributesByClass items={items} canEdit={rights.edit} busy={busy} error={dialogError} onDialogClose={() => setDialogError('')}
            onSave={async (name, patch) => { setBusy(true); const ok = await mutate(name, patch, true); setBusy(false); return ok; }} />
        ) : <>
          <Toolbar>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Имя или описание атрибута" aria-label="Поиск атрибута" className="max-w-[360px] flex-1" />
            <Select value={cls} onChange={setCls} aria-label="Класс атрибута" className="w-auto" options={[{ value: '', label: 'все классы' }, ...classes.map((c) => ({ value: c, label: c }))]} />
            <FilterSeg label="Какие атрибуты показать" value={view} onChange={setView} options={[
              { value: 'all', label: 'Все', count: activeCount }, { value: 'yes', label: 'Заполняет Flux', count: yesCount, hint: 'Только с «Да»: значение даёт Flux' },
              ...(removedCount ? [{ value: 'removed' as const, label: 'Снятые', count: removedCount, hint: 'Сняты загрузкой: в выгрузках не предлагаются' }] : []),
            ]} />
            <span className={`ml-auto text-xs ${muted}`}>
              {shown.length === (view === 'removed' ? removedCount : view === 'yes' ? yesCount : activeCount) ? '' : `Показано ${shown.length}`}
            </span>
          </Toolbar>
          <div className="fx-page-body">
            {!shown.length ? <div className="p-4"><Empty title="Атрибуты не найдены" text="Измените поиск или отбор." /></div> : (
              <table className="fx-table text-left">
                <thead><tr>
                  <th>Имя</th><th>Описание</th><th>Носитель</th><th>Класс</th><th>Служебный</th><th>Заполняет Flux</th><th>Источник</th><th>Типы Flux</th><th>Если скрипт E3 пересчитал</th>
                </tr></thead>
                <tbody>{shown.map((a) => (
                  <tr key={a.name} tabIndex={0} role="button" className="cursor-pointer" onClick={() => setEditing(a.name)}
                    onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setEditing(a.name); } }}>
                    <td className={`${cell} font-mono`} title={a.name}>{a.removed ? <Chip off title="Снят загрузкой: в выгрузках не предлагается">{a.name}</Chip> : a.name}</td>
                    <td className={cell} title={a.title}>{a.title || '—'}</td>
                    <td className="whitespace-nowrap">{a.carrier || '—'}</td>
                    <td className={cell} title={a.attrClass}>{a.attrClass || '—'}</td>
                    <td className={muted}>{a.service ? 'да' : '—'}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" className="accent-emerald-600" checked={a.fromFlux} disabled={!rights.edit || busy}
                        aria-label={`Заполняет Flux: ${a.name}`} onChange={() => void toggle(a)} />
                    </td>
                    <td className={`${cell} ${a.fromFlux ? '' : muted}`}>{sourceText(a.source) || '—'}</td>
                    <td className={`${cell} ${classesText(a) ? '' : muted}`} title={classesText(a)}>{classesText(a) || 'по классу'}</td>
                    <td className={`whitespace-nowrap ${a.fromFlux ? '' : muted}`}>{CONFLICT_TITLES[a.conflict]}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </>}
      {editingAttr && <E3AttributeDialog key={`${editingAttr.name}:${book?.version}`} attr={editingAttr} canEdit={rights.edit} busy={busy} error={dialogError}
        onSave={(p) => void save(p)} onClose={() => { setEditing(''); setDialogError(''); }} />}
      {imp && <E3ImportDialog plan={imp.plan} parseIssues={imp.issues} busy={busy} error={dialogError} onApply={(m) => void apply(m)} onClose={() => { setImp(null); setDialogError(''); }} />}
    </div>
  );
}
