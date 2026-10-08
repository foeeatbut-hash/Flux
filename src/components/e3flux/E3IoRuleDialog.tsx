/**
 * Правило состава блока: «если решение класса X отвечает на признаки так, в
 * блоке стоит изделие по этой строке таблицы IO столько-то раз». Строка
 * находится по группе, части наименования и обозначению — не по номеру, чтобы
 * правило пережило перестановку строк в файле владельца.
 */
import React, { useState } from 'react';
import type { E3Feature, E3IoCount, E3IoRule } from '../../../e3/solutionTypes';
import { Area, Btn, Dialog, Field, Input, Select } from '../ui';
import { condsToText, parseConds } from './e3IoText';

type CountKind = E3IoCount['kind'];
const COUNT_KINDS: Array<{ value: CountKind; label: string }> = [
  { value: 'one', label: 'одно изделие' }, { value: 'feature', label: 'число из признака решения' }, { value: 'children', label: 'число подпозиций Flux' },
];

export default function E3IoRuleDialog({ rule, classes, features, groups, canEdit, busy, error, onSave, onDelete, onClose }: {
  rule: E3IoRule | null; classes: string[]; features: E3Feature[]; groups: string[]; canEdit: boolean; busy: boolean; error: string;
  onSave: (r: E3IoRule) => void; onDelete: () => void; onClose: () => void;
}) {
  const creating = !rule;
  const [id, setId] = useState(rule?.id || '');
  const [title, setTitle] = useState(rule?.title || '');
  const [mainClass, setMainClass] = useState(rule?.mainClass || classes[0] || '');
  const [role, setRole] = useState(rule?.role || '');
  const [conds, setConds] = useState(condsToText(rule?.when || []));
  const [group, setGroup] = useState(rule?.row.group || '');
  const [name, setName] = useState(rule?.row.name || '');
  const [code, setCode] = useState(rule?.row.code || '');
  const c0 = rule?.count;
  const [kind, setKind] = useState<CountKind>(c0?.kind || 'one');
  const [feature, setFeature] = useState(c0?.kind === 'feature' ? c0.feature : '');
  const [offset, setOffset] = useState(c0?.kind === 'feature' && c0.offset ? String(c0.offset) : '');
  const [cap, setCap] = useState(c0?.kind === 'feature' && c0.cap !== undefined ? String(c0.cap) : '');
  const [childRole, setChildRole] = useState(c0?.kind === 'children' ? c0.role : '');
  const [fromRole, setFromRole] = useState(rule?.fromRole || '');
  const off = !canEdit || busy;

  const mine = features.filter((f) => f.mainClass === mainClass);
  const parsed = parseConds(conds);
  const count: E3IoCount = kind === 'one' ? { kind } : kind === 'children' ? { kind, role: childRole.trim() }
    : { kind, feature, ...(Number(offset) ? { offset: Number(offset) } : {}), ...(cap.trim() !== '' ? { cap: Number(cap) } : {}) };
  const ref = { ...(group.trim() ? { group: group.trim() } : {}), ...(name.trim() ? { name: name.trim() } : {}), ...(code.trim() ? { code: code.trim() } : {}) };
  const next: E3IoRule = { id: id.trim(), title: title.trim(), mainClass, when: parsed.conds, role: role.trim(), row: ref, count, ...(fromRole.trim() ? { fromRole: fromRole.trim() } : {}) };
  const dirty = creating || JSON.stringify(next) !== JSON.stringify(rule);
  const problem = !/^[\w.\-]{1,60}$/.test(next.id) ? 'Ключ правила — латиницей, цифрами, точкой и дефисом, например valve.spring' : !next.title ? 'Назовите правило'
    : !mainClass ? 'Выберите основной класс' : !next.role ? 'Укажите роль изделия в блоке — например «Привод»' : !Object.keys(ref).length ? 'Укажите, какую строку таблицы IO брать: группу, часть наименования или обозначение'
      : parsed.errors[0] || (kind === 'feature' && !feature ? 'Выберите признак, из которого берётся число' : kind === 'children' && !childRole.trim() ? 'Укажите роль подпозиции Flux — например «ПРИВОД»' : '')
        || (Number.isNaN(Number(offset)) || (cap.trim() !== '' && !Number.isInteger(Number(cap))) ? 'Сдвиг и предел — целые числа' : '');

  return (
    <Dialog title={creating ? 'Новое правило состава' : rule.title} onClose={onClose} busy={busy} width="max-w-2xl" scrollBody label={creating ? 'Новое правило состава' : `Правило состава: ${rule.title}`}
      footer={canEdit ? <>
        {!creating && <Btn tone="danger" className="mr-auto" disabled={busy} onClick={onDelete}>Удалить правило</Btn>}
        <Btn onClick={onClose} disabled={busy}>Отмена</Btn>
        <Btn tone="primary" disabled={!dirty || !!problem || busy} title={problem || undefined} onClick={() => onSave(next)}>Сохранить</Btn>
      </> : <Btn onClick={onClose}>Закрыть</Btn>}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-3">
        <Field label="Название" className="col-span-2"><Input value={title} disabled={off} onChange={(e) => setTitle(e.target.value)} placeholder="Клапан с пружинным приводом" aria-label="Название" /></Field>
        <Field label="Основной класс решения">
          {creating ? <Select value={mainClass} onChange={setMainClass} aria-label="Основной класс" options={classes.map((c) => ({ value: c, label: c }))} /> : <Input value={mainClass} disabled aria-label="Основной класс" />}
        </Field>
        <Field label="Ключ" hint={creating ? 'Латиницей; потом не меняется' : undefined}>
          <Input value={id} disabled={!creating || busy} onChange={(e) => setId(e.target.value)} placeholder="valve.spring" aria-label="Ключ правила" className="font-mono" />
        </Field>
        <Field label="Условия" hint={`По строке: «признак = значение / значение» или «признак != значение». Пусто — всегда.${mine.length ? ` Признаки класса: ${mine.map((f) => f.id).join(', ')}` : ''}`} className="col-span-2">
          <Area rows={3} value={conds} disabled={off} onChange={(e) => setConds(e.target.value)} aria-label="Условия" className="font-mono" />
        </Field>

        <Field label="Роль изделия в блоке"><Input value={role} disabled={off} onChange={(e) => setRole(e.target.value)} placeholder="Привод" aria-label="Роль изделия" /></Field>
        <Field label="Подпозиция Flux" hint="Какой подпозиции отвечает изделие: ПРИВОД, ДВИГАТЕЛЬ…"><Input value={fromRole} disabled={off} onChange={(e) => setFromRole(e.target.value)} placeholder="ПРИВОД" aria-label="Подпозиция Flux" /></Field>

        <div className="col-span-2">
          <div className="fx-label">Строка таблицы IO</div>
          <div className="mt-1 grid grid-cols-3 gap-3">
            <Input value={group} list="e3io-rule-groups" disabled={off} onChange={(e) => setGroup(e.target.value)} placeholder="группа: Приводы" aria-label="Группа" />
            <Input value={name} disabled={off} onChange={(e) => setName(e.target.value)} placeholder="часть наименования" aria-label="Часть наименования" />
            <Input value={code} disabled={off} onChange={(e) => setCode(e.target.value)} placeholder="обозначение: TS" aria-label="Обозначение" className="font-mono" />
          </div>
          <datalist id="e3io-rule-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </div>

        <Field label="Сколько изделий" className="col-span-2"><Select value={kind} onChange={(v) => setKind(v as CountKind)} disabled={off} aria-label="Сколько изделий" options={COUNT_KINDS} /></Field>
        {kind === 'feature' && <>
          <Field label="Признак с числом" className="col-span-2">
            <Select value={feature} onChange={setFeature} disabled={off} aria-label="Признак с числом" options={[{ value: '', label: 'выберите' }, ...mine.map((f) => ({ value: f.id, label: `${f.title} (${f.id})` })), ...(feature && !mine.some((f) => f.id === feature) ? [{ value: feature, label: feature }] : [])]} />
          </Field>
          <Field label="Сдвиг" hint="−1: «остальные ступени»"><Input value={offset} disabled={off} onChange={(e) => setOffset(e.target.value)} placeholder="0" aria-label="Сдвиг" className="tabular-nums" /></Field>
          <Field label="Не больше" hint="1: «только первая»"><Input value={cap} disabled={off} onChange={(e) => setCap(e.target.value)} placeholder="без предела" aria-label="Не больше" className="tabular-nums" /></Field>
        </>}
        {kind === 'children' && <Field label="Роль подпозиции" className="col-span-2"><Input value={childRole} disabled={off} onChange={(e) => setChildRole(e.target.value)} placeholder="ПРИВОД" aria-label="Роль подпозиции" /></Field>}
      </div>
      {problem && <p className="fx-hint mt-3">{problem}</p>}
      {error && <p role="alert" className="fx-error mt-3">{error}</p>}
    </Dialog>
  );
}
