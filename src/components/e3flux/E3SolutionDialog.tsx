/**
 * Карточка типового решения: поля из файла, ответы на признаки класса и
 * «подтверждено». Поля из файла после правки здесь помечают решение как
 * правленое — повторная загрузка файла их не перезапишет. Читатель каталога
 * видит те же поля без права менять. Без `solution` — добавление вручную:
 * признаки сервер предложит по названию, подтверждает человек. Ручной состав
 * блока (изделия по строкам таблицы IO) сильнее правил состава.
 */
import React, { useState } from 'react';
import { parseRecipeLines, recipeLinesText } from '../../../e3/recipe';
import type { E3Feature, E3Solution } from '../../../e3/solutionTypes';
import type { E3SolutionPatch } from '../../services/e3SolutionsService';
import { Area, Btn, Dialog, Field, Input, Select } from '../ui';
import { KIND_TITLES } from './e3SolutionText';

const TEXT_FIELDS: Array<[keyof E3Solution, string]> = [
  ['name', 'Название схемы'], ['subclass', 'Класс'], ['short', 'Краткое обозначение'], ['pdf', 'Ссылка на PDF'], ['e3p', 'Ссылка на .e3p'],
];
const AREA_FIELDS: Array<[keyof E3Solution, string]> = [['description', 'Описание'], ['items', 'Список изделий'], ['symbols', 'Список символов'], ['note', 'Пояснение']];

