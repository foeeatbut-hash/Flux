/**
 * Вкладки Каталога помимо семейств: комплектующие, правила тегов, выученное,
 * проверка каталога целиком и обмен каталогом между серверами.
 */
import React, { useMemo, useState } from 'react';
import { Plus, Trash2, Save, Download, Upload, CircleCheck, AlertTriangle } from 'lucide-react';
import type { Catalog, Component, TagRule } from '../../../catalog/model';
import { textOf } from '../../../catalog/model';
import { parseWithFamily, buildDesignation, sameDesignation, paramsOfFormat } from '../../../catalog/designation';
import { catalogService } from '../../services/catalogService';
import { useCatalogStore } from '../../store/catalogStore';
import { useToastStore } from '../../store/toastStore';
import { saveBytes } from '../../lib/saveToWindows';
import { factsToText, textToFacts } from './ParamsEditor';
import { Btn, Chip, Empty, Input, Select, confirmAsk } from './ui';

// ── Комплектующие ───────────────────────────────────────────────────────────

const KINDS: Array<{ value: Component['kind']; label: string }> = [
  { value: 'actuator', label: 'привод' }, { value: 'box', label: 'коробка' }, { value: 'gland', label: 'кабельный ввод' },
  { value: 'heater', label: 'обогрев' }, { value: 'frame', label: 'рама' }, { value: 'other', label: 'прочее' },
];

