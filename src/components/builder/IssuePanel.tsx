/**
 * Выпуск: реквизиты, номера бланк-заказов, проверка, ревизия, файлы.
 *
 * Номер документа и ревизия в колонтитуле, дата на титуле и в «Учёте ревизий»
 * берутся из одного выпуска — в бланках E06 они расходились (титул 26.05.2025,
 * лист учёта 26.05.2026; колонтитул «2002_1» внутри 2003). «Что изменилось»
 * считается от снимка прошлого выпуска и подставляется в описание ревизии.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { FileSpreadsheet, FileText, FolderUp, Send, AlertTriangle, CircleCheck, History, Download } from 'lucide-react';
import type { Catalog } from '../../../catalog/model';
import { textOf } from '../../../catalog/model';
import type { SelectionItemData, IssueInfo } from '../../../catalog/selection';
import { HEADER_FIELDS } from '../../../catalog/selection';
import type { BlankLang, BlankTemplate } from '../../../catalog/blank/model';
import { defaultBlankTemplate } from '../../../catalog/blank/defaults';
import { buildBlankData } from '../../../catalog/blank/data';
import { renderBlank } from '../../../catalog/blank/render';
import { checkList, diffItems, diffText } from '../../../catalog/checks';
import { catalogService, type SelectionList, type StoredIssue } from '../../services/catalogService';
import { useCatalogStore } from '../../store/catalogStore';
import { useToastStore } from '../../store/toastStore';
import { useStore } from '../../store/store';
import { gridsToXlsx, bytesToExplorer } from '../../lib/blankXlsx';
import { documentHtml, footerTemplate } from '../../lib/blankHtml';
import { saveBytes } from '../../lib/saveToWindows';
import { Area, Btn, Chip, Field, Input, Seg, Select, SectionTitle, confirmAsk } from '../catalog/ui';

const today = () => new Date().toISOString().slice(0, 10);

/** Следующая ревизия по привычному ряду: 0 → 1, A → B, AN2 → AN3 */
export function nextRev(prev?: string): string {
  if (!prev) return '0';
  const m = /^(.*?)(\d+)$/.exec(prev);
  if (m) return `${m[1]}${Number(m[2]) + 1}`;
  if (/^[A-Y]$/i.test(prev)) return String.fromCharCode(prev.toUpperCase().charCodeAt(0) + 1);
  return `${prev}.1`;
}