export default function E3SolutionDialog({ solution, classes, features, canEdit, busy, error, onSave, onClose }: {
  solution: E3Solution | null; classes: string[]; features: E3Feature[]; canEdit: boolean; busy: boolean; error: string;
  onSave: (patch: E3SolutionPatch, id: string) => void; onClose: () => void;
}) {
  const creating = !solution;
  const [id, setId] = useState(solution?.id || '');
  const [draft, setDraft] = useState<E3Solution>(solution || {
    id: '', mainClass: classes[0] || '', subclass: '', short: '', name: '', description: '', pdf: '', e3p: '', twoLevel: false, inCad: false,
    items: '', symbols: '', note: '', features: {}, featuresConfirmed: false,
  });
  const set = (p: Partial<E3Solution>) => setDraft((d) => ({ ...d, ...p }));
  const [recipeText, setRecipeText] = useState(recipeLinesText(solution?.recipeOverride));
  const recipe = parseRecipeLines(recipeText);
  const mine = features.filter((f) => f.mainClass === draft.mainClass);
  const off = !canEdit || busy;

  const patch: E3SolutionPatch = {};
  if (solution) {
    for (const [k] of [...TEXT_FIELDS, ...AREA_FIELDS, ['twoLevel', ''], ['inCad', ''], ['featuresConfirmed', '']] as Array<[keyof E3Solution, string]>) {
      if (draft[k] !== solution[k]) (patch as any)[k] = draft[k];
    }
    const changed = Object.fromEntries(Object.entries(draft.features).filter(([k, v]) => (solution.features[k] ?? '') !== v));
    if (Object.keys(changed).length) patch.features = changed;
    if (JSON.stringify(recipe.lines) !== JSON.stringify(solution.recipeOverride || [])) patch.recipeOverride = recipe.lines;
  }
  const problem = recipe.errors[0] || creating && (!id.trim() ? 'Укажите ID решения, например 08.01.39' : !draft.mainClass.trim() ? 'Укажите основной класс' : !draft.name.trim() ? 'Укажите название схемы' : '');
  const dirty = creating || Object.keys(patch).length > 0;
  // При добавлении уходят только поля файла: признаки предложит сервер, а «правлено» ставит он же
  const { mainClass, subclass, short, name, description, pdf, e3p, twoLevel, inCad, items, symbols, note } = draft;
  const save = () => onSave(creating ? { mainClass, subclass, short, name, description, pdf, e3p, twoLevel, inCad, items, symbols, note } : patch, id.trim());

  return (
    <Dialog title={creating ? 'Новое типовое решение' : <span className="font-mono">{solution.id}</span>} onClose={onClose} busy={busy} width="max-w-2xl" scrollBody
      label={creating ? 'Новое типовое решение' : `Типовое решение ${solution.id}`}
      footer={canEdit ? <>
        {!creating && <Btn tone="danger" className="mr-auto" disabled={busy} onClick={() => onSave({ removed: !solution.removed }, solution.id)}>{solution.removed ? 'Вернуть в каталог' : 'Снять с каталога'}</Btn>}
        <Btn onClick={onClose} disabled={busy}>Отмена</Btn>
        <Btn tone="primary" disabled={!dirty || !!problem || busy} title={problem || undefined} onClick={save}>Сохранить</Btn>
      </> : <Btn onClick={onClose}>Закрыть</Btn>}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-3">
        {creating && <Field label="ID решения"><Input value={id} onChange={(e) => setId(e.target.value)} placeholder="08.01.39" aria-label="ID решения" /></Field>}
        <Field label="Основной класс">
          {creating ? <Select value={draft.mainClass} onChange={(v) => set({ mainClass: v, features: {} })} aria-label="Основной класс" options={classes.map((c) => ({ value: c, label: c }))} />
            : <Input value={draft.mainClass} readOnly aria-label="Основной класс" title="Класс меняет загрузка файла" />}
        </Field>
        {TEXT_FIELDS.map(([k, label]) => (
          <Field key={k} label={label} className={k === 'name' ? 'col-span-2' : ''}>
            <Input value={String(draft[k] ?? '')} disabled={off} aria-label={label} onChange={(e) => set({ [k]: e.target.value } as any)} />
          </Field>
        ))}
        <Field label="Описание" className="col-span-2"><Area rows={2} value={draft.description} disabled={off} aria-label="Описание" onChange={(e) => set({ description: e.target.value })} /></Field>
        <details className="col-span-2" open={!!(draft.items || draft.symbols || draft.note)}>
          <summary className="cursor-pointer text-xs text-slate-500 dark:text-slate-400">Изделия, символы, пояснение</summary>
          <div className="mt-2 flex flex-col gap-3">
            {AREA_FIELDS.slice(1).map(([k, label]) => (
              <Field key={k} label={label}><Area rows={2} value={String(draft[k] ?? '')} disabled={off} aria-label={label} onChange={(e) => set({ [k]: e.target.value } as any)} /></Field>
            ))}
          </div>
        </details>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-emerald-600" checked={draft.twoLevel} disabled={off} onChange={(e) => set({ twoLevel: e.target.checked })} />Двухуровневая схема</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-emerald-600" checked={draft.inCad} disabled={off} onChange={(e) => set({ inCad: e.target.checked })} />Есть в САПР</label>
      </div>

      {!creating && <section className="mt-4">
        <div className="fx-label">Признаки · {mine.length}</div>
        {!mine.length ? <p className="text-xs text-slate-500 dark:text-slate-400">Для класса «{draft.mainClass}» признаков нет.</p> : (
          <div className="mt-1 grid grid-cols-[1fr_110px_1fr_110px] items-center gap-x-3 gap-y-1 text-sm">
            {mine.map((f) => (
              <React.Fragment key={f.id}>
                <span className="min-w-0 truncate" title={`${f.id} · ${KIND_TITLES[f.kind]}${f.hint ? ` · ${f.hint}` : ''}`}>{f.title}</span>
                <Select value={draft.features[f.id] ?? ''} disabled={off} aria-label={f.title} onChange={(v) => set({ features: { ...draft.features, [f.id]: v } })}
                  options={[{ value: '', label: 'не задан' }, ...f.values.map((v) => ({ value: v, label: v })), ...(draft.features[f.id] && !f.values.includes(draft.features[f.id]) ? [{ value: draft.features[f.id], label: draft.features[f.id] }] : [])]} />
              </React.Fragment>
            ))}
          </div>
        )}
        <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" className="accent-emerald-600" checked={draft.featuresConfirmed} disabled={off} onChange={(e) => set({ featuresConfirmed: e.target.checked })} />Признаки просмотрены и подтверждены</label>
      </section>}
      {!creating && <details className="mt-4" open={!!solution?.recipeOverride?.length}>
        <summary className="cursor-pointer text-xs text-slate-500 dark:text-slate-400">Состав блока вручную{solution?.recipeOverride?.length ? ` · ${solution.recipeOverride.length}` : ''}</summary>
        <Field label="По строке на изделие: роль | наименование или код:TS | число"
          hint="Пусто — состав считают правила таблицы IO. Заполнено — берётся только то, что записано здесь. Необязательно: | группа | подпозиция Flux">
          <Area rows={4} value={recipeText} disabled={off} aria-label="Состав блока вручную" className="font-mono" placeholder="Привод | пружинный, с бк | 2"
            onChange={(e) => setRecipeText(e.target.value)} />
        </Field>
      </details>}
      {creating && <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">Признаки Flux предложит по названию схемы — их можно будет просмотреть и подтвердить в карточке.</p>}
      {problem && <p className="fx-hint mt-3">{problem}</p>}
      {error && <p role="alert" className="fx-error mt-3">{error}</p>}
    </Dialog>
  );
}
