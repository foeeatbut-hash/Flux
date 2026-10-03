/**
 * Вкладки Каталога помимо моделей: комплектующие, правила тегов, выученное,
 * проверка каталога целиком и обмен каталогом между серверами.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Save, Download, Upload, CircleCheck, AlertTriangle } from 'lucide-react';
import type { Catalog, TagRule } from '../../../catalog/model';
import { textOf } from '../../../catalog/model';
import { parseWithFamily, buildDesignation, sameDesignation, paramsOfFormat } from '../../../catalog/designation';
import { catalogService } from '../../services/catalogService';
import { useCatalogStore } from '../../store/catalogStore';
import { useToastStore } from '../../store/toastStore';
import { saveBytes } from '../../lib/saveToWindows';
import { factsToText, textToFacts } from './ParamsEditor';
import { Btn, Chip, Empty, Input, Select, confirmAsk } from './ui';

// Сохранённый путь импорта оставлен для потребителей панели.
export { ComponentsPanel } from './ComponentsPanel';

// ── Правила тегов ───────────────────────────────────────────────────────────

type VersionedTagRule = TagRule & { _draftVersion?: string; _publishedHash?: string };
const ruleContent = (rule: VersionedTagRule) => {
  const { _draftVersion: _version, _publishedHash: _hash, ...content } = rule;
  return content;
};

export function TagRulesPanel({ catalog, classId, canEdit }: { catalog: Catalog; classId: string; canEdit: boolean }) {
  const addToast = useToastStore((s) => s.addToast);
  const initialRows = catalog.tagRules.filter((r) => r.classId === classId) as VersionedTagRule[];
  const initialFingerprint = JSON.stringify([classId, initialRows]);
  const [rows, setRows] = useState<VersionedTagRule[]>(initialRows);
  const [savedRows, setSavedRows] = useState<VersionedTagRule[]>(initialRows);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const lastObservedProps = useRef(initialFingerprint);
  const lastAppliedProps = useRef(initialFingerprint);
  const ownSaveBlockedProps = useRef<string | null>(null);
  const dirty = JSON.stringify(rows.map(ruleContent)) !== JSON.stringify(savedRows.map(ruleContent));
  const incoming = catalog.tagRules.filter((r) => r.classId === classId) as VersionedTagRule[];
  const incomingFingerprint = JSON.stringify([classId, incoming]);
  useEffect(() => {
    if (incomingFingerprint !== lastObservedProps.current) lastObservedProps.current = incomingFingerprint;
    if (incomingFingerprint === ownSaveBlockedProps.current) return;
    if (!dirty && incomingFingerprint !== lastAppliedProps.current) {
      setRows(incoming);
      setSavedRows(incoming);
      lastAppliedProps.current = incomingFingerprint;
      setSaveError('');
      return;
    }
    if (!dirty) return;
    const changedRemotely = savedRows.some((row) => {
      const fresh = incoming.find((item) => item.id === row.id);
      return fresh && ((fresh._draftVersion && fresh._draftVersion !== row._draftVersion) || (fresh._publishedHash && fresh._publishedHash !== row._publishedHash));
    });
    if (changedRemotely) setSaveError('Черновик изменён другим сотрудником. Ваши значения сохранены; сверите изменения перед повторным сохранением.');
  }, [incomingFingerprint, dirty]);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      setSaveError('');
      for (const row of rows) {
        const before = savedRows.find((item) => item.id === row.id);
        if (before && JSON.stringify(ruleContent(row)) === JSON.stringify(ruleContent(before))) continue;
        const result = await catalogService.save('tagRule', row);
        const committed = { ...row, _draftVersion: result.revision };
        delete committed._publishedHash;
        ownSaveBlockedProps.current = incomingFingerprint;
        lastAppliedProps.current = incomingFingerprint;
        setRows((current) => current.map((item) => item.id === row.id ? { ...item, _draftVersion: result.revision, _publishedHash: undefined } : item));
        setSavedRows((current) => current.some((item) => item.id === row.id)
          ? current.map((item) => item.id === row.id ? committed : item)
          : [...current, committed]);
      }
      for (const before of savedRows) {
        if (rows.some((item) => item.id === before.id)) continue;
        await catalogService.remove('tagRule', before.id, before._draftVersion);
        ownSaveBlockedProps.current = incomingFingerprint;
        lastAppliedProps.current = incomingFingerprint;
        setSavedRows((current) => current.filter((item) => item.id !== before.id));
      }
      addToast('Правила тегов сохранены', 'success');
    } catch (e: any) { setSaveError(e?.message || 'Не сохранилось'); addToast(e?.message || 'Не сохранилось', 'error'); }
    finally { setSaving(false); }
  };
  const set = (i: number, r: VersionedTagRule) => setRows((current) => current.map((x, j) => (j === i ? r : x)));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-2xs text-slate-400">Код типа — буквы перед номером в теге: 3700-B01-<b>DF</b>-001. Правило связывает код с видом изделия, признаками для подбора и тегом связанного привода. Неиспользуемые строки можно пропускать при импорте.</div>
      <table className="w-full text-xs">
        <thead><tr className="text-left text-2xs text-slate-400"><th className="p-1">Код</th><th className="p-1">Что это</th><th className="p-1">Признаки</th><th className="p-1">Тег привода</th><th className="p-1">Пропускать</th><th /></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className="border-t border-slate-100 dark:border-slate-850">
              <td className="p-1 w-20"><Input value={r.code} onChange={(e) => set(i, { ...r, code: e.target.value.toUpperCase() })} className="font-mono" disabled={!canEdit} /></td>
              <td className="p-1"><Input value={r.label.ru} onChange={(e) => set(i, { ...r, label: { ...r.label, ru: e.target.value } })} disabled={!canEdit} /></td>
              <td className="p-1"><Input value={factsToText(r.facts)} onChange={(e) => set(i, { ...r, facts: textToFacts(e.target.value) })} className="font-mono" disabled={!canEdit} /></td>
              <td className="p-1 w-24"><Input value={r.actuatorCode || ''} onChange={(e) => set(i, { ...r, actuatorCode: e.target.value.toUpperCase() || undefined })} className="font-mono" disabled={!canEdit} /></td>
              <td className="p-1 text-center"><input type="checkbox" checked={!!r.skip} onChange={(e) => set(i, { ...r, skip: e.target.checked })} disabled={!canEdit} /></td>
              <td className="p-1">{canEdit && <Btn tone="ghost" onClick={() => setRows((current) => current.filter((_, j) => j !== i))} aria-label="Удалить"><Trash2 className="w-3 h-3" /></Btn>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {canEdit && (
        <div className="flex gap-1.5">
          <Btn onClick={() => setRows((current) => [...current, { id: `tr-${Math.random().toString(36).slice(2, 9)}`, classId, code: '', label: { ru: '' }, facts: {} }])}><Plus className="w-3 h-3" /> Правило</Btn>
          <Btn tone="primary" onClick={save} disabled={!dirty || saving}><Save className="w-3.5 h-3.5" /> {saving ? 'Сохраняем…' : 'Сохранить'}</Btn>
        </div>
      )}
      {saveError && <div role="alert" className="text-xs text-rose-600 dark:text-rose-400">{saveError}</div>}
    </div>
  );
}

// ── Выученное ───────────────────────────────────────────────────────────────

export function LearnedPanel({ catalog }: { catalog: Catalog }) {
  const learned = useCatalogStore((s) => s.learned);
  const loadLearned = useCatalogStore((s) => s.loadLearned);
  const [q, setQ] = useState('');
  const shown = learned.filter((l) => !q || l.signature.includes(q.toLowerCase()));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-2xs text-slate-400">Когда инженер выбирает не то, что предложил подбор, выбор запоминается по «подписи» описания (цифры замаскированы). В следующий раз такое же описание подбирается сразу так. Неверное выученное можно забыть.</div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по описанию" />
      {!shown.length && <Empty title="Пока ничего не выучено" />}
      {shown.slice(0, 300).map((l) => (
        <div key={l.id} className="rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1 text-xs flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-2xs text-slate-500 dark:text-slate-400 line-clamp-2">{l.signature}</div>
            <div><b className="font-mono">{catalog.families.find((f) => f.id === l.familyId)?.code || l.familyId}</b> <span className="text-2xs text-slate-400">{factsToText(l.values as any)}</span></div>
          </div>
          <Chip>{l.count || 1}×</Chip>
          <Btn tone="ghost" onClick={async () => { await catalogService.forget(l.id); loadLearned(); }} aria-label="Забыть"><Trash2 className="w-3 h-3" /></Btn>
        </div>
      ))}
    </div>
  );
}

// ── Проверка каталога ───────────────────────────────────────────────────────

export function CheckPanel({ catalog, classId, onOpen }: { catalog: Catalog; classId: string; onOpen: (familyId: string) => void }) {
  const report = useMemo(() => catalog.families.filter((f) => f.classId === classId).map((f) => {
    const problems: string[] = [];
    const keys = new Set(f.params.map((p) => p.key));
    for (const pos of f.positions) for (const fmt of pos.formats) for (const k of paramsOfFormat(fmt)) if (!keys.has(k)) problems.push(`позиция «${pos.key}» ссылается на несуществующий параметр ${k}`);
    for (const r of f.rules) {
      const t = r.then as any;
      const p = t.allow?.param || t.forbid?.param || t.require?.param;
      if (p && !keys.has(p)) problems.push(`правило «${r.message}» про несуществующий параметр ${p}`);
      const vals: string[] = t.allow?.values || t.forbid?.values || [];
      const known = new Set(f.params.find((x) => x.key === p)?.values?.map((v) => v.code) || []);
      const odd = vals.filter((v) => p && known.size && !known.has(v));
      if (odd.length) problems.push(`правило «${r.message}»: нет кодов ${odd.join(', ')}`);
    }
    for (const ex of f.examples || []) {
      const r = parseWithFamily(f, ex);
      if (!r.complete) problems.push(`эталон «${ex}» не разбирается (встал на «${r.stuckAt}»)`);
      else if (!sameDesignation(buildDesignation(f, r.values).text, ex)) problems.push(`эталон «${ex}» собирается иначе`);
    }
    if (!(f.examples || []).length) problems.push('нет ни одного эталонного обозначения');
    return { f, problems, todo: f.todo || [] };
  }), [catalog, classId]);
  const bad = report.filter((r) => r.problems.length);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2 flex-wrap">
        <Chip tone={bad.length ? 'amber' : 'emerald'}>{bad.length ? `замечаний у ${bad.length} моделей` : 'замечаний нет'}</Chip>
        <Chip tone="amber">сверить со страницей: {report.filter((r) => r.f.status !== 'full').length}</Chip>
      </div>
      {report.map(({ f, problems, todo }) => (
        <button key={f.id} type="button" onClick={() => onOpen(f.id)} className="text-left rounded-md border border-slate-200 dark:border-slate-700 hover:border-emerald-400 px-2 py-1.5 cursor-pointer">
          <div className="flex items-center gap-2">
            {problems.length ? <AlertTriangle className="w-3.5 h-3.5 text-amber-500" /> : <CircleCheck className="w-3.5 h-3.5 text-emerald-600" />}
            <b className="font-mono text-xs">{f.code}</b>
            <span className="text-2xs text-slate-400">{f.examples?.length || 0} эталон.</span>
          </div>
          {problems.map((p, i) => <div key={i} className="text-2xs text-amber-700 dark:text-amber-400">{p}</div>)}
          {todo.map((p, i) => <div key={`t${i}`} className="text-2xs text-slate-500 dark:text-slate-400">сверить: {p}</div>)}
        </button>
      ))}
    </div>
  );
}

// ── Обмен ───────────────────────────────────────────────────────────────────

export function ExchangePanel({ canEdit }: { canEdit: boolean }) {
  const load = useCatalogStore((s) => s.load);
  const addToast = useToastStore((s) => s.addToast);
  const [file, setFile] = useState<Record<string, unknown> | null>(null);
  const [plan, setPlan] = useState<Array<{ entity: string; code: string; action: string }> | null>(null);
  const exportAll = async () => {
    const data = await catalogService.exportCatalog();
    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 1));
    const r = await saveBytes(`Каталог Flux ${new Date().toISOString().slice(0, 10)}.json`, bytes);
    if (r.ok) addToast('Каталог выгружен', 'success');
  };
  const pick = async (f: File) => {
    try {
      const data = JSON.parse(await f.text());
      const preview = await catalogService.importCatalog(data, 'plan');
      setFile({ ...data, preview: preview.preview });
      setPlan(preview.plan);
    } catch (e: any) { addToast(e?.message || 'Файл не читается', 'error'); }
  };
  return (
    <div className="flex flex-col gap-2 max-w-3xl">
      <div className="text-xs text-slate-500 dark:text-slate-400">Каталог хранится в общей БД компании. Загрузите пакет и проверьте разницу перед сохранением черновиков. Опубликованные данные сотрудников изменятся только после публикации.</div>
      <div className="flex gap-2 flex-wrap">
        <Btn onClick={exportAll}><Download className="w-3.5 h-3.5" /> Выгрузить каталог</Btn>
        {canEdit && (
          <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-xs font-semibold cursor-pointer hover:border-emerald-400">
            <Upload className="w-3.5 h-3.5" /> Загрузить файл каталога
            <input type="file" accept=".json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ''; }} />
          </label>
        )}
      </div>
      {plan && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-2 flex flex-col gap-1">
          <div className="flex gap-1.5 flex-wrap">
            <Chip tone="emerald">новых {plan.filter((p) => p.action === 'new').length}</Chip>
            <Chip tone="sky">изменится {plan.filter((p) => p.action === 'update').length}</Chip>
            <Chip>без изменений {plan.filter((p) => p.action === 'same').length}</Chip>
          </div>
          <div className="max-h-60 overflow-auto text-2xs">
            {plan.filter((p) => p.action !== 'same').map((p, i) => <div key={i}><Chip tone={p.action === 'new' ? 'emerald' : 'sky'}>{p.action === 'new' ? 'новое' : 'изменится'}</Chip> {p.entity}: <span className="font-mono">{p.code}</span></div>)}
          </div>
          <div className="flex gap-2">
            <Btn tone="primary" onClick={async () => { try { await catalogService.importCatalog(file!, 'apply'); await load(true); setPlan(null); addToast('Черновики каталога сохранены. Проверьте и опубликуйте их', 'success'); } catch (e: any) { addToast(e?.message || 'Не записалось', 'error'); } }}>Сохранить черновики</Btn>
            <Btn tone="ghost" onClick={() => setPlan(null)}>Отмена</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
