import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import {
  FileSpreadsheet, Plus, Upload, Download, RefreshCw, Trash2, FileText, ArrowUpCircle,
  CheckCircle2, AlertTriangle, Send, Loader2, X, Search, Settings2, Tag as TagIcon, History, Languages,
} from 'lucide-react';
import { countOf } from '../lib/plural';
import { officePathForKind } from '../lib/fileTypes';
import { useModalStore } from '../store/modalStore';
import { useTranslateStore } from '../store/translateStore';

// Диалоги программы вместо системных окон Windows
const { openPrompt } = useModalStore.getState();

// ── ВДР 2.0: реестр документации (вкладка «Менеджмент») ──
// Ручная таблица в первую очередь: всё правится в карточке строки; автоматика
// (коды рассмотрения → статус и срок, ревизии) только помогает. Структура
// колонок гибкая (columnsConfig реестра: импортированные + свои), стандарты
// документооборота — глобальные (настраиваются в реквизитах реестра).

interface Register {
  id: string; name: string; vendor: string; contractor: string; owner: string;
  poNumber: string; standardId?: string | null; managerId?: string | null;
  ownerProjectNo: string; contractorProjectNo: string; materialRequisition: string;
  equipmentTitle: string; contractorDocNo: string; ownerDocNo: string; vendorDocNo: string;
  revision: string; revisions: any[]; preparedBy: string; checkedBy: string; approvedBy: string;
  preparedById?: string | null; checkedById?: string | null; approvedById?: string | null;
  columnsConfig: ColumnDef[]; counts: Record<string, number>;
}
interface ColumnDef { key: string; title: string; titleRu?: string; field?: string; source?: string; type?: string }
interface Item {
  id: string; registerId: string; contractorNo: string; ownerNo: string; vendorNo: string;
  titleEn: string; titleRu: string; vdrCode: string; revision: string;
  issueDate?: string | null; reasonForIssue: string; language: string;
  equipmentTags: string; status: string; docId?: string | null; fileNodeId?: string | null;
  assigneeId?: string | null; remarks: string; reviewCode: string; dueDate?: string | null;
  extra: Record<string, string>;
}
interface UserLite { id: string; name: string; role?: string; hasSignature?: boolean }
interface Standard { id: string; name: string; config: any }

const STATUS_META: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'В работе', cls: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300' },
  READY: { label: 'Готово', cls: 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400' },
  REMARKS: { label: 'Замечания', cls: 'bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400' },
  ACCEPTED: { label: 'Принят', cls: 'bg-sky-100 dark:bg-sky-950/50 text-sky-700 dark:text-sky-400' },
};

const fmtD = (s?: string | null) => { try { return s ? new Date(s).toLocaleDateString('ru-RU') : ''; } catch { return ''; } };
const overdue = (s?: string | null) => !!s && new Date(s).getTime() < Date.now();
const tagsOf = (it: Item): string[] => { try { const t = JSON.parse(it.equipmentTags || '[]'); return Array.isArray(t) ? t : []; } catch { return []; } };

