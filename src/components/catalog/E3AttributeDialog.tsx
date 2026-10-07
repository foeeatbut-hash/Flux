/**
 * Карточка одного атрибута E3: что Flux в него пишет и для каких типов.
 * Поля из файла (имя, носитель, скрипт) только читаются — их меняет загрузка
 * файла; здесь правятся настройки Flux. Читатель каталога видит те же поля
 * без права менять.
 */
import React, { useState } from 'react';
import { E3_CONFLICTS, E3_FIELD_KEYS, E3_FIELD_TITLES, type E3Attribute, type E3FieldKey, type E3Source } from '../../../e3/attributes';
import { CLASSES } from '../../../equipment/classes';
import type { E3ItemPatch } from '../../services/e3AttributesService';
import { Btn, Field, Input, Select } from './ui';
import { Dialog } from '../ui';
import { CONFLICT_TITLES, SOURCE_KINDS, defaultClassesText } from './e3AttributeText';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <><dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt><dd className="min-w-0 break-words">{children || '—'}</dd></>;
}

export default function E3AttributeDialog({ attr, canEdit, busy, error, onSave, onClose }: {
  attr: E3Attribute; canEdit: boolean; busy: boolean; error: string; onSave: (patch: E3ItemPatch) => void; onClose: () => void;
}) {
  const s = attr.source;
  const [fromFlux, setFromFlux] = useState(attr.fromFlux);
  const [kind, setKind] = useState<E3Source['kind']>(s.kind);
  const [fieldKey, setFieldKey] = useState<E3FieldKey>(s.kind === 'field' ? s.key : 'tag');
  const [paramName, setParamName] = useState(s.kind === 'param' ? s.name : '');
  const [paramUnit, setParamUnit] = useState(s.kind === 'param' ? s.unit || '' : '');
  const [constValue, setConstValue] = useState(s.kind === 'const' ? s.value : '');
  const [classes, setClasses] = useState<string[]>(attr.classes);
  const [byClass, setByClass] = useState(attr.classes.length === 0);
  const [conflict, setConflict] = useState(attr.conflict);

  const source: E3Source = kind === 'field' ? { kind, key: fieldKey }
    : kind === 'param' ? { kind, name: paramName.trim(), ...(paramUnit.trim() ? { unit: paramUnit.trim() } : {}) }
    : kind === 'const' ? { kind, value: constValue } : { kind: 'none' };
  const problem = kind === 'param' && !paramName.trim() ? 'Назовите характеристику — например «Мощность»' : '';
  const nextClasses = byClass ? [] : classes;
  const patch: E3ItemPatch = {};
  if (fromFlux !== attr.fromFlux) patch.fromFlux = fromFlux;
  if (!same(source, attr.source)) patch.source = source;
  if (!same(nextClasses, attr.classes)) patch.classes = nextClasses;
  if (conflict !== attr.conflict) patch.conflict = conflict;
  const dirty = Object.keys(patch).length > 0;
  const off = !canEdit || busy;

  const footer = canEdit
    ? <><Btn onClick={onClose} disabled={busy}>Отмена</Btn><Btn tone="primary" disabled={!dirty || !!problem || busy} onClick={() => onSave(patch)}>Сохранить</Btn></>
    : <Btn onClick={onClose}>Закрыть</Btn>;

  return (
    <Dialog title={<span className="font-mono">{attr.name}</span>} onClose={onClose} busy={busy} width="max-w-xl" scrollBody footer={footer} label={`Атрибут ${attr.name}`}>
      <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-sm">
        <Fact label="Описание">{attr.title}</Fact>
        <Fact label="Носитель">{attr.carrier}</Fact>
        <Fact label="Класс в файле">{attr.attrClass}</Fact>
        <Fact label="Служебный">{attr.service ? 'да — обычно его считает скрипт E3' : ''}</Fact>
        <Fact label="Скрипт">{attr.script}</Fact>
        <Fact label="Комментарий">{attr.comment}</Fact>
      </dl>

      <div className="mt-4 flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-emerald-600" checked={fromFlux} disabled={off} onChange={(e) => setFromFlux(e.target.checked)} />
          Заполняет Flux
          <span className="text-xs text-slate-500 dark:text-slate-400">без «Да» столбец в выгрузке пустой — его заполняют в Excel</span>
        </label>

        <Field label="Источник значения">
          <div className="flex flex-wrap gap-2">
            <Select value={kind} disabled={off} aria-label="Вид источника" className="w-auto" onChange={(v) => setKind(v as E3Source['kind'])} options={SOURCE_KINDS} />
            {kind === 'field' && <Select value={fieldKey} disabled={off} aria-label="Служебное поле" className="w-auto min-w-[180px] flex-1" onChange={(v) => setFieldKey(v as E3FieldKey)}
              options={E3_FIELD_KEYS.map((k) => ({ value: k, label: E3_FIELD_TITLES[k] }))} />}
            {kind === 'param' && <>
              <Input value={paramName} disabled={off} placeholder="Мощность" aria-label="Название характеристики" className="min-w-[160px] flex-1" onChange={(e) => setParamName(e.target.value)} />
              <Input value={paramUnit} disabled={off} placeholder="кВт" aria-label="Единица" className="w-24" onChange={(e) => setParamUnit(e.target.value)} />
            </>}
            {kind === 'const' && <Input value={constValue} disabled={off} placeholder="Значение для всех позиций" aria-label="Постоянное значение" className="min-w-[200px] flex-1" onChange={(e) => setConstValue(e.target.value)} />}
          </div>
          {problem && <span className="fx-error">{problem}</span>}
        </Field>

        <Field label="Типы Flux">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-emerald-600" checked={byClass} disabled={off} onChange={(e) => setByClass(e.target.checked)} />
            По классу из файла
            <span className="text-xs text-slate-500 dark:text-slate-400">сейчас: {defaultClassesText(attr.attrClass)}</span>
          </label>
          {!byClass && <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
            {CLASSES.map((c) => (
              <label key={c.id} className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" className="accent-emerald-600" checked={classes.includes(c.id)} disabled={off}
                  onChange={(e) => setClasses(e.target.checked ? [...classes, c.id] : classes.filter((x) => x !== c.id))} />
                <span className="truncate">{c.title}</span>
              </label>
            ))}
          </div>}
        </Field>

        <Field label="Если скрипт E3 пересчитал значение">
          <Select value={conflict} disabled={off} onChange={(v) => setConflict(v as typeof conflict)} options={E3_CONFLICTS.map((c) => ({ value: c, label: CONFLICT_TITLES[c] }))} />
        </Field>
      </div>
      {error && <p role="alert" className="fx-error mt-3">{error}</p>}
    </Dialog>
  );
}