export function ComponentsPanel({ catalog, classId, canEdit }: { catalog: Catalog; classId: string; canEdit: boolean }) {
  const load = useCatalogStore((s) => s.load);
  const addToast = useToastStore((s) => s.addToast);
  const [edit, setEdit] = useState<Component | null>(null);
  const list = catalog.components.filter((c) => c.classId === classId);
  const save = async () => {
    if (!edit) return;
    try { await catalogService.save('component', edit); await load(true); setEdit(null); addToast('Сохранено', 'success'); } catch (e: any) { addToast(e?.message || 'Не сохранилось', 'error'); }
  };
  return (
    <div className="grid grid-cols-1 @[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
      <div className="flex flex-col gap-1">
        {canEdit && <div><Btn onClick={() => setEdit({ id: `cmp-${Math.random().toString(36).slice(2, 9)}`, classId, kind: 'actuator', code: '', title: { ru: '' }, specs: [] })}><Plus className="w-3 h-3" /> Комплектующее</Btn></div>}
        {list.map((c) => (
          <button key={c.id} type="button" onClick={() => setEdit(c)} className={`text-left rounded-md border px-2 py-1.5 cursor-pointer ${edit?.id === c.id ? 'border-emerald-500' : 'border-slate-200 dark:border-slate-700 hover:border-emerald-400'}`}>
            <div className="flex items-center gap-2"><b className="font-mono text-xs">{c.code}</b><Chip>{KINDS.find((k) => k.value === c.kind)?.label}</Chip><span className="text-2xs text-slate-400">{c.manufacturer}</span></div>
            <div className="text-2xs text-slate-500 dark:text-slate-400">{textOf(c.title)}</div>
          </button>
        ))}
        {!list.length && <Empty title="Комплектующих пока нет" />}
      </div>
      {edit && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 p-2">
          <div className="grid grid-cols-3 gap-1.5">
            <Input value={edit.code} placeholder="Код" onChange={(e) => setEdit({ ...edit, code: e.target.value })} className="font-mono" disabled={!canEdit} />
            <Select value={edit.kind} onChange={(v) => setEdit({ ...edit, kind: v as any })} options={KINDS} disabled={!canEdit} />
            <Input value={edit.manufacturer || ''} placeholder="Изготовитель" onChange={(e) => setEdit({ ...edit, manufacturer: e.target.value })} disabled={!canEdit} />
          </div>
          <Input value={edit.title.ru} placeholder="Название" onChange={(e) => setEdit({ ...edit, title: { ...edit.title, ru: e.target.value } })} disabled={!canEdit} />
          <Input value={factsToText(edit.facts)} placeholder="Признаки: voltage=24; ex=true" onChange={(e) => setEdit({ ...edit, facts: textToFacts(e.target.value) })} className="font-mono" disabled={!canEdit} />
          <div className="text-2xs font-bold text-slate-400 mt-1">Характеристики</div>
          {(edit.specs || []).map((s, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_60px_auto] gap-1">
              <Input value={s.label.ru} onChange={(e) => setEdit({ ...edit, specs: edit.specs!.map((x, j) => (j === i ? { ...x, label: { ...x.label, ru: e.target.value } } : x)) })} disabled={!canEdit} />
              <Input value={s.value} onChange={(e) => setEdit({ ...edit, specs: edit.specs!.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} disabled={!canEdit} />
              <Input value={s.unit || ''} onChange={(e) => setEdit({ ...edit, specs: edit.specs!.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)) })} disabled={!canEdit} />
              {canEdit && <Btn tone="ghost" onClick={() => setEdit({ ...edit, specs: edit.specs!.filter((_, j) => j !== i) })} aria-label="Удалить"><Trash2 className="w-3 h-3" /></Btn>}
            </div>
          ))}
          {canEdit && (
            <div className="flex gap-1.5 flex-wrap">
              <Btn onClick={() => setEdit({ ...edit, specs: [...(edit.specs || []), { label: { ru: '' }, value: '' }] })}><Plus className="w-3 h-3" /> Характеристика</Btn>
              <span className="flex-1" />
              <Btn tone="danger" onClick={async () => { if (await confirmAsk('Удалить комплектующее?', edit.code, { confirmLabel: 'Удалить', tone: 'danger' })) { await catalogService.remove('component', edit.id).catch(() => undefined); await load(true); setEdit(null); } }}><Trash2 className="w-3 h-3" /></Btn>
              <Btn tone="primary" onClick={save}><Save className="w-3.5 h-3.5" /> Сохранить</Btn>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Правила тегов ───────────────────────────────────────────────────────────

export function TagRulesPanel({ catalog, classId, canEdit }: { catalog: Catalog; classId: string; canEdit: boolean }) {
  const load = useCatalogStore((s) => s.load);
  const addToast = useToastStore((s) => s.addToast);
  const [rows, setRows] = useState<TagRule[]>(catalog.tagRules.filter((r) => r.classId === classId));
  const dirty = JSON.stringify(rows) !== JSON.stringify(catalog.tagRules.filter((r) => r.classId === classId));
  const save = async () => {
    try {
      const before = catalog.tagRules.filter((r) => r.classId === classId);
      for (const r of rows) if (JSON.stringify(r) !== JSON.stringify(before.find((x) => x.id === r.id))) await catalogService.save('tagRule', r);
      for (const r of before) if (!rows.some((x) => x.id === r.id)) await catalogService.remove('tagRule', r.id);
      await load(true);
      addToast('Правила тегов сохранены', 'success');
    } catch (e: any) { addToast(e?.message || 'Не сохранилось', 'error'); }
  };
  const set = (i: number, r: TagRule) => setRows(rows.map((x, j) => (j === i ? r : x)));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-2xs text-slate-400">Код типа — буквы перед номером в теге: 3700-B01-<b>DF</b>-001. Правило говорит, что это за изделие (признаки для подбора), как получить тег привода (DF → DFD) и не пропустить ли строку при импорте (решётки DA — не клапаны).</div>
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
              <td className="p-1">{canEdit && <Btn tone="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Удалить"><Trash2 className="w-3 h-3" /></Btn>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {canEdit && (
        <div className="flex gap-1.5">
          <Btn onClick={() => setRows([...rows, { id: `tr-${Math.random().toString(36).slice(2, 9)}`, classId, code: '', label: { ru: '' }, facts: {} }])}><Plus className="w-3 h-3" /> Правило</Btn>
          <Btn tone="primary" onClick={save} disabled={!dirty}><Save className="w-3.5 h-3.5" /> Сохранить</Btn>
        </div>
      )}
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
        <Chip tone={bad.length ? 'amber' : 'emerald'}>{bad.length ? `замечаний у ${bad.length} семейств` : 'замечаний нет'}</Chip>
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
      setFile(data);
      setPlan((await catalogService.importCatalog(data, 'plan')).plan);
    } catch (e: any) { addToast(e?.message || 'Файл не читается', 'error'); }
  };
  return (
    <div className="flex flex-col gap-2 max-w-3xl">
      <div className="text-xs text-slate-500 dark:text-slate-400">Каталог живёт на сервере программы. Чтобы перенести его на другой сервер (или поделиться выверенными семействами), выгрузите файл и загрузите его там. Перед записью покажется, что добавится и что изменится; изменённое сохраняется снимком и откатывается.</div>
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
            <Btn tone="primary" onClick={async () => { try { await catalogService.importCatalog(file!, 'apply'); await load(true); setPlan(null); addToast('Каталог загружен', 'success'); } catch (e: any) { addToast(e?.message || 'Не записалось', 'error'); } }}>Записать</Btn>
            <Btn tone="ghost" onClick={() => setPlan(null)}>Отмена</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