export default function VdrPanel() {
  const user = useStore(s => s.user);
  const activeProject = useStore(s => s.activeProject);
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const projectId = activeProject?.id || 'default';
  const canManage = user?.role === 'ADMIN' || user?.role === 'MANAGER';

  const [registers, setRegisters] = useState<Register[]>([]);
  const [regId, setRegId] = useState<string>(searchParams.get('vdr') || '');
  const [items, setItems] = useState<Item[]>([]);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [standards, setStandards] = useState<Standard[]>([]);
  const [projectTags, setProjectTags] = useState<{ id: string; identifier: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [codeFilter, setCodeFilter] = useState('');
  const [onlyMine, setOnlyMine] = useState(!canManage); // инженер видит своё
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const [cardItem, setCardItem] = useState<Item | null>(null); // карточка строки
  const [regSettingsOpen, setRegSettingsOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const focusItemId = searchParams.get('item');

  const register = registers.find(r => r.id === regId) || null;
  const standard = standards.find(s => s.id === register?.standardId) || standards[0] || null;

  const loadRegisters = async (): Promise<Register[]> => {
    try {
      const r = await fetch(`/api/vdr/registers?projectId=${projectId}`);
      if (!r.ok) return [];
      const regs: Register[] = (await r.json()).registers || [];
      setRegisters(regs);
      return regs;
    } catch (_) { return []; }
  };
  const loadItems = async (id: string) => {
    if (!id) { setItems([]); return; }
    try {
      const r = await fetch(`/api/vdr/items?registerId=${id}`);
      if (r.ok) setItems((await r.json()).items || []);
    } catch (_) {}
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      const regs = await loadRegisters();
      const chosen = regs.find(r => r.id === regId)?.id || regs[0]?.id || '';
      setRegId(chosen);
      await loadItems(chosen);
      setLoading(false);
      fetch('/api/users').then(r => r.ok ? r.json() : { users: [] }).then(d => setUsers((d.users || []).filter((u: any) => u.isActive !== false))).catch(() => {});
      fetch('/api/vdr/standards').then(r => r.ok ? r.json() : { standards: [] }).then(d => setStandards(d.standards || [])).catch(() => {});
      fetch(`/api/projects/${projectId}/tags`).then(r => r.ok ? r.json() : []).then(d => {
        const list = Array.isArray(d) ? d : (d.tags || []);
        setProjectTags(list.map((t: any) => ({ id: t.id, identifier: t.identifier })));
      }).catch(() => {});
    })();
  }, [projectId]);

  useEffect(() => { if (regId) { loadItems(regId); setSelected(new Set()); } }, [regId]);
  // Открыть карточку по deep-link из уведомления
  useEffect(() => {
    if (focusItemId && items.length && !cardItem) {
      const it = items.find(x => x.id === focusItemId);
      if (it) setCardItem(it);
    }
  }, [focusItemId, items.length]);

  const refresh = async () => {
    await loadRegisters();
    await loadItems(regId);
    if (cardItem) {
      const fresh = (await (await fetch(`/api/vdr/items?registerId=${regId}`)).json()).items?.find((x: Item) => x.id === cardItem.id);
      if (fresh) setCardItem(fresh);
    }
  };

  const patchItem = async (id: string, body: any, okMsg?: string) => {
    const r = await fetch(`/api/vdr/items/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) { if (okMsg) addToast(okMsg, 'success'); await refresh(); }
    else { const d = await r.json().catch(() => ({})); addToast(d.error || 'Ошибка', 'error'); }
  };

  /**
   * Заполнить пустые английские названия.
   *
   * Реестр сам себя учит: каждая пара, введённая инженером руками, уже лежит в
   * памяти переводов, и следующие строки берут перевод из неё. Заполненное
   * вручную не трогаем — согласованное с заказчиком название не должно
   * поменяться от нажатия кнопки.
   */
  const fillEnglishTitles = async () => {
    const empty = items.filter((i) => i.titleRu?.trim() && !i.titleEn?.trim());
    if (!empty.length) { addToast('Пустых английских названий нет', 'info'); return; }
    const one = useTranslateStore.getState().one;
    const done: { id: string; en: string; ru: string }[] = [];
    for (const it of empty) {
      const seg = one(it.titleRu.trim(), 'ru', 'en');
      if (!seg.dst.trim() || seg.origin === 'none') continue;
      done.push({ id: it.id, en: seg.dst.trim(), ru: it.titleRu.trim() });
    }
    if (!done.length) {
      addToast('Ни одного названия не удалось перевести — пополните словарь в Переводчике', 'error');
      return;
    }
    for (const d of done) {
      await fetch(`/api/vdr/items/${d.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titleEn: d.en }),
      });
    }
    await useTranslateStore.getState().remember(
      done.map((d) => ({ src: d.ru, dst: d.en, from: 'ru' as const, to: 'en' as const })),
    );
    addToast(`Заполнено английских названий: ${done.length} из ${empty.length}. Прочитайте их перед выпуском`, 'success');
    await refresh();
  };

  const createDoc = async (it: Item) => {
    const r = await fetch(`/api/vdr/items/${it.id}/create-doc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) { addToast('Не удалось создать документ', 'error'); return; }
    const made = (await r.json()).doc;
    navigate(`${officePathForKind(made.kind)}?doc=${made.id}`);
  };

  const importXlsx = async (file: File) => {
    setImporting(true);
    try {
      const b64: string = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(file); });
      const r = await fetch('/api/vdr/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, content: b64, fileName: file.name, registerId: regId || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { addToast(d.error || 'Ошибка импорта', 'error'); return; }
      addToast(`Импорт «${d.sheet}»: +${d.created} новых, ${d.updated} обновлено, колонок: ${d.columns}`, 'success');
      const regs = await loadRegisters();
      const target = d.register?.id || regId || regs[0]?.id || '';
      setRegId(target); await loadItems(target);
    } finally { setImporting(false); }
  };

  const exportXlsx = async () => {
    if (!register) return;
    const r = await fetch(`/api/vdr/registers/${register.id}/export`);
    if (!r.ok) { addToast('Ошибка экспорта', 'error'); return; }
    const name = decodeURIComponent(r.headers.get('x-file-name') || 'VDR.xlsx');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
    addToast(`Выгружен «${name}»`, 'success');
  };

  const registerRevisionUp = async () => {
    if (!register) return;
    const description = await openPrompt('Новая ревизия ВДР', `Текущая ревизия — ${register.revision}. Опишите, что изменилось.`, 'Например: уточнены сроки поставки');
    if (description === null) return;
    const r = await fetch(`/api/vdr/registers/${register.id}/revision-up`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description }),
    });
    if (r.ok) { const d = await r.json(); addToast(`ВДР → ревизия ${d.register.revision}`, 'success'); refresh(); }
  };

  const createRegister = async () => {
    const name = await openPrompt('Новый реестр', 'Как назвать реестр документов?', 'Например: ВДР по котельной', 'ВДР');
    if (!name) return;
    const r = await fetch('/api/vdr/registers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, name, standardId: standards[0]?.id }),
    });
    if (r.ok) { const d = await r.json(); await loadRegisters(); setRegId(d.register.id); }
  };

  const bulkAssign = async (userId: string) => {
    for (const id of selected) await fetch(`/api/vdr/items/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assigneeId: userId || null }) });
    addToast(`Исполнитель назначен: ${countOf(selected.size, 'строка')}`, 'success');
    setSelected(new Set()); refresh();
  };

  const codes = useMemo(() => [...new Set(items.map(i => i.vdrCode).filter(Boolean))].sort(), [items]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(i => {
      if (onlyMine && i.assigneeId !== user?.id) return false;
      if (onlyOverdue && !overdue(i.dueDate)) return false;
      if (statusFilter && i.status !== statusFilter) return false;
      if (codeFilter && i.vdrCode !== codeFilter) return false;
      if (!q) return true;
      return [i.contractorNo, i.ownerNo, i.vendorNo, i.titleRu, i.titleEn, i.vdrCode, ...tagsOf(i)]
        .some(v => String(v || '').toLowerCase().includes(q));
    });
  }, [items, search, statusFilter, codeFilter, onlyMine, onlyOverdue, user?.id]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { DRAFT: 0, READY: 0, REMARKS: 0, ACCEPTED: 0 };
    let od = 0;
    for (const i of items) { c[i.status] = (c[i.status] || 0) + 1; if (overdue(i.dueDate)) od++; }
    return { ...c, OVERDUE: od };
  }, [items]);

  if (loading) return <div className="flex items-center justify-center py-20 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  return (
    <div className="flex flex-col gap-3 text-slate-800 dark:text-slate-100">
      {/* Шапка */}
      <div className="flex flex-wrap items-center gap-2 p-3 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-xl shadow-xs">
        <FileSpreadsheet className="w-5 h-5 text-emerald-500 shrink-0" />
        {registers.length > 0 ? (
          <>
            <select value={regId} onChange={e => setRegId(e.target.value)}
              className="px-2.5 py-1.5 text-sm font-semibold border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-950 text-slate-800 dark:text-white cursor-pointer max-w-64">
              {registers.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            {register && <span className="px-2 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 text-xs font-bold" title="Текущая ревизия самого ВДР">рев. {register.revision}</span>}
          </>
        ) : (
          <span className="text-sm text-slate-400">Реестров нет — создайте или импортируйте Excel-ВДР</span>
        )}
        <div className="flex-1" />
        <label className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer ${importing ? 'opacity-60 pointer-events-none' : ''}`}>
          {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Импорт
          <input type="file" accept=".xlsx,.xls,.xlsm" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) importXlsx(f); e.target.value = ''; }} />
        </label>
        {register && (
          <>
            <button type="button" onClick={exportXlsx} title="Выгрузить ВДР в Excel (формат заказчика: титул + ревизии + реестр)"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer">
              <Download className="w-3.5 h-3.5" /> Выгрузить
            </button>
            <button type="button" onClick={registerRevisionUp} title="Новая ревизия самого ВДР (запись в Учёт ревизий)"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer">
              <ArrowUpCircle className="w-3.5 h-3.5" /> Рев. ВДР
            </button>
            <button type="button" onClick={fillEnglishTitles} title="Заполнить пустые английские названия по памяти и словарю проекта"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer">
              <Languages className="w-3.5 h-3.5" /> Англ. названия
            </button>
            <button type="button" onClick={() => setRegSettingsOpen(true)} title="Реквизиты реестра, стандарт, свои колонки"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer">
              <Settings2 className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={() => setCardItem({ id: '', registerId: register.id, contractorNo: '', ownerNo: '', vendorNo: '', titleEn: '', titleRu: '', vdrCode: '', revision: 'A', reasonForIssue: '', language: '', equipmentTags: '[]', status: 'DRAFT', remarks: '', reviewCode: '', extra: {} })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer">
              <Plus className="w-3.5 h-3.5" /> Строка
            </button>
          </>
        )}
        <button type="button" onClick={createRegister} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer">
          <Plus className="w-3.5 h-3.5" /> Реестр
        </button>
        <button type="button" title="Обновить список" onClick={refresh} className="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer"><RefreshCw className="w-3.5 h-3.5" /></button>
      </div>

      {register && (
        <>
          {/* Фильтры */}
          <div className="flex flex-wrap items-center gap-2">
            {Object.entries(STATUS_META).map(([st, meta]) => (
              <button type="button" key={st} onClick={() => setStatusFilter(statusFilter === st ? '' : st)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer border transition-ui ${statusFilter === st ? 'border-emerald-500 ring-1 ring-emerald-400' : 'border-transparent'} ${meta.cls}`}>
                {meta.label}: {counts[st] || 0}
              </button>
            ))}
            <button type="button" onClick={() => setOnlyOverdue(v => !v)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer border transition-ui bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-400 ${onlyOverdue ? 'border-rose-500 ring-1 ring-rose-400' : 'border-transparent'}`}>
              Просрочено: {counts.OVERDUE}
            </button>
            <button type="button" onClick={() => setOnlyMine(v => !v)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer border transition-ui ${onlyMine ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white dark:bg-slate-950 text-slate-500 border-slate-200 dark:border-slate-800'}`}>
              Мои
            </button>
            <div className="flex-1" />
            {selected.size > 0 && (
              <select defaultValue="" onChange={e => { if (e.target.value !== '') bulkAssign(e.target.value); }}
                className="px-2 py-1.5 text-xs border border-emerald-300 dark:border-emerald-800 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 cursor-pointer font-bold">
                <option value="" disabled>Назначить {countOf(selected.size, 'строка')}…</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            )}
            {codes.length > 0 && (
              <select value={codeFilter} onChange={e => setCodeFilter(e.target.value)}
                className="px-2 py-1.5 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-950 text-slate-600 dark:text-slate-300 cursor-pointer">
                <option value="">Все типы</option>
                {codes.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Номер, название, тег…"
                className="pl-8 pr-3 py-1.5 text-xs bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-white focus:outline-none focus:border-emerald-500 w-52" />
            </div>
          </div>

          {/* Таблица */}
          <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-xl overflow-hidden">
            <div className="overflow-auto max-h-[calc(100vh-330px)]">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 dark:bg-slate-900 sticky top-0 z-10">
                  <tr className="text-left text-slate-500 dark:text-slate-400">
                    <th className="flux-cell w-8">
                      <input type="checkbox" className="w-3.5 h-3.5 accent-emerald-500 cursor-pointer"
                        checked={selected.size > 0 && selected.size === filtered.length}
                        onChange={e => setSelected(e.target.checked ? new Set(filtered.map(i => i.id)) : new Set())} />
                    </th>
                    <th className="flux-cell font-bold whitespace-nowrap">№ документа</th>
                    <th className="flux-cell font-bold">Наименование</th>
                    <th className="flux-cell font-bold">Тип</th>
                    <th className="flux-cell font-bold">Рев.</th>
                    <th className="flux-cell font-bold whitespace-nowrap">Срок</th>
                    <th className="flux-cell font-bold">Код</th>
                    <th className="flux-cell font-bold">Статус</th>
                    <th className="flux-cell font-bold">Теги</th>
                    <th className="flux-cell font-bold">Исполнитель</th>
                    <th className="flux-cell font-bold text-right">Действия</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-900">
                  {filtered.map(it => (
                    <tr key={it.id}
                      onClick={() => setCardItem(it)}
                      className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900/60 ${focusItemId === it.id ? 'bg-emerald-50 dark:bg-emerald-950/30' : ''}`}>
                      <td className="flux-cell" onClick={e => e.stopPropagation()}>
                        <input type="checkbox" className="w-3.5 h-3.5 accent-emerald-500 cursor-pointer"
                          checked={selected.has(it.id)}
                          onChange={e => setSelected(s => { const n = new Set(s); e.target.checked ? n.add(it.id) : n.delete(it.id); return n; })} />
                      </td>
                      <td className="flux-cell font-semibold whitespace-nowrap">{it.contractorNo || it.ownerNo || '—'}</td>
                      <td className="flux-cell max-w-80"><div className="truncate" title={`${it.titleRu}\n${it.titleEn}`}>{it.titleRu || it.titleEn}</div></td>
                      <td className="flux-cell whitespace-nowrap">{it.vdrCode}</td>
                      <td className="flux-cell font-bold">{it.revision}</td>
                      <td className={`flux-cell whitespace-nowrap ${overdue(it.dueDate) ? 'text-rose-600 font-bold' : 'text-slate-500'}`}>{fmtD(it.dueDate)}</td>
                      <td className="flux-cell font-bold">{it.reviewCode}</td>
                      <td className="flux-cell"><span className={`px-2 py-0.5 rounded-md font-bold whitespace-nowrap ${STATUS_META[it.status]?.cls || ''}`}>{STATUS_META[it.status]?.label || it.status}</span></td>
                      <td className="flux-cell max-w-36"><div className="truncate text-slate-500" title={tagsOf(it).join('; ')}>{tagsOf(it).slice(0, 2).join('; ')}{tagsOf(it).length > 2 ? '…' : ''}</div></td>
                      <td className="flux-cell whitespace-nowrap text-slate-500">{users.find(u => u.id === it.assigneeId)?.name?.split(' ')[0] || '—'}</td>
                      <td className="flux-cell" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-0.5">
                          {it.docId ? (
                            <button type="button" title="Открыть документ" onClick={() => navigate(`/sheet?doc=${it.docId}`)}
                              className="p-1.5 rounded-lg text-sky-600 hover:bg-sky-50 dark:hover:bg-sky-950/40 cursor-pointer"><FileText className="w-3.5 h-3.5" /></button>
                          ) : (
                            <button type="button" title="Сформировать документ" onClick={() => createDoc(it)}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-sky-600 hover:bg-sky-50 dark:hover:bg-sky-950/40 cursor-pointer"><Plus className="w-3.5 h-3.5" /></button>
                          )}
                          {it.status !== 'READY' && it.status !== 'ACCEPTED' && (
                            <button type="button" title="Готово — уведомить менеджера" onClick={() => patchItem(it.id, { status: 'READY' }, 'Менеджер уведомлён')}
                              className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 cursor-pointer"><Send className="w-3.5 h-3.5" /></button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr><td colSpan={11} className="px-4 py-10 text-center text-slate-400">Строк нет{onlyMine ? ' (фильтр «Мои» включён)' : ''}.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-3 py-2 text-xs text-slate-400 bg-slate-50 dark:bg-slate-900 border-t border-slate-100 dark:border-slate-850">
              {filtered.length} из {countOf(items.length, 'строка')} {register.poNumber ? `· Заказ ${register.poNumber}` : ''} {register.vendor ? `· ${register.vendor}` : ''} {standard ? `· Стандарт: ${standard.name}` : ''}
            </div>
          </div>
        </>
      )}

      {cardItem && register && (
        <ItemCard
          item={cardItem}
          register={register}
          standard={standard}
          users={users}
          projectTags={projectTags}
          onClose={() => setCardItem(null)}
          onChanged={refresh}
          onOpenDoc={(id) => navigate(`/sheet?doc=${id}`)}
          onCreateDoc={() => createDoc(cardItem)}
        />
      )}
      {regSettingsOpen && register && (
        <RegisterSettings register={register} standards={standards} users={users}
          onClose={() => setRegSettingsOpen(false)} onChanged={refresh} />
      )}
    </div>
  );
}

// ═════════ Карточка строки: все поля по группам, теги, ревизии ═════════
function ItemCard({ item, register, standard, users, projectTags, onClose, onChanged, onOpenDoc, onCreateDoc }: {
  item: Item; register: Register; standard: Standard | null; users: UserLite[];
  projectTags: { id: string; identifier: string }[];
  onClose: () => void; onChanged: () => void; onOpenDoc: (docId: string) => void; onCreateDoc: () => void;
}) {
  const { addToast } = useToastStore();
  const isNew = !item.id;
  const [f, setF] = useState<Item>({ ...item });
  const [revisions, setRevisions] = useState<any[]>([]);
  const [tagSearch, setTagSearch] = useState('');
  const [revDialog, setRevDialog] = useState<null | 'next' | 'certify' | 'void' | 'superseded'>(null);
  const [revPlace, setRevPlace] = useState('');
  const [revDesc, setRevDesc] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (item.id) fetch(`/api/vdr/items/${item.id}/revisions`).then(r => r.ok ? r.json() : { revisions: [] }).then(d => setRevisions(d.revisions || [])).catch(() => {});
  }, [item.id]);

  const reviewCodes = standard?.config?.reviewCodes || [];
  const reasons = standard?.config?.reasons || [];
  const customCols: ColumnDef[] = (register.columnsConfig || []).filter(c => !c.field);
  const tags = tagsOf(f);

  const save = async () => {
    setBusy(true);
    try {
      const body: any = {
        registerId: f.registerId,
        contractorNo: f.contractorNo, ownerNo: f.ownerNo, vendorNo: f.vendorNo,
        titleEn: f.titleEn, titleRu: f.titleRu, vdrCode: f.vdrCode, revision: f.revision,
        reasonForIssue: f.reasonForIssue, language: f.language, remarks: f.remarks,
        equipmentTags: f.equipmentTags, assigneeId: f.assigneeId || null,
        issueDate: f.issueDate || null, dueDate: f.dueDate || null,
        extra: f.extra,
      };
      const r = await fetch(isNew ? '/api/vdr/items' : `/api/vdr/items/${item.id}`, {
        method: isNew ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); addToast(d.error || 'Ошибка', 'error'); return; }
      addToast('Сохранено', 'success');
      onChanged(); if (isNew) onClose();
    } finally { setBusy(false); }
  };

  const setReviewCode = async (code: string) => {
    if (isNew) { setF(s => ({ ...s, reviewCode: code })); return; }
    const r = await fetch(`/api/vdr/items/${item.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewCode: code }) });
    if (r.ok) { const d = await r.json(); setF(d.item); onChanged(); addToast(`Код ${code}: статус и срок обновлены`, 'success'); }
  };

  const issueRevision = async () => {
    if (!revDialog || isNew) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/vdr/items/${item.id}/issue-revision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: revDialog, place: revPlace, description: revDesc }),
      });
      if (!r.ok) { addToast('Не удалось выпустить ревизию', 'error'); return; }
      const d = await r.json();
      setF(d.item);
      setRevDialog(null); setRevPlace(''); setRevDesc('');
      addToast(`Ревизия ${d.item.revision}`, 'success');
      fetch(`/api/vdr/items/${item.id}/revisions`).then(x => x.json()).then(x => setRevisions(x.revisions || []));
      onChanged();
    } finally { setBusy(false); }
  };

  const inputCls = 'w-full mt-0.5 px-2.5 py-1.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-white focus:outline-none focus:border-emerald-500';
  const F = ({ label, k, ph }: { label: string; k: keyof Item; ph?: string }) => (
    <div>
      <label className="block text-xs font-bold text-slate-500 uppercase">{label}</label>
      <input value={String(f[k] ?? '')} onChange={e => setF(s => ({ ...s, [k]: e.target.value }))} placeholder={ph} className={inputCls} />
    </div>
  );
  const Sect = ({ title }: { title: string }) => (
    <div className="pt-2 mt-1 border-t border-slate-100 dark:border-slate-850 text-2xs font-bold uppercase tracking-wide text-emerald-500">{title}</div>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex justify-end" onClick={onClose}>
      <div className="w-[520px] max-w-[94vw] h-full bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <span className="font-bold text-slate-800 dark:text-white truncate flex-1">{isNew ? 'Новая строка' : (f.contractorNo || f.titleRu || 'Строка реестра')}</span>
          {!isNew && <span className={`px-2 py-0.5 rounded-md text-xs font-bold ${STATUS_META[f.status]?.cls || ''}`}>{STATUS_META[f.status]?.label || f.status}</span>}
          <button type="button" title="Закрыть карточку" onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {/* Документ */}
          {!isNew && (
            <div className="flex items-center gap-2">
              {f.docId ? (
                <button type="button" onClick={() => onOpenDoc(f.docId!)} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold cursor-pointer">
                  <FileText className="w-3.5 h-3.5" /> Открыть документ
                </button>
              ) : (
                <button type="button" onClick={onCreateDoc} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-sky-300 dark:border-sky-800 text-sky-700 dark:text-sky-400 text-xs font-bold hover:bg-sky-50 dark:hover:bg-sky-950/30 cursor-pointer">
                  <Plus className="w-3.5 h-3.5" /> Сформировать документ
                </button>
              )}
              <button type="button" onClick={() => setRevDialog('next')} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer" title="Выпустить новую ревизию">
                <ArrowUpCircle className="w-3.5 h-3.5" /> Рев. {f.revision} ↑
              </button>
            </div>
          )}

          <Sect title="Документ" />
          <div className="grid grid-cols-2 gap-2.5">
            <F label="№ подрядчика" k="contractorNo" />
            <F label="№ заказчика" k="ownerNo" />
            <F label="№ поставщика" k="vendorNo" />
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase">Тип (VDR-код)</label>
              <input list="vdr-types" value={f.vdrCode} onChange={e => setF(s => ({ ...s, vdrCode: e.target.value }))} className={inputCls} />
              <datalist id="vdr-types">
                {(standard?.config?.vdrTypes || []).map((t: any) => <option key={t.code} value={t.code}>{t.titleRu || t.titleEn}</option>)}
              </datalist>
            </div>
          </div>
          <F label="Наименование (рус)" k="titleRu" />
          <F label="Наименование (англ)" k="titleEn" />
          <div className="grid grid-cols-3 gap-2.5">
            <F label="Ревизия" k="revision" />
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase">Причина</label>
              <select value={f.reasonForIssue} onChange={e => setF(s => ({ ...s, reasonForIssue: e.target.value }))} className={inputCls + ' cursor-pointer'}>
                <option value="">—</option>
                {reasons.map((r: any) => <option key={r.code} value={r.code}>{r.code}</option>)}
                {f.reasonForIssue && !reasons.find((r: any) => r.code === f.reasonForIssue) && <option value={f.reasonForIssue}>{f.reasonForIssue}</option>}
              </select>
            </div>
            <F label="Язык" k="language" />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase">Дата выпуска</label>
              <input type="date" value={f.issueDate ? String(f.issueDate).slice(0, 10) : ''} onChange={e => setF(s => ({ ...s, issueDate: e.target.value || null }))} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase">Срок след. ревизии</label>
              <input type="date" value={f.dueDate ? String(f.dueDate).slice(0, 10) : ''} onChange={e => setF(s => ({ ...s, dueDate: e.target.value || null }))} className={inputCls} />
            </div>
          </div>

          <Sect title="Рассмотрение" />
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase" title="Код заказчика: статус и срок проставятся сами по стандарту">Код рассмотрения</label>
              <select value={f.reviewCode} onChange={e => setReviewCode(e.target.value)} className={inputCls + ' cursor-pointer'}>
                <option value="">—</option>
                {reviewCodes.map((c: any) => <option key={c.code} value={c.code} title={c.label}>{c.code} — {String(c.label).split('/')[0].trim()}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase">Исполнитель</label>
              <select value={f.assigneeId || ''} onChange={e => setF(s => ({ ...s, assigneeId: e.target.value || null }))} className={inputCls + ' cursor-pointer'}>
                <option value="">—</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase">Замечания</label>
            <textarea value={f.remarks} onChange={e => setF(s => ({ ...s, remarks: e.target.value }))} rows={2} className={inputCls} />
          </div>
          {f.fileNodeId && (
            <button type="button" onClick={() => { window.location.hash = `#/explorer?file=${f.fileNodeId}`; }}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-xs font-bold hover:bg-amber-50 dark:hover:bg-amber-950/30 cursor-pointer">
              <FileText className="w-3.5 h-3.5" /> Прикреплённый файл — открыть в Проводнике
            </button>
          )}

          <Sect title="Главные теги (оборудование документа)" />
          <div className="flex flex-wrap gap-1.5">
            {tags.map(t => (
              <span key={t} className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 text-xs font-bold">
                <TagIcon className="w-3 h-3" /> {t}
                <button type="button" onClick={() => setF(s => ({ ...s, equipmentTags: JSON.stringify(tags.filter(x => x !== t)) }))} className="hover:text-rose-500 cursor-pointer"><X className="w-3 h-3" /></button>
              </span>
            ))}
            {tags.length === 0 && <span className="text-xs text-slate-400">не присвоены</span>}
          </div>
          <div className="relative">
            <input value={tagSearch} onChange={e => setTagSearch(e.target.value)} placeholder="Найти тег проекта и добавить…" className={inputCls} />
            {tagSearch.trim() && (
              <div className="absolute z-10 left-0 right-0 mt-1 max-h-40 overflow-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl">
                {projectTags.filter(t => t.identifier.toLowerCase().includes(tagSearch.toLowerCase()) && !tags.includes(t.identifier)).slice(0, 12).map(t => (
                  <button type="button" key={t.id} onClick={() => { setF(s => ({ ...s, equipmentTags: JSON.stringify([...tags, t.identifier]) })); setTagSearch(''); }}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-emerald-50 dark:hover:bg-emerald-950/30 cursor-pointer">{t.identifier}</button>
                ))}
                <button type="button" onClick={() => { setF(s => ({ ...s, equipmentTags: JSON.stringify([...tags, tagSearch.trim()]) })); setTagSearch(''); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-850 cursor-pointer">+ добавить «{tagSearch.trim()}» как текст</button>
              </div>
            )}
          </div>

          {customCols.length > 0 && (
            <>
              <Sect title="Дополнительные колонки" />
              <div className="grid grid-cols-2 gap-2.5">
                {customCols.map(c => (
                  <div key={c.key}>
                    <label className="block text-xs font-bold text-slate-500 uppercase truncate" title={`${c.title}\n${c.titleRu || ''}`}>{c.titleRu || c.title || c.key}</label>
                    <input value={String(f.extra?.[c.key] ?? '')}
                      onChange={e => setF(s => ({ ...s, extra: { ...s.extra, [c.key]: e.target.value } }))}
                      className={inputCls} />
                  </div>
                ))}
              </div>
            </>
          )}

          {!isNew && (
            <>
              <Sect title="История ревизий" />
              {revisions.length === 0 ? <p className="text-xs text-slate-400">Ревизии ещё не выпускались из программы.</p> : (
                <div className="border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-850">
                  {revisions.map(v => (
                    <div key={v.id} className="px-3 py-1.5 flex items-center gap-2 text-xs">
                      <span className="w-7 font-black text-emerald-600">{v.revision}</span>
                      <span className="text-slate-400 w-20">{fmtD(v.date)}</span>
                      <span className="text-slate-500 w-12">{v.reason}</span>
                      <span className="flex-1 truncate text-slate-700 dark:text-slate-300" title={`${v.place}\n${v.description}`}>{[v.place, v.description].filter(Boolean).join(' — ')}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <button type="button" onClick={() => setRevDialog('void')} className="px-2.5 py-1 rounded-lg border border-rose-200 dark:border-rose-900 text-rose-600 text-xs font-bold hover:bg-rose-50 dark:hover:bg-rose-950/30 cursor-pointer">Аннулировать (V)</button>
                <button type="button" onClick={() => setRevDialog('superseded')} className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-500 text-xs font-bold hover:bg-slate-50 dark:hover:bg-slate-850 cursor-pointer">Заменён (S)</button>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 dark:border-slate-800 shrink-0">
          <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-lg text-xs font-semibold text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-850 cursor-pointer">Закрыть</button>
          <button type="button" onClick={save} disabled={busy} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold cursor-pointer">
            {busy ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </div>

        {/* Диалог выпуска ревизии */}
        {revDialog && (
          <div className="absolute inset-0 z-10 bg-black/30 flex items-center justify-center p-6" onClick={() => setRevDialog(null)}>
            <div className="w-full bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xl p-4 space-y-2.5" onClick={e => e.stopPropagation()}>
              <h4 className="font-bold text-sm text-slate-800 dark:text-white">
                {revDialog === 'void' ? 'Аннулировать документ (→V)' : revDialog === 'superseded' ? 'Пометить заменённым (→S)' : `Выпустить ревизию (текущая: ${f.revision})`}
              </h4>
              <input value={revPlace} onChange={e => setRevPlace(e.target.value)} placeholder="Место изменения (разд., лист)" className={inputCls} />
              <textarea value={revDesc} onChange={e => setRevDesc(e.target.value)} rows={2} placeholder="Описание изменения" className={inputCls} />
              <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={() => setRevDialog(null)} className="px-3 py-1.5 rounded-lg text-xs text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-850 cursor-pointer">Отмена</button>
                {revDialog === 'next' && /^[A-Za-zА-Яа-я]$/.test(f.revision) && (
                  <button type="button" onClick={() => { setRevDialog('certify'); setTimeout(issueRevision, 0); }} disabled={busy}
                    className="px-3 py-1.5 rounded-lg border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 text-xs font-bold hover:bg-emerald-50 dark:hover:bg-emerald-950/30 cursor-pointer">Утвердить (→0)</button>
                )}
                <button type="button" onClick={issueRevision} disabled={busy} className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer disabled:opacity-50">Выпустить</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═════════ Настройки реестра: реквизиты, стандарт, свои колонки ═════════
function RegisterSettings({ register, standards, users, onClose, onChanged }: {
  register: Register; standards: Standard[]; users: UserLite[];
  onClose: () => void; onChanged: () => void;
}) {
  const { addToast } = useToastStore();
  const [f, setF] = useState<any>({ ...register });
  const [cols, setCols] = useState<ColumnDef[]>(register.columnsConfig || []);
  const [newCol, setNewCol] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const body: any = { columnsConfig: cols };
      for (const k of ['name', 'vendor', 'contractor', 'owner', 'poNumber', 'ownerProjectNo', 'contractorProjectNo',
        'materialRequisition', 'equipmentTitle', 'contractorDocNo', 'ownerDocNo', 'vendorDocNo',
        'preparedBy', 'checkedBy', 'approvedBy']) body[k] = String(f[k] ?? '');
      // Пустая строка, а не null: сервер принимает только строки, а '' и
      // означает «сотрудник не выбран»
      for (const k of ['preparedById', 'checkedById', 'approvedById']) body[k] = String(f[k] ?? '');
      body.standardId = f.standardId || null;
      body.managerId = f.managerId || null;
      const r = await fetch(`/api/vdr/registers/${register.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { addToast('Ошибка сохранения', 'error'); return; }
      addToast('Реквизиты сохранены', 'success');
      onChanged(); onClose();
    } finally { setBusy(false); }
  };

  const inputCls = 'w-full mt-0.5 px-2.5 py-1.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-white focus:outline-none focus:border-emerald-500';
  const F = ({ label, k }: { label: string; k: string }) => (
    <div>
      <label className="block text-xs font-bold text-slate-500 uppercase">{label}</label>
      <input value={String(f[k] ?? '')} onChange={e => setF((s: any) => ({ ...s, [k]: e.target.value }))} className={inputCls} />
    </div>
  );

  /**
   * Подписант: сотрудник программы и его имя строкой.
   *
   * Имя оставлено полем не для красоты: в реестрах, пришедших от подрядчика,
   * человек указан текстом, и сотрудника с таким именем в программе может не
   * быть. Выбор сотрудника — то, по чему титул документа возьмёт его подпись
   * (§42); без выбора остаётся ровно то, что было, — строка.
   */
  const Signer = ({ label, k, kId }: { label: string; k: string; kId: string }) => {
    const chosen = users.find((u) => u.id === f[kId]);
    return (
      <div>
        <label className="block text-xs font-bold text-slate-500 uppercase">{label}</label>
        <input value={String(f[k] ?? '')} onChange={e => setF((s: any) => ({ ...s, [k]: e.target.value }))}
          placeholder="Фамилия И.О." className={inputCls} />
        <select
          value={String(f[kId] || '')}
          onChange={(e) => {
            const id = e.target.value;
            const u = users.find((x) => x.id === id);
            // Выбрали сотрудника — подставляем и его имя: две разные строки в
            // одном поле («Иванов» в тексте, Петров в выборе) хуже пустого
            setF((s: any) => ({ ...s, [kId]: id || null, ...(u ? { [k]: u.name } : {}) }));
          }}
          className={inputCls + ' cursor-pointer mt-1'}
        >
          <option value="">— сотрудник не выбран, подписи не будет —</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        {chosen && (
          <p className="text-2xs text-slate-400 mt-0.5">
            {(chosen as any).hasSignature
              ? 'Подпись есть — встанет на титул документа'
              : 'Подписи у сотрудника нет: на титуле останется пустое место'}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[88vh] overflow-y-auto bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xl p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-slate-800 dark:text-white">Реквизиты реестра (титульный лист)</h3>
          <button type="button" title="Закрыть реквизиты" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <F label="Название реестра" k="name" />
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase">Стандарт документооборота</label>
            <select value={f.standardId || ''} onChange={e => setF((s: any) => ({ ...s, standardId: e.target.value || null }))} className={inputCls + ' cursor-pointer'}>
              <option value="">— по умолчанию —</option>
              {standards.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <F label="Подрядчик" k="contractor" />
          <F label="Заказчик" k="owner" />
          <F label="№ проекта подрядчика" k="contractorProjectNo" />
          <F label="№ проекта заказчика" k="ownerProjectNo" />
          <F label="Поставщик" k="vendor" />
          <F label="Заказ (PO)" k="poNumber" />
          <F label="Заявка на материалы (MR)" k="materialRequisition" />
          <F label="Название оборудования" k="equipmentTitle" />
          <F label="№ ВДР (подрядчик)" k="contractorDocNo" />
          <F label="№ ВДР (заказчик)" k="ownerDocNo" />
          <F label="№ ВДР (поставщик)" k="vendorDocNo" />
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase">Менеджер (уведомления «готово»)</label>
            <select value={f.managerId || ''} onChange={e => setF((s: any) => ({ ...s, managerId: e.target.value || null }))} className={inputCls + ' cursor-pointer'}>
              <option value="">—</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <Signer label="Разработал" k="preparedBy" kId="preparedById" />
          <Signer label="Проверил" k="checkedBy" kId="checkedById" />
          <Signer label="Утвердил" k="approvedBy" kId="approvedById" />
        </div>

        <div className="pt-2 border-t border-slate-100 dark:border-slate-850">
          <div className="text-xs font-bold uppercase tracking-wide text-emerald-500 mb-1.5">Свои колонки реестра ({cols.filter(c => !c.field).length} доп. / {cols.length} всего)</div>
          <div className="flex flex-wrap gap-1.5 mb-2 max-h-28 overflow-auto">
            {cols.filter(c => !c.field).map(c => (
              <span key={c.key} className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-semibold">
                {c.titleRu || c.title || c.key}
                {c.source === 'custom' && (
                  <button type="button" onClick={() => setCols(cs => cs.filter(x => x.key !== c.key))} className="hover:text-rose-500 cursor-pointer"><X className="w-3 h-3" /></button>
                )}
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={newCol} onChange={e => setNewCol(e.target.value)} placeholder="Новая колонка"
              onKeyDown={e => { if (e.key === 'Enter' && newCol.trim()) { setCols(cs => [...cs, { key: `custom_${Date.now().toString(36)}`, title: newCol.trim(), titleRu: newCol.trim(), source: 'custom' }]); setNewCol(''); } }}
              className={inputCls + ' flex-1'} />
            <button type="button" onClick={() => { if (newCol.trim()) { setCols(cs => [...cs, { key: `custom_${Date.now().toString(36)}`, title: newCol.trim(), titleRu: newCol.trim(), source: 'custom' }]); setNewCol(''); } }}
              className="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer shrink-0">+ Добавить</button>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-lg text-xs font-semibold text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-850 cursor-pointer">Отмена</button>
          <button type="button" onClick={save} disabled={busy} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold cursor-pointer">Сохранить</button>
        </div>
      </div>
    </div>
  );
}
