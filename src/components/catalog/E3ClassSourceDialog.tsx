/**
 * Источник значения атрибута для одного типа оборудования: как у атрибута
 * (общий) / характеристика / поле позиции / постоянное значение / нет.
 */
import React, { useMemo, useState } from 'react';
import { E3_FIELD_KEYS, E3_FIELD_TITLES, attributesForClass, sourceFor, type E3Attribute, type E3FieldKey, type E3Source } from '../../../e3/attributes';
import { classTitle } from '../../../equipment/classes';
import type { E3ItemPatch } from '../../services/e3AttributesService';
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

/**
 * Характеристики, известные для типа: те, что уже выбраны источником для
 * позиций этого типа у других атрибутов. Отдельного шаблона характеристик типа
 * в системе нет, поэтому список — подсказка (datalist), а не запрет.
 */
function knownParams(items: E3Attribute[], cls: string): { name: string; unit?: string }[] {
  const seen = new Map<string, { name: string; unit?: string }>();
  for (const a of attributesForClass(items, cls)) {
    const s = sourceFor(a, cls);
    if (s.kind === 'param' && !s.name.includes('|') && !seen.has(s.name)) seen.set(s.name, { name: s.name, ...(s.unit ? { unit: s.unit } : {}) });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export default function E3ClassSourceDialog({ attr, cls, items, canEdit, busy, error, onSave, onClose }: {
  attr: E3Attribute; cls: string; items: E3Attribute[]; canEdit: boolean; busy: boolean; error: string;
  onSave: (patch: E3ItemPatch) => void; onClose: () => void;
}) {
  const own = attr.sourceByClass?.[cls];
  const [kind, setKind] = useState<Kind>(own ? own.kind : 'inherit');
  const [fieldKey, setFieldKey] = useState<E3FieldKey>(own?.kind === 'field' ? own.key : 'tag');
  const [paramName, setParamName] = useState(own?.kind === 'param' ? own.name : '');
  const [paramUnit, setParamUnit] = useState(own?.kind === 'param' ? own.unit || '' : '');
  const [constValue, setConstValue] = useState(own?.kind === 'const' ? own.value : '');
  const known = useMemo(() => knownParams(items, cls), [items, cls]);

  const next: E3Source | null = kind === 'inherit' ? null
    : kind === 'field' ? { kind, key: fieldKey }
      : kind === 'param' ? { kind, name: paramName.trim(), ...(paramUnit.trim() ? { unit: paramUnit.trim() } : {}) }
        : kind === 'const' ? { kind, value: constValue } : { kind: 'none' };
  const problem = kind === 'param' && !paramName.trim() ? 'Назовите характеристику — например «Мощность»' : '';
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
  const listId = `e3-params-${attr.name}`;

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
              <Input value={paramName} list={listId} disabled={off} placeholder="Тип привода" aria-label="Название характеристики" className="min-w-[160px] flex-1"
                onChange={(e) => { const v = e.target.value; setParamName(v); const k = known.find((p) => p.name === v); if (k && !paramUnit) setParamUnit(k.unit || ''); }} />
              <datalist id={listId}>{known.map((p) => <option key={p.name} value={p.name} />)}</datalist>
              <Input value={paramUnit} disabled={off} placeholder="кВт" aria-label="Единица" className="w-24" onChange={(e) => setParamUnit(e.target.value)} />
            </>}
            {kind === 'const' && <Input value={constValue} disabled={off} placeholder="Значение для всех позиций типа" aria-label="Постоянное значение" className="min-w-[200px] flex-1" onChange={(e) => setConstValue(e.target.value)} />}
          </div>
          {problem && <span className="fx-error">{problem}</span>}
          {kind === 'param' && !known.length && <span className="fx-hint">Для этого типа характеристик пока не выбрано — впишите название, как в карточке позиции.</span>}
        </Field>
      </div>
      {error && <p role="alert" className="fx-error mt-3">{error}</p>}
    </Dialog>
  );
}