export default function IssuePanel({ catalog, list, items, canIssue, onUpdateList }: {
  catalog: Catalog; list: SelectionList; items: SelectionItemData[]; canIssue: boolean;
  onUpdateList: (patch: Partial<Pick<SelectionList, 'header' | 'orderNos' | 'templateId' | 'lang'>>) => Promise<void>;
}) {
  const templates = useCatalogStore((s) => s.templates);
  const loadTemplates = useCatalogStore((s) => s.loadTemplates);
  const addToast = useToastStore((s) => s.addToast);
  const user = useStore((s) => s.user);
  const [header, setHeader] = useState(list.header);
  const [orderNos, setOrderNos] = useState(list.orderNos);
  const [issues, setIssues] = useState<StoredIssue[]>([]);
  const [issue, setIssue] = useState<IssueInfo>({ rev: '0', date: today(), reason: 'Выпущено для согласования', prepared: user?.name || '' });
  const [diff, setDiff] = useState('');
  const [busy, setBusy] = useState('');
  const lang = list.lang as BlankLang;

  useEffect(() => { loadTemplates(); }, [loadTemplates]);
  useEffect(() => { setHeader(list.header); setOrderNos(list.orderNos); }, [list.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const reloadIssues = async () => {
    try {
      const { issues: all } = await catalogService.issues(list.id, true);
      setIssues(all);
      const last = all[all.length - 1];
      setIssue((s) => ({ ...s, rev: nextRev(last?.rev), checked: last?.checked || s.checked, approved: last?.approved || s.approved }));
      setDiff(diffText(diffItems(catalog, last?.snapshot?.items || [], items)));
    } catch { setIssues([]); }
  };
  useEffect(() => { reloadIssues(); }, [list.id, items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const tpl: BlankTemplate = templates.find((t) => t.id === list.templateId)?.layout
    || templates.find((t) => t.isDefault)?.layout || defaultBlankTemplate();
  const repeat = tpl.sheets.find((s) => s.repeat !== 'none')?.repeat || 'family';
  const data = useMemo(() => buildBlankData({ catalog, header, items, orderNos, issue, revisions: [...issues, issue] }, repeat), [catalog, header, items, orderNos, issue, issues, repeat]);
  const problems = useMemo(() => checkList(catalog, items, { header, requiredHeader: ['docNo', 'object', 'customer'] }), [catalog, items, header]);
  const errors = problems.filter((p) => p.level === 'error');
  const dirtyHeader = JSON.stringify(header) !== JSON.stringify(list.header) || JSON.stringify(orderNos) !== JSON.stringify(list.orderNos);

  const fileBase = `${header.docNo || list.name}${issue.rev ? `_${issue.rev}` : ''}`.replace(/[\\/:*?"<>|]+/g, '-');
  const grids = () => renderBlank(tpl, data, lang);

  const saveHeader = async () => {
    try { await onUpdateList({ header, orderNos }); addToast('Реквизиты сохранены', 'success'); } catch (e: any) { addToast(e?.message || 'Не сохранилось', 'error'); }
  };

  const excel = async (to: 'disk' | 'explorer') => {
    setBusy('Собираю Excel…');
    try {
      const bytes = await gridsToXlsx(grids());
      if (to === 'disk') {
        const r = await saveBytes(`${fileBase}.xlsx`, bytes);
        if (r.ok) addToast(r.path ? `Сохранено: ${r.path}` : 'Файл сохранён', 'success');
        else if (!r.canceled) addToast(r.error || 'Не сохранилось', 'error');
      } else {
        await bytesToExplorer(`${fileBase}.xlsx`, bytes, 'XLSX', issue.rev, user?.id);
        addToast('Бланк положен в Проводник', 'success');
      }
    } catch (e: any) { addToast(`Excel не собрался: ${e?.message || e}`, 'error'); } finally { setBusy(''); }
  };

  const pdf = async () => {
    setBusy('Собираю PDF…');
    try {
      const g = grids();
      const html = documentHtml(g, fileBase);
      const win = window as any;
      if (win.electron?.ipcRenderer?.invoke) {
        const r = await win.electron.ipcRenderer.invoke('print:to-pdf', {
          html, title: fileBase, landscape: tpl.page.orientation === 'landscape', pageSize: tpl.page.paper,
          headerTemplate: '<span></span>', footerTemplate: footerTemplate(g[0]),
        });
        if (r?.success) addToast('PDF сохранён', 'success');
        else if (!r?.canceled) addToast(r?.error || 'PDF не сохранился', 'error');
      } else {
        // В браузере — печать страницы: там есть «Сохранить как PDF»
        const w = window.open('', '_blank');
        if (!w) { addToast('Браузер не дал открыть окно печати', 'error'); return; }
        w.document.write(html); w.document.close();
        setTimeout(() => { try { w.print(); } catch { /* окно закрыли */ } }, 400);
      }
    } catch (e: any) { addToast(`PDF не собрался: ${e?.message || e}`, 'error'); } finally { setBusy(''); }
  };

  const doIssue = async () => {
    if (errors.length && !(await confirmAsk('Выпустить с ошибками?', `В ведомости ${errors.length} ошибок. Бланк уйдёт заводу с ними.`, { confirmLabel: 'Выпустить', tone: 'danger' }))) return;
    if (dirtyHeader) await onUpdateList({ header, orderNos });
    setBusy('Выпускаю…');
    try {
      const bytes = await gridsToXlsx(grids());
      let fileId: string | null = null;
      try { fileId = await bytesToExplorer(`${fileBase}.xlsx`, bytes, 'XLSX', issue.rev, user?.id); } catch { /* без Проводника выпуск всё равно записывается */ }
      await catalogService.issue(list.id, { ...issue, diffText: diff, fileId });
      addToast(`Ревизия ${issue.rev} выпущена${fileId ? ', файл — в Проводнике' : ''}`, 'success');
      await reloadIssues();
    } catch (e: any) { addToast(e?.message || 'Выпуск не записался', 'error'); } finally { setBusy(''); }
  };

  const reissue = async (it: StoredIssue) => {
    if (!it.snapshot) return;
    setBusy('Собираю прошлый выпуск…');
    try {
      const d = buildBlankData({ catalog, header: it.snapshot.header, items: it.snapshot.items, orderNos, issue: it, revisions: issues.filter((x) => x.createdAt <= it.createdAt) }, repeat);
      const bytes = await gridsToXlsx(renderBlank(tpl, d, lang));
      await saveBytes(`${it.snapshot.header.docNo || list.name}_${it.rev}.xlsx`, bytes);
    } catch (e: any) { addToast(e?.message || 'Не собралось', 'error'); } finally { setBusy(''); }
  };

  return (
    <div className="grid grid-cols-1 @[1000px]:grid-cols-2 gap-4 min-w-0">
      <div className="flex flex-col gap-2 min-w-0">
        <SectionTitle right={<Btn tone="primary" onClick={saveHeader} disabled={!dirtyHeader}>Сохранить реквизиты</Btn>}>Реквизиты документа</SectionTitle>
        <div className="grid grid-cols-1 @[560px]:grid-cols-2 gap-2">
          {HEADER_FIELDS.map((f) => (
            <Field key={f.key} label={textOf(f.label)} hint={f.key === 'orderLinePattern' ? '{orderNo}-{n}-КОМ — номер б/з, номер строки' : undefined}>
              <Input type={f.key === 'date' ? 'date' : 'text'} value={header[f.key] || ''} onChange={(e) => setHeader({ ...header, [f.key]: e.target.value })} />
            </Field>
          ))}
        </div>
        <SectionTitle>Номера бланк-заказов по листам</SectionTitle>
        <div className="flex flex-col gap-1">
          {data.groups.map((g) => (
            <div key={g.key} className="grid grid-cols-[minmax(0,1fr)_160px] gap-2 items-center">
              <span className="text-xs"><b className="font-mono">{String(g.family.code)}{g.execSuffix}</b> <span className="text-slate-400">· {g.items.length} поз., {g.qtyTotal} шт.</span></span>
              <Input value={orderNos[g.key] || ''} onChange={(e) => setOrderNos({ ...orderNos, [g.key]: e.target.value })} placeholder="255000475" className="font-mono" />
            </div>
          ))}
          {!data.groups.length && <span className="text-xs text-slate-400">Листы появятся, когда в ведомости будут позиции.</span>}
        </div>
      </div>

      <div className="flex flex-col gap-2 min-w-0">
        <SectionTitle>Шаблон и язык</SectionTitle>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-end">
          <Field label="Шаблон бланка">
            <Select value={list.templateId || ''} onChange={(v) => onUpdateList({ templateId: v || null })}
              options={[{ value: '', label: 'основной' }, ...templates.map((t) => ({ value: t.id, label: t.name }))]} />
          </Field>
          <Seg label="Язык" value={lang} onChange={(v) => onUpdateList({ lang: v })} options={[{ value: 'ru', label: 'RU' }, { value: 'en', label: 'EN' }, { value: 'ru+en', label: 'RU+EN' }]} />
        </div>

        <SectionTitle>Проверка</SectionTitle>
        {errors.length ? (
          <div className="rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/20 p-2 text-xs max-h-40 overflow-auto">
            <b className="text-rose-700 dark:text-rose-400 inline-flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Ошибок: {errors.length}</b>
            {errors.slice(0, 20).map((p, i) => <div key={i} className="text-2xs mt-0.5">{items.find((x) => x.id === p.itemId)?.tags[0] || ''} {p.text}</div>)}
          </div>
        ) : <Chip tone="emerald"><CircleCheck className="w-3 h-3" /> ошибок нет, предупреждений {problems.length}</Chip>}

        <SectionTitle>Ревизия</SectionTitle>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Номер"><Input value={issue.rev} onChange={(e) => setIssue({ ...issue, rev: e.target.value })} className="font-mono" /></Field>
          <Field label="Дата"><Input type="date" value={issue.date} onChange={(e) => setIssue({ ...issue, date: e.target.value })} /></Field>
          <Field label="Назначение">
            <Select value={issue.reason} onChange={(v) => setIssue({ ...issue, reason: v })} options={[
              'Выпущено для согласования', 'Выпущено для информации', 'Выпущено для строительства', 'Окончательный / утверждённый', 'Выпущено для закупки',
            ].map((x) => ({ value: x, label: x })).concat(issue.reason && ![
              'Выпущено для согласования', 'Выпущено для информации', 'Выпущено для строительства', 'Окончательный / утверждённый', 'Выпущено для закупки',
            ].includes(issue.reason) ? [{ value: issue.reason, label: issue.reason }] : [])} />
          </Field>
          <Field label="Разработал"><Input value={issue.prepared || ''} onChange={(e) => setIssue({ ...issue, prepared: e.target.value })} /></Field>
          <Field label="Проверил"><Input value={issue.checked || ''} onChange={(e) => setIssue({ ...issue, checked: e.target.value })} /></Field>
          <Field label="Утвердил"><Input value={issue.approved || ''} onChange={(e) => setIssue({ ...issue, approved: e.target.value })} /></Field>
        </div>
        <Field label="Что изменилось" hint="посчитано от прошлого выпуска — поправьте, если нужно">
          <Area rows={4} value={diff} onChange={(e) => setDiff(e.target.value)} />
        </Field>

        <div className="flex flex-wrap gap-1.5 items-center">
          <Btn onClick={() => excel('disk')} disabled={!!busy || !items.length}><FileSpreadsheet className="w-3.5 h-3.5" /> Excel</Btn>
          <Btn onClick={pdf} disabled={!!busy || !items.length}><FileText className="w-3.5 h-3.5" /> PDF</Btn>
          <Btn onClick={() => excel('explorer')} disabled={!!busy || !items.length}><FolderUp className="w-3.5 h-3.5" /> В Проводник</Btn>
          {canIssue && <Btn tone="primary" onClick={doIssue} disabled={!!busy || !items.length || !issue.rev.trim()}><Send className="w-3.5 h-3.5" /> Выпустить ревизию {issue.rev}</Btn>}
          {busy && <span className="text-xs text-slate-500">{busy}</span>}
        </div>

        <SectionTitle>Выпуски</SectionTitle>
        {!issues.length && <div className="text-xs text-slate-400">Ведомость ещё не выпускалась.</div>}
        {[...issues].reverse().map((it) => (
          <div key={it.id} className="rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <History className="w-3.5 h-3.5 text-slate-400" />
              <b className="font-mono">рев. {it.rev}</b>
              <span className="tabular-nums text-slate-500 dark:text-slate-400">{it.date}</span>
              <span className="text-slate-500 dark:text-slate-400 truncate min-w-0 flex-1">{it.reason}</span>
              {it.snapshot && <Btn tone="ghost" onClick={() => reissue(it)} title="Скачать этот выпуск ещё раз"><Download className="w-3.5 h-3.5" /></Btn>}
            </div>
            {it.diffText && <div className="text-2xs text-slate-500 dark:text-slate-400 whitespace-pre-wrap mt-0.5 line-clamp-4">{it.diffText}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
