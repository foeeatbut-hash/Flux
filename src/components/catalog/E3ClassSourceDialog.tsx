/**
 * Источник значения атрибута для одного типа оборудования: как у атрибута
 * (общий) / характеристика / поле позиции / постоянное значение / нет.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { E3_FIELD_KEYS, E3_FIELD_TITLES, type E3Attribute, type E3FieldKey, type E3Source } from '../../../e3/attributes';
import { classTitle } from '../../../equipment/classes';
import { e3AttributesService, type E3ClassParam, type E3ItemPatch } from '../../services/e3AttributesService';
import { Btn, Field, Input, Select } from './ui';
import { Dialog } from '../ui';
import { sourceText } from './e3AttributeText';

type Kind = 'inherit' | E3Source['kind'];

const KINDS: Array<{ value: Kind; label: string }> = [
  { value: 'inherit', label: 'как у атрибута (общий)' },
  { value: 'param', label: 'характеристика' },
  { value: 'field', label: 'поле позиции' },
  { value: 'const', label: 'постоянное значение' },
  { value: 'none', label: 'нет (данные КИП)' },
];

export default function E3ClassSourceDialog({ attr, cls, canEdit, busy, error, onSave, onClose }: {
  attr: E3Attribute; cls: string; canEdit: boolean; busy: boolean; error: string;
  onSave: (patch: E3ItemPatch) => void; onClose: () => void;
}) {
  const own = attr.sourceByClass?.[cls];
  const [kind, setKind] = useState<Kind>(own ? own.kind : 'inherit');
  const [fieldKey, setFieldKey] = useState<E3FieldKey>(own?.kind === 'field' ? own.key : 'tag');
  const [paramName, setParamName] = useState(own?.kind === 'param' ? own.name : '');
  const [paramUnit, setParamUnit] = useState(own?.kind === 'param' ? own.unit || '' : '');
  const [constValue, setConstValue] = useState(own?.kind === 'const' ? own.value : '');
  const [params, setParams] = useState<E3ClassParam[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  // Список — характеристики позиций программы «Оборудование» этого типа во всех проектах
  useEffect(() => {
    let alive = true;
    e3AttributesService.classParams(cls).then((r) => { if (alive) setParams(r.params); }).catch((e) => { if (alive) setLoadError(e.message); });
    return () => { alive = false; };
  }, [cls]);
  const current = params?.find((p) => p.key === paramName || p.name === paramName);
  const options = useMemo(() => {
    const low = search.trim().toLocaleLowerCase('ru');
    const list = (params || []).filter((p) => !low || p.key.toLocaleLowerCase('ru').includes(low));
    // Уже заданный источник, которого у позиций нет, остаётся видимым и выбранным — иначе диалог молча подменил бы его
    const missing = paramName && params && !current ? [{ value: paramName, label: `${paramName} — нет у позиций этого типа` }] : [];
    return [{ value: '', label: params ? (list.length ? 'выберите характеристику' : 'ничего не найдено') : 'загружаю…' }, ...missing,
      ...list.map((p) => ({ value: p.key, label: `${p.group} · ${p.name} (у ${p.count})` }))];
  }, [params, search, paramName, current]);

  const next: E3Source | null = kind === 'inherit' ? null
    : kind === 'field' ? { kind, key: fieldKey }
      : kind === 'param' ? { kind, name: paramName.trim(), ...(paramUnit.trim() ? { unit: paramUnit.trim() } : {}) }
        : kind === 'const' ? { kind, value: constValue } : { kind: 'none' };
  const problem = kind === 'param' && !paramName.trim() ? 'Выберите характеристику из списка' : '';
  const dirty = JSON.stringify(next) !== JSON.stringify(own ?? null);
  const off = !canEdit || busy;

  const save = () => {
    // Карта уходит целиком: сервер заменяет её, пустая карта возвращает атрибут к общему источнику
    const map = { ...(attr.sourceByClass || {}) };
    if (next) map[cls] = next; else delete map[cls];
    onSave({ sourceByClass: map });
  };
  const footer = canEdit
    ? <><Btn onClick={onClose} disabled={busy}>Отмена</Btn><Btn tone="primary" disabled={!dirty || !!problem || busy} onClick={save}>Сохранить</Btn></>
    : <Btn onClick={onClose}>Закрыть</Btn>;

  return (
    <Dialog title={<span><span className="font-mono">{attr.name}</span> · {classTitle(cls)}</span>} onClose={onClose} busy={busy} width="max-w-xl" scrollBody footer={footer} label={`Источник ${attr.name} для типа ${classTitle(cls)}`}>
      <p className="text-sm text-slate-500 dark:text-slate-400">{attr.title || '—'}. Общий источник атрибута: {sourceText(attr.source) || 'не задан'}.</p>
      <div className="mt-3 flex flex-col gap-3">
        <Field label="Откуда для этого типа">
          <div className="flex flex-wrap gap-2">
            <Select value={kind} disabled={off} aria-label="Вид источника" className="w-auto" onChange={(v) => setKind(v as Kind)} options={KINDS} />
            {kind === 'field' && <Select value={fieldKey} disabled={off} aria-label="Служебное поле" className="w-auto min-w-[180px] flex-1" onChange={(v) => setFieldKey(v as E3FieldKey)}
              options={E3_FIELD_KEYS.map((k) => ({ value: k, label: E3_FIELD_TITLES[k] }))} />}
            {kind === 'param' && <>
              <Input value={search} disabled={off} placeholder="Поиск характеристики" aria-label="Поиск характеристики" className="w-44" onChange={(e) => setSearch(e.target.value)} />
              <Select value={paramName} disabled={off || !params} aria-label="Характеристика" className="min-w-[220px] flex-1"
                onChange={(v) => { setParamName(v); const k = params?.find((p) => p.key === v); if (k) setParamUnit(k.units[0]?.unit || ''); }} options={options} />
              {(current?.units.length || 0) > 1
                ? <Select value={paramUnit} disabled={off} aria-label="Единица" className="w-28" onChange={setParamUnit} options={current!.units.map((u) => ({ value: u.unit, label: u.unit || 'без единицы' }))} />
                : <Input value={paramUnit} disabled aria-label="Единица" className="w-24" readOnly />}
            </>}
            {kind === 'const' && <Input value={constValue} disabled={off} placeholder="Значение для всех позиций типа" aria-label="Постоянное значение" className="min-w-[200px] flex-1" onChange={(e) => setConstValue(e.target.value)} />}
          </div>
          {problem && <span className="fx-error">{problem}</span>}
          {kind === 'param' && loadError && <span className="fx-error">{loadError}</span>}
          {kind === 'param' && params && !params.length && <span className="fx-hint">У позиций этого типа в «Оборудовании» характеристик нет.</span>}
        </Field>
      </div>
      {error && <p role="alert" className="fx-error mt-3">{error}</p>}
    </Dialog>
  );
}
