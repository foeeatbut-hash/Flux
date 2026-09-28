import React from 'react';
import SectionShell from './SectionShell';
import { Trash2, X } from 'lucide-react';
import { useModalStore } from '../../store/modalStore';

// Диалоги программы вместо системных окон Windows
const { openConfirm, openPrompt } = useModalStore.getState();

// ── Документооборот: глобальные стандарты ВДР ──
// Хранятся в программе один раз, применяются к реестрам любых проектов
// (выбор — в реквизитах реестра). Здесь правятся коды рассмотрения со сроками,
// причины выпуска, спец-ревизии и каталог типов документов.
export default function DocflowSection({ isAdmin, addToast }: any) {
  const [standards, setStandards] = React.useState<any[]>([]);
  const [selId, setSelId] = React.useState('');
  const [cfg, setCfg] = React.useState<any>(null);
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const load = async () => {
    try {
      const r = await fetch('/api/vdr/standards');
      if (!r.ok) return;
      const list = (await r.json()).standards || [];
      setStandards(list);
      const sel = list.find((s: any) => s.id === selId) || list[0];
      if (sel) { setSelId(sel.id); setCfg(JSON.parse(JSON.stringify(sel.config || {}))); setName(sel.name); }
    } catch (_) {}
  };
  React.useEffect(() => { load(); }, []);

  const pick = (id: string) => {
    const s = standards.find((x: any) => x.id === id);
    if (s) { setSelId(id); setCfg(JSON.parse(JSON.stringify(s.config || {}))); setName(s.name); }
  };

  const save = async () => {
    if (!selId) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/vdr/standards/${selId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, config: cfg }),
      });
      if (r.ok) { addToast('Стандарт сохранён', 'success'); load(); }
      else addToast('Ошибка сохранения', 'error');
    } finally { setBusy(false); }
  };

  const createStd = async () => {
    const n = await openPrompt('Новый стандарт документооборота', 'Название — обычно имя заказчика.', 'Например: Заказчик «Азот»', 'Новый стандарт');
    if (!n) return;
    const r = await fetch('/api/vdr/standards', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: n, config: cfg || undefined }),
    });
    if (r.ok) { const d = await r.json(); await load(); pick(d.standard.id); addToast('Стандарт создан (копия текущего)', 'success'); }
  };

  const removeStd = async () => {
    if (!selId) return;
    if (!await openConfirm(`Удалить стандарт «${name}»?`, 'Реестры, которые им пользуются, перейдут на стандарт по умолчанию.', { confirmLabel: 'Удалить стандарт', tone: 'danger' })) return;
    const r = await fetch(`/api/vdr/standards/${selId}`, { method: 'DELETE' });
    if (r.ok) { setSelId(''); load(); } else addToast('Удалять может администратор', 'error');
  };

  const upd = (path: string, idx: number, key: string, val: any) => {
    setCfg((c: any) => {
      const next = { ...c, [path]: [...(c[path] || [])] };
      next[path][idx] = { ...next[path][idx], [key]: val };
      return next;
    });
  };
  const addRow = (path: string, row: any) => setCfg((c: any) => ({ ...c, [path]: [...(c[path] || []), row] }));
  const delRow = (path: string, idx: number) => setCfg((c: any) => ({ ...c, [path]: (c[path] || []).filter((_: any, i: number) => i !== idx) }));

  const inp = 'px-2 py-1 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-white focus:outline-none focus:border-emerald-500';

  if (!cfg) return <SectionShell title="Документооборот" desc="Стандарты ВДР."><div className="text-sm text-slate-400">Загрузка…</div></SectionShell>;

  return (
    <SectionShell title="Документооборот" desc="Глобальные стандарты ВДР: применяются к реестрам любых проектов (выбор — в реквизитах реестра).">
      <div className="space-y-4 max-w-3xl">
        <div className="flex items-center gap-2">
          <select value={selId} onChange={e => pick(e.target.value)} className={inp + ' cursor-pointer font-semibold'}>
            {standards.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input value={name} onChange={e => setName(e.target.value)} className={inp + ' flex-1'} placeholder="Название стандарта" />
          <button type="button" onClick={createStd} className="fx-btn">+ Новый</button>
          {isAdmin && <button type="button" title="Удалить стандарт" onClick={removeStd} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>}
        </div>

        {/* Коды рассмотрения */}
        <div>
          <div className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">Коды рассмотрения заказчика (действие и срок новой ревизии)</div>
          <div className="space-y-1">
            {(cfg.reviewCodes || []).map((c: any, i: number) => (
              <div key={i} className="flex items-center gap-1.5">
                <input value={c.code} onChange={e => upd('reviewCodes', i, 'code', e.target.value)} className={inp + ' w-12 text-center font-semibold'} />
                <input value={c.label} onChange={e => upd('reviewCodes', i, 'label', e.target.value)} className={inp + ' flex-1'} />
                <select value={c.action} onChange={e => upd('reviewCodes', i, 'action', e.target.value)} className={inp + ' cursor-pointer'}>
                  <option value="accept">принят</option>
                  <option value="revise">замечания</option>
                </select>
                <input type="number" value={c.deadlineDays ?? ''} onChange={e => upd('reviewCodes', i, 'deadlineDays', Number(e.target.value) || 0)} className={inp + ' w-16 text-center'} title="Срок новой ревизии, дней" />
                <span className="text-2xs text-slate-400">дн.</span>
                <button type="button" onClick={() => delRow('reviewCodes', i)} className="p-1 text-slate-300 hover:text-rose-500 cursor-pointer"><X className="w-3 h-3" /></button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => addRow('reviewCodes', { code: '', label: '', action: 'revise', deadlineDays: 7 })} className="fx-btn fx-btn-quiet mt-1.5">+ код</button>
        </div>

        {/* Причины выпуска */}
        <div>
          <div className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">Причины выпуска (буквенные/цифровые ревизии)</div>
          <div className="space-y-1">
            {(cfg.reasons || []).map((r: any, i: number) => (
              <div key={i} className="flex items-center gap-1.5">
                <input value={r.code} onChange={e => upd('reasons', i, 'code', e.target.value)} className={inp + ' w-16 text-center font-semibold'} />
                <input value={r.label} onChange={e => upd('reasons', i, 'label', e.target.value)} className={inp + ' flex-1'} />
                <select value={r.revKind} onChange={e => upd('reasons', i, 'revKind', e.target.value)} className={inp + ' cursor-pointer'}>
                  <option value="letter">A, B, C…</option>
                  <option value="digit">0, 1, 2…</option>
                </select>
                <button type="button" onClick={() => delRow('reasons', i)} className="p-1 text-slate-300 hover:text-rose-500 cursor-pointer"><X className="w-3 h-3" /></button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => addRow('reasons', { code: '', label: '', revKind: 'letter' })} className="fx-btn fx-btn-quiet mt-1.5">+ причина</button>
        </div>

        {/* Маски и спец-ревизии */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Маска имени файла</div>
            <input value={cfg.fileNameMask || ''} onChange={e => setCfg((c: any) => ({ ...c, fileNameMask: e.target.value }))} className={inp + ' w-full'} placeholder="{docNo}_{rev}_{lang}" />
          </div>
          <div>
            <div className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Маска номера документа</div>
            <input value={cfg.docNumberMask || ''} onChange={e => setCfg((c: any) => ({ ...c, docNumberMask: e.target.value }))} className={inp + ' w-full'} placeholder="{contract}-{wbs}-{po}-{type}-{seq}" />
          </div>
          <div>
            <div className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Ревизия «аннулирован»</div>
            <input value={cfg.specialRevisions?.void || 'V'} onChange={e => setCfg((c: any) => ({ ...c, specialRevisions: { ...c.specialRevisions, void: e.target.value } }))} className={inp + ' w-16 text-center font-semibold'} />
          </div>
          <div>
            <div className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Ревизия «заменён»</div>
            <input value={cfg.specialRevisions?.superseded || 'S'} onChange={e => setCfg((c: any) => ({ ...c, specialRevisions: { ...c.specialRevisions, superseded: e.target.value } }))} className={inp + ' w-16 text-center font-semibold'} />
          </div>
        </div>

        {/* Каталог типов */}
        <div>
          <div className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">Каталог типов документов (VDR-коды)</div>
          <div className="space-y-1 max-h-56 overflow-auto pr-1">
            {(cfg.vdrTypes || []).map((t: any, i: number) => (
              <div key={i} className="flex items-center gap-1.5">
                <input value={t.code} onChange={e => upd('vdrTypes', i, 'code', e.target.value)} className={inp + ' w-16 text-center font-semibold'} />
                <input value={t.titleEn} onChange={e => upd('vdrTypes', i, 'titleEn', e.target.value)} className={inp + ' flex-1'} placeholder="English title" />
                <input value={t.titleRu} onChange={e => upd('vdrTypes', i, 'titleRu', e.target.value)} className={inp + ' flex-1'} placeholder="Название" />
                <button type="button" onClick={() => delRow('vdrTypes', i)} className="p-1 text-slate-300 hover:text-rose-500 cursor-pointer"><X className="w-3 h-3" /></button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => addRow('vdrTypes', { code: '', titleEn: '', titleRu: '' })} className="fx-btn fx-btn-quiet mt-1.5">+ тип</button>
        </div>

        <button type="button" onClick={save} disabled={busy} className="fx-btn fx-btn-primary">
          {busy ? 'Сохраняю…' : 'Сохранить стандарт'}
        </button>
      </div>
    </SectionShell>
  );
}
