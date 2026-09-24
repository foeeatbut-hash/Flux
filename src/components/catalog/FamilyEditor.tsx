/**
 * Карточка семейства в Каталоге: обзор, обозначение, параметры, правила,
 * характеристики для бланка, профиль подбора, проба, история, JSON.
 *
 * Правка идёт в черновик; «Сохранить» пишет семейство целиком и оставляет
 * снимок прежнего — откатить можно любую правку из «Истории».
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Save, Undo2, Copy, Trash2, RotateCcw, CircleCheck, AlertTriangle, History, FileText, Plus } from 'lucide-react';
import type { Catalog, Family, Rule, SpecDefault } from '../../../catalog/model';
import { textOf } from '../../../catalog/model';
import { parseWithFamily, buildDesignation, sameDesignation } from '../../../catalog/designation';
import { describe } from '../../../catalog/describe';
import { matchDescription } from '../../../catalog/match';
import { detectorsFor } from '../../../catalog/seed';
import { catalogService } from '../../services/catalogService';
import { useCatalogStore } from '../../store/catalogStore';
import { useToastStore } from '../../store/toastStore';
import Configurator from './Configurator';
import { ParamsEditor, PositionsEditor, MatchEditor } from './ParamsEditor';
import { Area, Btn, Chip, Field, Input, Select, SectionTitle, StatusChip, confirmAsk, promptAsk } from './ui';

type Tab = 'info' | 'positions' | 'params' | 'rules' | 'specs' | 'match' | 'try' | 'history' | 'json';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'info', label: 'Обзор' }, { id: 'positions', label: 'Обозначение' }, { id: 'params', label: 'Параметры' },
  { id: 'rules', label: 'Правила' }, { id: 'specs', label: 'Характеристики' }, { id: 'match', label: 'Подбор' },
  { id: 'try', label: 'Попробовать' }, { id: 'history', label: 'История' }, { id: 'json', label: 'JSON' },
];

function JsonField<T>({ value, onChange, readOnly, rows = 3 }: { value: T; onChange: (v: T) => void; readOnly?: boolean; rows?: number }) {
  const [text, setText] = useState(JSON.stringify(value ?? null));
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(JSON.stringify(value ?? null)); setBad(false); }, [value]);
  return (
    <div className="flex flex-col gap-0.5">
      <Area rows={rows} value={text} disabled={readOnly} className={`font-mono ${bad ? '!border-rose-400' : ''}`}
        onChange={(e) => { setText(e.target.value); try { const v = e.target.value.trim() ? JSON.parse(e.target.value) : undefined; setBad(false); onChange(v); } catch { setBad(true); } }} />
      {bad && <span className="text-2xs text-rose-600 dark:text-rose-400">Не JSON — правка не применена</span>}
    </div>
  );
}

export default function FamilyEditor({ catalog, family, canEdit, edited, onSaved, onDeleted }: {
  catalog: Catalog; family: Family; canEdit: boolean; edited?: boolean; onSaved: (f: Family) => void; onDeleted: () => void;
}) {
  const addToast = useToastStore((s) => s.addToast);
  const load = useCatalogStore((s) => s.load);
  const [tab, setTab] = useState<Tab>('info');
  const [draft, setDraft] = useState<Family>(family);
  const [tryValues, setTryValues] = useState<Record<string, string | number>>({});
  const [probe, setProbe] = useState('');
  const [revs, setRevs] = useState<Array<{ id: string; action: string; createdAt: string }>>([]);
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState('');
  useEffect(() => { setDraft(family); setTryValues({}); }, [family]);
  useEffect(() => { if (tab === 'json') { setJsonText(JSON.stringify(draft, null, 2)); setJsonErr(''); } }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== JSON.stringify(family);
  const ro = !canEdit;
  const cls = catalog.classes.find((c) => c.id === draft.classId);

  const roundTrip = useMemo(() => (draft.examples || []).map((ex) => {
    const r = parseWithFamily(draft, ex);
    const back = r.complete ? buildDesignation(draft, r.values).text : '';
    return { ex, ok: r.complete && sameDesignation(back, ex), stuck: r.stuckAt, back };
  }), [draft]);

  const save = async () => {
    try {
      await catalogService.save('family', draft);
      await load(true);
      onSaved(draft);
      addToast(`${draft.code} сохранено`, 'success');
    } catch (e: any) { addToast(e?.message || 'Не сохранилось', 'error'); }
  };
  const duplicate = async () => {
    const code = await promptAsk('Копия семейства', 'Код нового семейства', `${draft.code}-КОПИЯ`);
    if (!code) return;
    const copy: Family = { ...JSON.parse(JSON.stringify(draft)), id: `fam-${Math.random().toString(36).slice(2, 10)}`, code, status: 'draft', examples: [] };
    copy.positions = copy.positions.map((p, i) => (i === 0 ? { ...p, formats: [code] } : p));
    try { await catalogService.save('family', copy); await load(true); onSaved(copy); addToast('Копия создана', 'success'); } catch (e: any) { addToast(e?.message || 'Не создалось', 'error'); }
  };
  const remove = async () => {
    if (!(await confirmAsk(`Убрать ${draft.code} из Каталога?`, 'Семейство скроется из подбора. Позиции ведомостей, где оно уже выбрано, сохранятся; вернуть можно из истории.', { confirmLabel: 'Убрать', tone: 'danger' }))) return;
    try { await catalogService.remove('family', draft.id); await load(true); onDeleted(); } catch (e: any) { addToast(e?.message || 'Не удалилось', 'error'); }
  };
  const openHistory = async () => {
    setTab('history');
    try { setRevs((await catalogService.revisions('family', draft.id)).revisions); } catch { setRevs([]); }
  };

  const setRule = (i: number, r: Rule) => setDraft({ ...draft, rules: draft.rules.map((x, j) => (j === i ? r : x)) });
  const setSpec = (i: number, s: SpecDefault) => setDraft({ ...draft, specs: draft.specs.map((x, j) => (j === i ? s : x)) });
  const probeResult = useMemo(() => {
    if (!probe.trim()) return null;
    const d = describe(probe, detectorsFor(cls?.code || 'valve'));
    const list = matchDescription({ ...catalog, families: catalog.families.map((f) => (f.id === draft.id ? draft : f)) }, d, { classId: draft.classId, limit: 20 });
    const mine = list.findIndex((c) => c.familyId === draft.id);
    return { list: list.slice(0, 5), mine: mine >= 0 ? list[mine] : null, place: mine + 1 };
  }, [probe, draft, catalog, cls]);

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center gap-2 flex-wrap pb-2">
        <b className="text-base font-mono">{draft.code}</b>
        <StatusChip status={draft.status} />
        {edited ? <Chip tone="sky" title="Правлено в этой программе: обновление затравки его не перезапишет">правлено</Chip> : <Chip title="Из затравки программы">из затравки</Chip>}
        <span className="text-xs text-slate-500 dark:text-slate-400 truncate min-w-0 flex-1">{textOf(draft.title)}</span>
        {canEdit && (<>
          <Btn tone="primary" onClick={save} disabled={!dirty}><Save className="w-3.5 h-3.5" /> Сохранить</Btn>
          <Btn tone="ghost" onClick={() => setDraft(family)} disabled={!dirty}><Undo2 className="w-3.5 h-3.5" /></Btn>
          <Btn tone="ghost" onClick={duplicate} title="Копия семейства"><Copy className="w-3.5 h-3.5" /></Btn>
          <Btn tone="ghost" onClick={remove} title="Убрать из Каталога"><Trash2 className="w-3.5 h-3.5" /></Btn>
        </>)}
      </div>
      <div className="flex gap-1 border-b border-slate-100 dark:border-slate-800 overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => (t.id === 'history' ? openHistory() : setTab(t.id))} aria-pressed={tab === t.id}
            className={`px-2.5 py-1.5 text-xs font-semibold border-b-2 -mb-px whitespace-nowrap cursor-pointer ${tab === t.id ? 'border-emerald-600 text-emerald-700 dark:text-emerald-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-emerald-700'}`}>
            {t.label}{t.id === 'rules' ? ` ${draft.rules.length}` : t.id === 'params' ? ` ${draft.params.length}` : ''}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto pt-2 pr-1 @container">
        {tab === 'info' && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-1 @[700px]:grid-cols-3 gap-2">
              <Field label="Код (начало обозначения)"><Input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} className="font-mono" disabled={ro} /></Field>
              <Field label="Название"><Input value={draft.title.ru} onChange={(e) => setDraft({ ...draft, title: { ...draft.title, ru: e.target.value } })} disabled={ro} /></Field>
              <Field label="Название (EN)"><Input value={draft.title.en || ''} onChange={(e) => setDraft({ ...draft, title: { ...draft.title, en: e.target.value } })} disabled={ro} /></Field>
              <Field label="Производитель"><Select value={draft.manufacturerId} onChange={(v) => setDraft({ ...draft, manufacturerId: v })} disabled={ro} options={catalog.manufacturers.map((m) => ({ value: m.id, label: m.name }))} /></Field>
              <Field label="Род"><Select value={draft.kind} onChange={(v) => setDraft({ ...draft, kind: v })} disabled={ro} options={(cls?.facts.find((f) => f.key === 'kind')?.values || []).map((k) => ({ value: k.code, label: textOf(k.label) }))} /></Field>
              <Field label="Статус сверки"><Select value={draft.status} onChange={(v) => setDraft({ ...draft, status: v as any })} disabled={ro} options={[{ value: 'full', label: 'сверено с каталогом' }, { value: 'partial', label: 'сверить' }, { value: 'draft', label: 'черновик' }]} /></Field>
              <Field label="Тип для бланка"><Input value={draft.typeLabel.ru} onChange={(e) => setDraft({ ...draft, typeLabel: { ...draft.typeLabel, ru: e.target.value } })} disabled={ro} /></Field>
              <Field label="Тип для бланка (EN)"><Input value={draft.typeLabel.en || ''} onChange={(e) => setDraft({ ...draft, typeLabel: { ...draft.typeLabel, en: e.target.value } })} disabled={ro} /></Field>
              <Field label="Сечения">
                <span className="flex gap-3 text-xs">
                  {(['rect', 'round'] as const).map((s) => (
                    <label key={s} className="inline-flex items-center gap-1 cursor-pointer">
                      <input type="checkbox" checked={draft.shapes.includes(s)} disabled={ro} onChange={(e) => setDraft({ ...draft, shapes: e.target.checked ? [...draft.shapes, s] : draft.shapes.filter((x) => x !== s) })} />
                      {s === 'rect' ? 'прямоугольное' : 'круглое'}
                    </label>
                  ))}
                </span>
              </Field>
              <Field label="Знак размера в обозначении"><Select value={draft.sizeSep || '*'} onChange={(v) => setDraft({ ...draft, sizeSep: v })} disabled={ro} options={[{ value: '*', label: '* (как в каталоге)' }, { value: 'х', label: 'х (как в бланках)' }, { value: 'x', label: 'x латинская' }]} /></Field>
            </div>
            <Field label="Описание"><Area rows={2} value={draft.description?.ru || ''} onChange={(e) => setDraft({ ...draft, description: { ...(draft.description || { ru: '' }), ru: e.target.value } })} disabled={ro} /></Field>
            <SectionTitle>Источник</SectionTitle>
            <div className="grid grid-cols-1 @[700px]:grid-cols-3 gap-2">
              <Field label="Файл каталога"><Input value={draft.catalog?.file || ''} onChange={(e) => setDraft({ ...draft, catalog: { ...(draft.catalog || { file: '' }), file: e.target.value } })} disabled={ro} /></Field>
              <Field label="Страницы"><Input value={draft.catalog?.pages || ''} onChange={(e) => setDraft({ ...draft, catalog: { ...(draft.catalog || { file: '' }), pages: e.target.value } })} disabled={ro} /></Field>
              <Field label="Редакция"><Input value={draft.catalog?.edition || ''} onChange={(e) => setDraft({ ...draft, catalog: { ...(draft.catalog || { file: '' }), edition: e.target.value } })} disabled={ro} /></Field>
            </div>
            <Field label="Что сверить со страницей каталога" hint="по строке на пункт; когда всё сверено — статус «сверено»">
              <Area rows={3} value={(draft.todo || []).join('\n')} onChange={(e) => setDraft({ ...draft, todo: e.target.value.split('\n').filter((s) => s.trim()) })} disabled={ro} />
            </Field>
            <SectionTitle>Эталонные обозначения</SectionTitle>
            <Area rows={4} value={(draft.examples || []).join('\n')} onChange={(e) => setDraft({ ...draft, examples: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} className="font-mono" disabled={ro} />
            <ul className="flex flex-col gap-0.5">
              {roundTrip.map((r) => (
                <li key={r.ex} className={`text-2xs flex items-start gap-1 ${r.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {r.ok ? <CircleCheck className="w-3 h-3 mt-0.5 shrink-0" /> : <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />}
                  <span className="font-mono break-all">{r.ex}</span>
                  {!r.ok && <span>— {r.stuck ? `встал на позиции «${r.stuck}»` : `собирается иначе: ${r.back}`}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {tab === 'positions' && <PositionsEditor family={draft} onChange={setDraft} readOnly={ro} />}
        {tab === 'params' && <ParamsEditor family={draft} onChange={setDraft} readOnly={ro} />}
        {tab === 'rules' && (
          <div className="flex flex-col gap-1.5">
            <div className="text-2xs text-slate-400">
              Условие (when) и действие (then) — JSON. Действия: {'{"allow":{"param":"type","values":["2*ф"]}}'}, {'{"forbid":…}'}, {'{"range":{"param":"W","min":100,"max":1400}}'}, {'{"require":{"param":"drive"}}'}, {'{"warn":"текст"}'}.
              Условия: {'{"param":"exec","in":["В"]}'}, {'{"fact":"ex","eq":true}'}, {'{"shape":"round"}'}, {'{"all":[…]}'}, {'{"any":[…]}'}, {'{"not":…}'}.
            </div>
            {draft.rules.map((r, i) => (
              <div key={i} className="rounded-lg border border-slate-200 dark:border-slate-700 p-2 flex flex-col gap-1">
                <div className="grid grid-cols-[minmax(0,1fr)_120px_auto] gap-1.5">
                  <Input value={r.message} onChange={(e) => setRule(i, { ...r, message: e.target.value })} disabled={ro} aria-label="Сообщение правила" />
                  <Input value={r.source || ''} placeholder="стр. 13" onChange={(e) => setRule(i, { ...r, source: e.target.value })} disabled={ro} aria-label="Источник" />
                  {!ro && <Btn tone="ghost" onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })} aria-label="Удалить правило"><Trash2 className="w-3 h-3" /></Btn>}
                </div>
                <div className="grid grid-cols-1 @[700px]:grid-cols-2 gap-1.5">
                  <Field label="Когда"><JsonField value={r.when} onChange={(when) => setRule(i, { ...r, when })} readOnly={ro} /></Field>
                  <Field label="Тогда"><JsonField value={r.then} onChange={(then) => then && setRule(i, { ...r, then })} readOnly={ro} /></Field>
                </div>
              </div>
            ))}
            {!ro && <div><Btn onClick={() => setDraft({ ...draft, rules: [...draft.rules, { id: `r${Date.now().toString(36)}`, message: 'Новое правило', then: { warn: 'Проверить' } }] })}><Plus className="w-3 h-3" /> Правило</Btn></div>}
          </div>
        )}
        {tab === 'specs' && (
          <div className="flex flex-col gap-1.5">
            <div className="text-2xs text-slate-400">Значения блока «Характеристики» бланка. Ключ — то, на что ссылается шаблон: {'{spec.pressure.value}'}. Варианты — значение в зависимости от кода (JSON: [{'{"when":{…},"value":{"ru":"…"}}'}]).</div>
            {draft.specs.map((s, i) => (
              <div key={i} className="rounded-lg border border-slate-200 dark:border-slate-700 p-2 grid grid-cols-1 @[800px]:grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)_60px_auto] gap-1.5">
                <Input value={s.key} onChange={(e) => setSpec(i, { ...s, key: e.target.value })} className="font-mono" disabled={ro} aria-label="Ключ" />
                <Input value={s.label.ru} onChange={(e) => setSpec(i, { ...s, label: { ...s.label, ru: e.target.value } })} disabled={ro} aria-label="Подпись" />
                <Input value={s.value.ru} onChange={(e) => setSpec(i, { ...s, value: { ...s.value, ru: e.target.value } })} disabled={ro} aria-label="Значение" />
                <Input value={s.unit || ''} onChange={(e) => setSpec(i, { ...s, unit: e.target.value })} disabled={ro} aria-label="Ед." />
                {!ro && <Btn tone="ghost" onClick={() => setDraft({ ...draft, specs: draft.specs.filter((_, j) => j !== i) })} aria-label="Удалить"><Trash2 className="w-3 h-3" /></Btn>}
                <div className="@[800px]:col-span-5"><JsonField value={s.cases || []} onChange={(cases) => setSpec(i, { ...s, cases: Array.isArray(cases) && cases.length ? cases : undefined })} readOnly={ro} rows={2} /></div>
              </div>
            ))}
            {!ro && <div><Btn onClick={() => setDraft({ ...draft, specs: [...draft.specs, { key: `spec${draft.specs.length + 1}`, label: { ru: 'Характеристика' }, value: { ru: '' } }] })}><Plus className="w-3 h-3" /> Характеристика</Btn></div>}
          </div>
        )}
        {tab === 'match' && (
          <div className="flex flex-col gap-2">
            <MatchEditor family={draft} cls={cls} onChange={setDraft} readOnly={ro} />
            <SectionTitle>Проверить на описании</SectionTitle>
            <Area rows={3} value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="Вставьте строку MTO — увидите, на каком месте окажется это семейство и почему" />
            {probeResult && (
              <div className="flex flex-col gap-1 text-xs">
                <div>{probeResult.mine ? <>Место <b>{probeResult.place}</b>, очки {probeResult.mine.score.toFixed(1)}{probeResult.mine.rejected ? ' — отброшено' : ''}</> : 'Семейство не участвует'}</div>
                <div className="flex flex-wrap gap-1">{probeResult.list.map((c) => <Chip key={c.familyId} tone={c.familyId === draft.id ? 'emerald' : 'slate'}>{catalog.families.find((f) => f.id === c.familyId)?.code} {c.score.toFixed(1)}</Chip>)}</div>
                {probeResult.mine && <div className="flex flex-wrap gap-1">{probeResult.mine.reasons.map((r, i) => <Chip key={i} tone={r.status === 'mismatch' ? 'rose' : r.status === 'unknown' ? 'slate' : 'emerald'}>{r.text}</Chip>)}</div>}
              </div>
            )}
          </div>
        )}
        {tab === 'try' && <Configurator family={draft} values={tryValues} onChange={setTryValues} />}
        {tab === 'history' && (
          <div className="flex flex-col gap-1">
            {!revs.length && <div className="text-xs text-slate-400">Правок ещё не было.</div>}
            {revs.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-xs">
                <History className="w-3.5 h-3.5 text-slate-400" />
                <span className="tabular-nums">{new Date(r.createdAt).toLocaleString('ru-RU')}</span>
                <Chip>{{ update: 'до правки', delete: 'до удаления', restore: 'до отката', seed: 'до сброса' }[r.action] || r.action}</Chip>
                <span className="flex-1" />
                {canEdit && <Btn tone="ghost" onClick={async () => { await catalogService.restore(r.id); await load(true); addToast('Семейство возвращено к снимку', 'success'); }}><RotateCcw className="w-3 h-3" /> вернуть</Btn>}
              </div>
            ))}
            {canEdit && edited && (
              <div className="mt-2">
                <Btn onClick={async () => {
                  if (!(await confirmAsk('Вернуть к затравке программы?', 'Все правки этого семейства будут заменены данными, с которыми пришла программа. Текущее состояние сохранится снимком.', { confirmLabel: 'Вернуть' }))) return;
                  try { await catalogService.reseed(draft.id); await load(true); addToast('Семейство возвращено к затравке', 'success'); } catch (e: any) { addToast(e?.message || 'Не вышло', 'error'); }
                }}><FileText className="w-3.5 h-3.5" /> Вернуть к затравке программы</Btn>
              </div>
            )}
          </div>
        )}
        {tab === 'json' && (
          <div className="flex flex-col gap-1">
            <Area rows={24} value={jsonText} onChange={(e) => { setJsonText(e.target.value); try { const f = JSON.parse(e.target.value); setJsonErr(''); if (f && f.id === draft.id) setDraft(f); else setJsonErr('id семейства менять нельзя'); } catch (err: any) { setJsonErr(err?.message || 'Не JSON'); } }}
              className="font-mono !text-2xs" disabled={ro} />
            {jsonErr && <span className="text-2xs text-rose-600 dark:text-rose-400">{jsonErr}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
